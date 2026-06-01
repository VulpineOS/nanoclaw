import { execSync } from 'child_process';
import * as fs from 'fs';
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
        viewportOnly: { type: 'boolean', description: 'Only return elements visible in the current viewport (default: true). Saves tokens by omitting off-screen content. Disable for full-page analysis.' },
        profile: { type: 'string', enum: ['compact', 'expanded', 'full'], description: 'Snapshot detail profile. compact: 180 nodes/90 chars per node (default). expanded: 360/160. full: 800/240.' },
        maxNodes: { type: 'number', description: 'Maximum number of DOM nodes to return (overrides profile default). Lower values save tokens.' },
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
              stream: true,
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

          const streamReader = res.body.getReader();
          const streamDecoder = new TextDecoder();
          let streamBuffer = '';
          let streamContent = '';
          let streamToolCalls: ChatMessage['tool_calls'] = [];
          let streamToolCallAccum: Map<number, { id?: string; name?: string; args?: string }> = new Map();
          const MAX_STREAM_FILE_SIZE = 256 * 1024;
          let streamFileSize = 0;
          const streamPath = process.env.STREAM_PATH || '/workspace/stream.jsonl';
          let streamFd: number | null = null;
          try { streamFd = fs.openSync(streamPath, 'w'); } catch (_) {}

          process.on('exit', () => {
            try { fs.unlinkSync(streamPath); } catch (_) {}
          });

          function stripMessageTags(text: string): string {
            return text
              .replace(/<message\s+[^>]*>/g, '')
              .replace(/<\/message>/g, '')
              .replace(/<internal>[\s\S]*?<\/internal>/g, '')
              .trim();
          }

          const streamByteLength = (s: string): number => {
            return new TextEncoder().encode(s).length;
          };
          function streamWriteSync(data: string) {
            if (streamFd === null) return;
            const line = data + '\n';
            if (streamFileSize + streamByteLength(line) > MAX_STREAM_FILE_SIZE) {
              try { fs.ftruncateSync(streamFd, 0); fs.closeSync(streamFd); } catch (_) {}
              streamFd = null;
              return;
            }
            try {
              fs.writeSync(streamFd, line);
              fs.fsyncSync(streamFd);
              streamFileSize += streamByteLength(line);
            } catch (_) {}
          }

          readLoop: while (true) {
            const { done, value } = await streamReader.read();
            if (done) break;
            streamBuffer += streamDecoder.decode(value, { stream: true });
            const lines = streamBuffer.split('\n');
            streamBuffer = lines.pop() || '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;
              const dataStr = trimmed.slice(6);
              if (dataStr === '[DONE]') break readLoop;
              try {
                const parsed = JSON.parse(dataStr);
                const choice = parsed.choices?.[0];
                if (!choice) continue;
                const delta = choice.delta || {};
                if (delta.content) {
                  streamContent += delta.content;
                }
                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index || 0;
                    if (!streamToolCallAccum.has(idx)) streamToolCallAccum.set(idx, {});
                    const acc = streamToolCallAccum.get(idx)!;
                    if (tc.id) acc.id = tc.id;
                    if (tc.function?.name) acc.name = tc.function.name;
                    if (tc.function?.arguments) acc.args = (acc.args || '') + tc.function.arguments;
                  }
                }
              } catch (_) {}
            }
          }

          // Reconstruct tool_calls from accumulated SSE chunks
          for (const [idx, acc] of streamToolCallAccum) {
            if (acc.id && acc.name) {
              streamToolCalls.push({
                id: acc.id,
                type: 'function',
                function: { name: acc.name, arguments: acc.args || '{}' },
              });
            }
          }

          // Write done marker with full accumulated text
          if (streamContent) {
            streamWriteSync(JSON.stringify({ done: stripMessageTags(streamContent) }));
          }
          if (streamFd !== null) { try { fs.closeSync(streamFd); } catch (_) {} }

          // Build response object compatible with the rest of the tool-call loop
          response = {
            choices: [{
              finish_reason: streamToolCalls.length > 0 ? 'tool_calls' : 'stop',
              message: {
                role: 'assistant' as const,
                content: streamContent || null,
                ...(streamToolCalls.length > 0 ? { tool_calls: streamToolCalls } : {}),
              },
            }],
          } as unknown as { choices?: Array<{ finish_reason: string; message: ChatMessage & { tool_calls?: ChatMessage['tool_calls'] } }> };
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

        // Build tool info map for structured compression
        const toolInfo = new Map<string, { name: string; url?: string; command?: string }>();
        for (const tc of message.tool_calls) {
          if (tc.type !== 'function') continue;
          try {
            const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            toolInfo.set(tc.id, {
              name: tc.function.name,
              url: typeof args.url === 'string' ? args.url : undefined,
              command: typeof args.command === 'string' ? args.command : undefined,
            });
          } catch {}
        }

        for (const tc of message.tool_calls) {
          if (tc.type !== 'function') continue;

          let result: string;
          try {
            const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            if (tc.function.name === 'bash') {
              const command = String(args.command ?? '');
              const FORBIDDEN = /\b(playwright|puppeteer|selenium)\b/i;
              if (FORBIDDEN.test(command)) {
                result = 'Error: This command contains a reference to a forbidden browser automation tool (Playwright, Puppeteer, or Selenium). These tools are NOT available in this container. Use agent-browser for all browser interaction.';
              } else {
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
              }
            } else if (tc.function.name === 'web') {
              const url = String(args.url ?? '');
              const viewportOnly = args.viewportOnly !== false;
              const profile = String(args.profile || 'compact');
              try {
                const cdpUrl = process.env.AGENT_BROWSER_CDP || process.env.AGENT_BROWSER_CDP_URL;
                const flags = [];
                if (viewportOnly) flags.push('--viewport-only');
                if (profile) flags.push('--profile ' + profile);
                if (typeof args.maxNodes === 'number' && args.maxNodes > 0) flags.push('--max-nodes ' + args.maxNodes);
                const flagStr = flags.length > 0 ? ' ' + flags.join(' ') : '';
                const cmd = 'agent-browser connect ' + cdpUrl + ' && agent-browser open ' + JSON.stringify(url) + ' && agent-browser wait --load networkidle && agent-browser snapshot -i' + flagStr;
                result = execSync(cmd, {
                  cwd: '/workspace/agent',
                  timeout: 60000,
                  encoding: 'utf-8',
                  maxBuffer: 50 * 1024 * 1024,
                  signal: controller.signal,
                });
              } catch (_err) {
                // Retry without flags if CLI rejected them
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
                } catch (_retryErr) {
                  const errMsg = _retryErr instanceof Error ? _retryErr.message : String(_retryErr);
                  result = 'agent-browser failed: ' + errMsg;
                }
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

        // Compress older tool results -- keep last 2 full, use structured summaries for older ones
        let recentToolResults = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'tool') {
            recentToolResults++;
            if (recentToolResults > 2 && messages[i].content.length > 2000) {
              const info = toolInfo.get(messages[i].tool_call_id ?? '');
              const tag = info?.name || 'tool';
              const detail = info?.url || info?.command || '';
              messages[i].content = `[${tag}] ${detail} -- returned ${messages[i].content.length} bytes -- full content already processed above`;
            }
          }
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
