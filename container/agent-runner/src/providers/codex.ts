import { execSync } from 'child_process';
import * as fs from 'fs';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

const CODEX_API = 'https://chatgpt.com/backend-api/codex/responses';

type ResponsesInputItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: string; status?: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

const WEB_TOOL = {
  type: 'function' as const,
  name: 'web',
  description:
    'Fetch a web page using the Camoufox browser via CDP. Uses agent-browser internally. This is the primary way to access specific web pages (wget and curl are blocked by the network proxy). If the web tool fails (e.g. agent-browser error, connection refused, or page not found), try using the search tool to find the correct URL or relevant information instead.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
    },
    required: ['url'],
  },
};

const BASH_TOOL = {
  type: 'function' as const,
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
};

const SEARCH_TOOL = {
  type: 'function' as const,
  name: 'search',
  description:
    'Search the web for information using DuckDuckGo. Returns search result titles, URLs, and snippets. Use this when you need to find a website, look up information, or when the web tool fails to access a URL directly. Use specific search terms for best results.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
    },
    required: ['query'],
  },
};

function providerToken(): string | undefined {
  return process.env.OPENAI_ACCESS_TOKEN;
}

function normalizeCodexModel(model: string | undefined): string {
  const raw = (model || process.env.OPENCODE_MODEL || '').replace(/^openai\//, '');
  // Codex API uses model names like gpt-5.5, gpt-5.4 — no -codex suffix.
  // Only pass through known Codex model names; default to gpt-5.5 for OAuth.
  switch (raw) {
    case 'gpt-5.5':
    case 'gpt-5.4':
      return raw;
  }
  return 'gpt-5.5';
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

class CodexProvider implements AgentProvider {
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
    const token = providerToken();
    if (!token) {
      yield {
        type: 'error',
        message: 'OPENAI_ACCESS_TOKEN not configured. Run: vulpine auth login --provider openai',
        retryable: false,
      };
      return;
    }

    // Build history from input context
    type HistoryEntry =
      | { role: 'assistant'; text: string }
      | { role: 'function_call'; call_id: string; name: string; arguments: string }
      | { role: 'tool'; call_id: string; text: string };
    const history: HistoryEntry[] = [];
    const contextLines = (input.systemContext?.contextText || '').split('\n').filter(Boolean);
    for (const line of contextLines) {
      const colon = line.indexOf(':');
      if (colon > 0) {
        const key = line.slice(0, colon);
        const val = line.slice(colon + 1);
        if (key === 'assistant') history.push({ role: 'assistant', text: val });
        else if (key === 'tool') {
          const pipe = val.indexOf('|');
          if (pipe > 0) {
            history.push({ role: 'tool', call_id: val.slice(0, pipe), text: val.slice(pipe + 1) });
          }
        }
      }
    }

    const instructions = input.systemContext?.instructions || 'You are a helpful assistant.';

    yield { type: 'init', continuation: `codex-${Date.now()}` };

    while (true) {
      yield { type: 'activity' };

      const model = normalizeCodexModel(this.options.model);

      if (controller.signal.aborted) {
        yield { type: 'error', message: 'Request aborted', retryable: false };
        return;
      }

      // Build Responses API input array from history + current message + followups
      const responseInput: ResponsesInputItem[] = [];

      for (const entry of history) {
        if (entry.role === 'assistant') {
          responseInput.push({
            type: 'message',
            role: 'assistant',
            content: entry.text,
            status: 'completed',
          });
        } else if (entry.role === 'function_call') {
          responseInput.push({
            type: 'function_call',
            call_id: entry.call_id,
            name: entry.name,
            arguments: entry.arguments,
          });
        } else if (entry.role === 'tool') {
          responseInput.push({
            type: 'function_call_output',
            call_id: entry.call_id,
            output: entry.text,
          });
        }
      }

      // Current user message + any followups
      responseInput.push({
        type: 'message',
        role: 'user',
        content: input.prompt,
      });

      for (const msg of followups.drain()) {
        responseInput.push({
          type: 'message',
          role: 'user',
          content: msg,
        });
      }

      try {
        const res = await fetch(CODEX_API, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'OpenAI-Beta': 'responses=v1',
          },
          body: JSON.stringify({
            model,
            instructions,
            input: responseInput,
            tools: [BASH_TOOL, WEB_TOOL, SEARCH_TOOL],
            tool_choice: 'auto',
            store: false,
            stream: true,
          }),
        });

        yield { type: 'activity' };

        if (!res.ok) {
          const body = await res.text();
          yield {
            type: 'error',
            message: `Codex API returned ${res.status}: ${body}`,
            retryable: res.status >= 500,
          };
          return;
        }

        if (!res.body) {
          yield { type: 'error', message: 'Empty response body', retryable: false };
          return;
        }

        // SSE stream — Responses API format
        const streamPath = process.env.STREAM_PATH || '/workspace/stream.jsonl';
        let streamFd: number | null = null;
        try { streamFd = fs.openSync(streamPath, 'w'); } catch (_) {}

        process.on('exit', () => {
          try { fs.unlinkSync(streamPath); } catch (_) {}
        });

        const MAX_STREAM_FILE_SIZE = 256 * 1024;
        let streamFileSize = 0;
        const streamByteLength = (s: string): number => new TextEncoder().encode(s).length;
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

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let content = '';
        let toolName = '';
        let toolArgs = '';
        let toolCallId = '';
        let hasToolCall = false;

        while (true) {
          if (controller.signal.aborted) {
            reader.cancel();
            yield { type: 'error', message: 'Request aborted', retryable: false };
            return;
          }

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() || '';

          for (const chunk of chunks) {
            const lines = chunk.split('\n');
            let eventType = '';
            let jsonData = '';

            for (const line of lines) {
              if (line.startsWith('event: ')) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                jsonData = line.slice(6).trim();
              }
            }

            if (!jsonData) continue;

            try {
              const parsed = JSON.parse(jsonData) as Record<string, unknown>;
              const type = (parsed.type as string) || '';

              if (type === 'response.output_text.delta') {
                const delta = parsed.delta as string || '';
                content += delta;
                streamWriteSync(JSON.stringify({ t: delta }));
                yield { type: 'activity' };
              } else if (type === 'response.function_call_arguments.delta') {
                const delta = parsed.delta as string || '';
                toolArgs += delta;
                if (!toolCallId) {
                  toolCallId = parsed.call_id as string || '';
                  toolName = parsed.name as string || '';
                }
                hasToolCall = true;
                yield { type: 'activity' };
              } else if (type === 'response.output_item.added') {
                const item = parsed.item as Record<string, unknown> | undefined;
                if (item?.type === 'function_call') {
                  toolCallId = item.call_id as string || '';
                  toolName = item.name as string || '';
                  toolArgs = (item.arguments as string) || '';
                  hasToolCall = true;
                }
              } else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.done') {
                // Response done
              }
            } catch {
              // skip malformed SSE
            }
          }
        }

        // Write done marker after SSE stream ends
        if (content) {
          streamWriteSync(JSON.stringify({ done: content }));
        }
        if (streamFd !== null) { try { fs.closeSync(streamFd); } catch (_) {} }

        // Process results
        if (hasToolCall && toolName) {
          history.push({ role: 'assistant', text: content || '' });

          const tcCallId = toolCallId || `call_${Date.now()}`;
          history.push({ role: 'function_call', call_id: tcCallId, name: toolName, arguments: toolArgs });
          let result: string;
          try {
            const args = JSON.parse(toolArgs || '{}') as Record<string, unknown>;
            if (toolName === 'bash') {
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
            } else if (toolName === 'web') {
              const url = String(args.url ?? '');
              try {
                const cdpUrl = process.env.AGENT_BROWSER_CDP || process.env.AGENT_BROWSER_CDP_URL;
                const cmd = 'agent-browser connect ' + cdpUrl + ' && agent-browser open ' + JSON.stringify(url) + ' && agent-browser wait --load networkidle && agent-browser snapshot -c';
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
            } else if (toolName === 'search') {
              const query = String(args.query ?? '');
              try {
                const cdpUrl = process.env.AGENT_BROWSER_CDP || process.env.AGENT_BROWSER_CDP_URL;
                const searchUrl = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query);
                const cmd = 'agent-browser connect ' + cdpUrl + ' && agent-browser open ' + JSON.stringify(searchUrl) + ' && agent-browser wait --load networkidle && agent-browser snapshot -c';
                result = execSync(cmd, {
                  cwd: '/workspace/agent',
                  timeout: 60000,
                  encoding: 'utf-8',
                  maxBuffer: 50 * 1024 * 1024,
                  signal: controller.signal,
                });
              } catch (_err) {
                const errMsg = _err instanceof Error ? _err.message : String(_err);
                result = 'Search failed: ' + errMsg;
              }
              if (result.length > 50000) {
                result = result.slice(0, 50000) + '\n... [truncated ' + (result.length - 50000) + ' more bytes]';
              }
            } else {
              result = `Unknown tool: ${toolName}`;
            }
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }

          history.push({ role: 'tool', call_id: tcCallId, text: result });
          yield { type: 'activity' };
          continue;
        }

        // Text response — no tool calls
        yield { type: 'result', text: content || null };
        return;
      } catch (err) {
        if (err instanceof Error && (err.name === 'AbortError' || controller.signal.aborted)) {
          yield { type: 'error', message: 'Request aborted', retryable: false };
          return;
        }
        yield {
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        };
        return;
      }
    }
  }
}

registerProvider('codex', options => new CodexProvider(options));
