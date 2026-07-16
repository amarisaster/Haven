import test from 'node:test';
import assert from 'node:assert/strict';

import { invocation as bridgeInvocation } from './bridge.mjs';
import {
  BridgeDaemon,
  eventEnvelope,
  validateRevertPaths,
} from './daemon.mjs';
import { invocation as streamInvocation } from './stream-codex.mjs';

class FakeWebSocket {
  static OPEN = 1;
}

const config = {
  havenUrl: 'https://haven.example/',
  connectorToken: 'test-token',
  workspace: process.platform === 'win32' ? 'C:\\work\\sandbox' : '/work/sandbox',
  codexBin: process.platform === 'win32' ? 'C:\\tools\\codex.exe' : '/tools/codex',
  timeoutMs: 300_000,
};

function daemonHarness(overrides = {}) {
  const sent = [];
  const daemon = new BridgeDaemon({
    config,
    WebSocketImpl: FakeWebSocket,
    logger: () => {},
    ...overrides,
  });
  daemon.socket = {
    readyState: FakeWebSocket.OPEN,
    send: (text) => sent.push(JSON.parse(text)),
  };
  return { daemon, sent };
}

test('revert rejects path traversal without invoking git', async () => {
  let gitCalls = 0;
  const { daemon, sent } = daemonHarness({
    runGit: () => {
      gitCalls += 1;
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  await daemon.handleEnvelope({
    type: 'run',
    requestId: 'traversal',
    payload: { mode: 'revert', paths: ['../outside.txt'] },
  });

  assert.equal(gitCalls, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.kind, 'error');
  assert.match(sent[0].payload.data.message, /escapes CODEX_WORKSPACE/u);
  assert.throws(() => validateRevertPaths(config.workspace, ['..\\outside.txt']), /escapes CODEX_WORKSPACE/u);
});

test('a concurrent run receives busy while the active run continues', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { daemon, sent } = daemonHarness({
    stream: async () => {
      await blocked;
      return { ok: true, errors: [] };
    },
  });

  const first = daemon.handleEnvelope({
    type: 'run', requestId: 'first', payload: { prompt: 'hold' },
  });
  await daemon.handleEnvelope({
    type: 'run', requestId: 'second', payload: { prompt: 'overlap' },
  });

  assert.deepEqual(sent, [eventEnvelope('second', {
    kind: 'error', data: { message: 'busy' },
  })]);
  release();
  await first;
});

test('fake stream events map to relay envelopes without spawning Codex', async () => {
  let receivedOptions;
  const { daemon, sent } = daemonHarness({
    stream: async (options) => {
      receivedOptions = options;
      await options.onEvent({ kind: 'message', data: { text: 'working' } });
      await options.onEvent({
        kind: 'file_change', data: { path: 'src/a.ts', changeType: 'update' },
      });
      await options.onEvent({ kind: 'done', data: { ok: true } });
      return { ok: true, errors: [] };
    },
  });

  await daemon.handleEnvelope({
    type: 'run',
    requestId: 'mapped',
    payload: {
      systemPrompt: 'You are the companion.',
      prompt: 'Make the change.',
      gear: 'code',
    },
  });

  assert.ok(receivedOptions.prompt.startsWith('You are the companion.\n\nMake the change.'));
  assert.ok(receivedOptions.prompt.includes('[Engine note:'));
  assert.equal(receivedOptions.cwd, config.workspace);
  assert.equal(receivedOptions.sandbox, 'workspace-write');
  assert.equal(receivedOptions.timeoutMs, 300_000);
  assert.deepEqual(sent, [
    eventEnvelope('mapped', { kind: 'message', data: { text: 'working' } }),
    eventEnvelope('mapped', {
      kind: 'file_change', data: { path: 'src/a.ts', changeType: 'update' },
    }),
    eventEnvelope('mapped', { kind: 'done', data: { ok: true } }),
  ]);
});

test('CODEX_BIN override is honored by both invocation helpers', () => {
  const previous = process.env.CODEX_BIN;
  const configured = process.platform === 'win32'
    ? 'C:\\Users\\mai\\AppData\\Roaming\\npm\\codex.cmd'
    : '/opt/codex/bin/codex';
  process.env.CODEX_BIN = configured;

  try {
    for (const invoke of [bridgeInvocation, streamInvocation]) {
      const target = invoke(['exec', '--json']);
      if (process.platform === 'win32') {
        assert.equal(target.command, 'powershell.exe');
        assert.equal(target.args[3], '-File');
        assert.equal(target.args[4], configured.replace(/\.cmd$/iu, '.ps1'));
        assert.deepEqual(target.args.slice(5), ['exec', '--json']);
      } else {
        assert.equal(target.command, configured);
        assert.deepEqual(target.args, ['exec', '--json']);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  }
});
