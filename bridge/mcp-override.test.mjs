import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpOverride } from './daemon.mjs';

test('empty/missing server list still returns a replacing override', () => {
  for (const input of [undefined, null, [], 'nope']) {
    const { configArg, env } = buildMcpOverride(input);
    assert.equal(configArg, 'mcp_servers={  }');
    assert.deepEqual(env, {});
  }
});

test('url-only server becomes a bare entry, no env', () => {
  const { configArg, env } = buildMcpOverride([{ name: 'nexus', url: 'https://gw.example/mcp?k=abc' }]);
  assert.equal(configArg, 'mcp_servers={ "nexus" = { url = "https://gw.example/mcp?k=abc" } }');
  assert.deepEqual(env, {});
});

test('api_key travels as env var, never in the config arg', () => {
  const { configArg, env } = buildMcpOverride([{ name: 'haven tools', url: 'https://t.example/mcp', api_key: 'sekret' }]);
  assert.ok(configArg.includes('"haven_tools" = { url = "https://t.example/mcp", bearer_token_env_var = "CODEX_MCP_BEARER_0" }'));
  assert.ok(!configArg.includes('sekret'));
  assert.deepEqual(env, { CODEX_MCP_BEARER_0: 'sekret' });
});

test('invalid urls are dropped, names sanitized, multiple servers joined', () => {
  const { configArg, env } = buildMcpOverride([
    { name: 'bad', url: 'file:///etc/passwd' },
    { name: 'ok.one!', url: 'https://a.example/mcp' },
    { name: '', url: 'http://b.example/mcp', api_key: 'k2' },
  ]);
  assert.ok(!configArg.includes('passwd'));
  assert.ok(configArg.includes('"ok_one_" = { url = "https://a.example/mcp" }'));
  assert.ok(configArg.includes('bearer_token_env_var = "CODEX_MCP_BEARER_1"'));
  assert.deepEqual(env, { CODEX_MCP_BEARER_1: 'k2' });
});

test('deriveWorkspace: no companion → root; named companion → sanitized subfolder; traversal impossible', async () => {
  const { deriveWorkspace } = await import('./daemon.mjs');
  const { resolve } = await import('node:path');
  const root = resolve('ws-root');
  assert.equal(deriveWorkspace(root, undefined, 'Kai'), root);
  assert.equal(deriveWorkspace(root, null, 'Kai'), root);
  const kai = deriveWorkspace(root, 3, 'Kai Stryder');
  assert.ok(kai.endsWith('Kai_Stryder-3'));
  assert.ok(kai.startsWith(root));
  const evil = deriveWorkspace(root, '../../etc', '../..');
  assert.ok(evil.startsWith(root));
  assert.ok(!evil.includes('..'));
});
