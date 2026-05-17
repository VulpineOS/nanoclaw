import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ChannelAdapter, InboundEvent } from './adapter.js';

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

describe('CLI channel', () => {
  it('delivers routed replies to the routed socket platform', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-cli-route-'));
    fs.mkdirSync(path.join(tmpDir, 'data'));
    cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const previousCwd = process.cwd();
    process.chdir(tmpDir);
    cleanup.push(() => process.chdir(previousCwd));

    const { createCliAdapterForTest } = await import('./cli.js');
    const adapter: ChannelAdapter = createCliAdapterForTest();
    cleanup.push(() => adapter.teardown());

    let inboundEvent: InboundEvent | null = null;
    await adapter.setup({
      onInbound() {},
      onInboundEvent(event) {
        inboundEvent = event;
      },
      onMetadata() {},
      onAction() {},
    });

    const socket = net.createConnection(path.join(tmpDir, 'data', 'cli.sock'));
    cleanup.push(() => {
      socket.destroy();
    });
    await once(socket, 'connect');

    const received = onceData(socket);
    socket.write(
      JSON.stringify({
        text: 'hello',
        to: { channelType: 'cli', platformId: 'vulpine:agent-1', threadId: null },
        reply_to: { channelType: 'cli', platformId: 'vulpine:agent-1', threadId: null },
      }) + '\n',
    );

    await eventually(() => {
      expect(inboundEvent?.platformId).toBe('vulpine:agent-1');
      expect(inboundEvent?.replyTo?.platformId).toBe('vulpine:agent-1');
    });

    await adapter.deliver('vulpine:agent-1', null, { kind: 'chat', content: { text: 'reply' } });

    await expect(received).resolves.toEqual({ text: 'reply' });
  });
});

function once(socket: net.Socket, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once(event, () => resolve());
    socket.once('error', reject);
  });
}

function onceData(socket: net.Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once('data', (chunk) => {
      try {
        resolve(JSON.parse(chunk.toString('utf8').trim()));
      } catch (err) {
        reject(err);
      }
    });
    socket.once('error', reject);
  });
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}
