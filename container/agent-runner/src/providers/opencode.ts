import { execSync } from 'child_process';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

const DEFAULT_FALLBACK_MODELS = [
  'openai/gpt-oss-20b:free',
  'google/gemini-2.0-flash-exp:free',
  'mistralai/mistral-nemo:free',
];

const WEB_TOOL = {
  type: 'function' as const,
  function: {
    name: 'web',
    description:
      'Fetch a web page using the Camoufox browser via CDP. Uses agent-browser internally. This is the ONLY way to access the web \u2014 wget and curl are blocked by the network proxy.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
      },
      required: ['url'],
    },
  },
};

const BASH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'bash',
    description:
      'Execute a bash command in the workspace. For file operations, system commands, and running agent-browser for web scraping. Do NOT use wget or curl \u2014 they are blocked by the network proxy. For web access, use the web tool instead.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
      },
      required: ['command'],
    },
  },
};

function fallbackModels(): string[] {
  const env = process.env.OPENCODE_FALLBACK_MODELS;
  if (env) {
    return env.split(',').map(s => s.trim()).filter(Boolean);
  }
  return DEFAULT_FALLBACK_MODELS;
}

function normalizeOpenRouterModel(model: string | undefined): string {
  const value = model || process.env.OPENCODE_MODEL || 'openai/gpt-oss-20b:free';
  return value.replace(/^openrouter\//, '');
}

function providerName(): string {
  return process.env.OPENCODE_PROVIDER || 'openrouter';
}

function providerAPIKey(): string | undefined {
  return process.env.OPENCODE_API_KEY || process.env.OPENROUTER_API_KEY;
}

class MessageStream {
  private queue: string[] = [];
  private _done = false;

  push(text: string): void {
    this.queue.push(text);
  }

  end(): void {
    this._done = true;
  }

  drain(): string[] {
    const items = this.queue;
    this.queue = [];
    return items;
  }

  get done(): boolean {
    return this._done;
  }
}

class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  constructor(private readonly options: ProviderOptions = {}) {}

  isSessionInvalid(): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const controller = new AbortController();
    const stream = new MessageStream();
    return {
      push: msg => stream.push(msg),
      end: () => stream.end(),
      events: this.run(input, controller, stream),
      abort: () => controller.abort(),
    };
  }

  private async *run(
    input: QueryInput,
    controller: AbortController,
    followups: MessageStream,
  ): AsyncGenerator<ProviderEvent> {
    if (providerName() !== 'openrouter') {
      yield {
        type: 'error',
        message: `Unsupported OPENCODE_PROVIDER ${providerName()}; only openrouter available`,
        retryable: false,
      };
      return;
    }
    const apiKey = providerAPIKey();
    if (!apiKey) {
      yield {
        type: 'error',
        message: 'OPENCODE_API_KEY or OPENROUTER_API_KEY not configured',
        retryable: false,
      };
      return;
    }

    const messages: ChatMessage[] = [];
    if (input.systemContext?.instructions) {
      messages.push({ role: 'system', content: input.systemContext.instructions });
    }
    messages.push({ role: 'user', content: input.prompt });

    yield { type: 'init', continuation: `opencode-${Date.now()}` };

    const primaryModel = normalizeOpenRouterModel(this.options.model);
    const models = [primaryModel, ...fallbackModels().filter(m => m !== primaryModel)];
    let usedModelIndex = 0;

    while (true) {
      yield { type: 'activity' };

      // Drain follow-up messages pushed by poll-loop
      for (const msg of followups.drain()) {
        messages.push({ role: 'user', content: msg });
        yield { type: 'activity' };
      }

      let response: unknown;
      let modelFound = false;

      for (let i = usedModelIndex; i < models.length; i++) {
        const model = models[i];
        if (controller.signal.aborted) {
          yield { type: 'error', message: 'Request aborted', retryable: false };
          return;
        }

        try {
          const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://vulpineos.com',
              'X-Title': 'VulpineOS',
            },
            body: JSON.stringify({
              model,
              messages,
              tools: [BASH_TOOL, WEB_TOOL],
              tool_choice: 'auto',
            }),
          });

          yield { type: 'activity' };

          if (!res.ok) {
            const body = await res.text();
            if (res.status === 429 && i < models.length - 1) {
              continue;
            }
            yield {
              type: 'error',
              message: `OpenRouter returned ${res.status}: ${body}`,
              retryable: res.status >= 500 || res.status === 429,
            };
            return;
          }

          response = (await res.json()) as {
            choices?: Array<{
              finish_reason: string;
              message: ChatMessage & { tool_calls?: ChatMessage['tool_calls'] };
            }>;
          };
          usedModelIndex = i;
          modelFound = true;
          break;
        } catch (err) {
          if (err instanceof Error && (err.name === 'AbortError' || controller.signal.aborted)) {
            yield { type: 'error', message: 'Request aborted', retryable: false };
            return;
          }
          if (i < models.length - 1) continue;
          yield {
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
          };
          return;
        }
      }

      if (!modelFound) return;

      const choices = (response as { choices?: Array<{ finish_reason: string; message: ChatMessage & { tool_calls?: ChatMessage['tool_calls'] } }> }).choices;
      const choice = choices?.[0];
      if (!choice) {
        yield { type: 'error', message: 'Empty response from OpenRouter', retryable: false };
        return;
      }

      const message = choice.message;

      // Tool calls: execute each one, append results, loop
      if (choice.finish_reason === 'tool_calls' && message.tool_calls?.length) {
        messages.push({
          role: 'assistant',
          content: message.content || null,
          tool_calls: message.tool_calls,
        });

        for (const tc of message.tool_calls) {
          if (tc.type !== 'function') continue;

          let result: string;
          try {
            const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            if (tc.function.name === 'bash') {
              const command = String(args.command ?? '');
              const timeout = typeof args.timeout === 'number' ? args.timeout : 30000;
              result = execSync(command, {
                cwd: '/workspace/agent',
                timeout,
                encoding: 'utf-8',
                maxBuffer: 50 * 1024 * 1024,
                signal: controller.signal,
              });
              if (result.length > 50000) {
                result = result.slice(0, 50000) + `\n... [truncated ${result.length - 50000} more bytes]`;
              }
            } else if (tc.function.name === 'web') {
              const url = String(args.url ?? '');
              try {
                const cdpUrl = process.env.AGENT_BROWSER_CDP || process.env.AGENT_BROWSER_CDP_URL;
                const cmd = 'agent-browser connect ' + cdpUrl + ' && agent-browser open ' + JSON.stringify(url) + ' && agent-browser wait --load networkidle && agent-browser snapshot -i';
                result = execSync(cmd, {
                  cwd: '/workspace/agent',
                  timeout: 60000,
                  encoding: 'utf-8',
                  maxBuffer: 50 * 1024 * 1024,
                  signal: controller.signal,
                });
              } catch (_err) {
                const errMsg = _err instanceof Error ? _err.message : String(_err);
                result = 'agent-browser failed: ' + errMsg;
              }
              if (result.length > 50000) {
                result = result.slice(0, 50000) + '\n... [truncated ' + (result.length - 50000) + ' more bytes]';
              }
            } else {
              result = `Unknown tool: ${tc.function.name}`;
            }
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }

          messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
          yield { type: 'activity' };
        }

        continue;
      }

      // Text response
      let text = message.content || '';
      if (usedModelIndex > 0) {
        text = `[Switched to ${models[usedModelIndex]}]\n\n${text}`;
      }
      yield { type: 'result', text };
      return;
    }
  }
}

registerProvider('opencode', options => new OpenCodeProvider(options));
