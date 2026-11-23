'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createCipheriv, createDecipheriv } = require('node:crypto');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { reconcile } = require('../reconcile.cjs');

const providerId = 'magpie-oleafly';
const stateFile = '.magpie-oleafly-state.json';
const model = { id: 'fixture/first', baseURL: 'http://127.0.0.1:49876/v1', apiKey: 'magpie-oleafly-fixture-token' };
const tools = { provider: 'acp:claude', model: 'default', label: 'CLI override' };
const local = { id: 'existing', name: 'Existing', baseURL: 'http://127.0.0.1:49980/v1', keyOptional: true };
const existingServer = { name: 'existing', transport: 'stdio', command: '/usr/bin/true' };
const original = {
  ai_provider: 'existing', ai_model: 'existing-model', ai_custom_providers: [local],
  ai_provider_models: { existing: [{ id: 'existing-model', name: 'Existing Model' }] },
  ai_tools_model: tools, mcp_servers: [existingServer], unknown_setting: { keep: true },
};
const mcp = { name: 'magpie', transport: 'remote', url: 'http://127.0.0.1:49876/mcp/magpie/hub/oleafly', headers: { Authorization: 'Bearer upstream-fixture-secret' } };

function fixture(t, initial = original) {
  const dataDir = fs.mkdtempSync(join(tmpdir(), 'oleafly-reconcile-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const path = name => join(dataDir, name);
  const exists = name => fs.existsSync(path(name));
  const read = (name = 'config.json') => JSON.parse(fs.readFileSync(path(name), 'utf8'));
  const write = (value, name = 'config.json') => fs.writeFileSync(path(name), JSON.stringify(value));
  if (initial) write(initial);
  const apply = options => reconcile({ dataDir, ...options });
  return { dataDir, path, exists, read, write, apply };
}

function secrets(f, name) {
  if (!f.exists(name)) return {};
  const key = fs.readFileSync(f.path('ai-secrets.key'));
  const { version, nonce, ciphertext } = f.read(name);
  assert.equal(version, 1);
  const bytes = Buffer.from(ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]));
}

function writeSecrets(f, name, payload) {
  if (!f.exists('ai-secrets.key')) fs.writeFileSync(f.path('ai-secrets.key'), Buffer.alloc(32, 7), { mode: 0o600 });
  const key = fs.readFileSync(f.path('ai-secrets.key'));
  const nonce = Buffer.alloc(12, 8);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]);
  f.write({ version: 1, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64') }, name);
}

test('installation leaves config alone and the synchronous reader honors OLEAFLY_DATA_DIR', t => {
  const f = fixture(t, null);
  const envelope = JSON.stringify({ model });
  const run = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { reconcile } = require(process.argv[1]);
    assert.deepEqual(reconcile({ readDesired: () => ({}) }), { changed: false, conflicts: [] });
    assert.equal(require('node:fs').existsSync(require('node:path').join(process.env.OLEAFLY_DATA_DIR, 'config.json')), false);
    const result = reconcile({ readDesired: () => JSON.parse(process.argv[2]) });
    assert.equal(result.changed, true);
  `, require.resolve('../reconcile.cjs'), envelope], { env: { ...process.env, OLEAFLY_DATA_DIR: f.dataDir }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(f.read().ai_model, model.id);
});

test('connect, switch to a routing group, repeat, and restore only the model configuration', t => {
  const f = fixture(t);
  writeSecrets(f, 'ai-secrets.json', { existing: 'existing-key' });
  assert.deepEqual(f.apply({ model, mcp: [mcp] }), { changed: true, conflicts: [] });
  const cfg = f.read();
  assert.deepEqual(cfg.ai_custom_providers, [local, {
    id: providerId, name: 'Magpie', baseURL: model.baseURL, keyOptional: false, reasoningEffort: false,
  }]);
  assert.equal(cfg.ai_provider, providerId);
  assert.equal(cfg.ai_model, model.id);
  assert.equal(cfg.ai_provider_models[providerId][0].id, model.id);
  assert.deepEqual(cfg.ai_tools_model, tools);
  assert.deepEqual(secrets(f, 'ai-secrets.json'), { existing: 'existing-key', [providerId]: model.apiKey });

  const group = { ...model, id: 'routing/group-A', baseURL: 'http://127.0.0.1:55119/v1' };
  assert.equal(f.apply({ model: group }).changed, true);
  const switched = f.read();
  assert.equal(switched.ai_model, group.id);
  assert.equal(switched.ai_custom_providers.filter(provider => provider.id === providerId).length, 1);
  assert.equal(switched.ai_custom_providers.at(-1).baseURL, group.baseURL);
  assert.deepEqual(switched.ai_tools_model, tools);
  assert.deepEqual(f.apply({ model: group, mcp: [mcp] }), { changed: false, conflicts: [] });
  assert.deepEqual(f.read(), switched);

  assert.deepEqual(f.apply({ model: null }), { changed: true, conflicts: [] });
  assert.deepEqual(f.read(), { ...original, mcp_servers: switched.mcp_servers });
  assert.deepEqual(secrets(f, 'ai-secrets.json'), { existing: 'existing-key' });
  assert.deepEqual(f.apply({ model: null, mcp: [] }), { changed: true, conflicts: [] });
  assert.deepEqual(f.read(), original);
  assert.equal(f.exists(stateFile), false);
  assert.deepEqual(f.apply({ model: null, mcp: [] }), { changed: false, conflicts: [] });
});

test('reset uses native chat defaults when the previous custom provider was deleted', t => {
  const f = fixture(t);
  f.apply({ model });
  const cfg = f.read();
  cfg.ai_custom_providers = cfg.ai_custom_providers.filter(p => p.id !== local.id);
  f.write(cfg);
  const result = f.apply({ model: null });
  assert.deepEqual(result.conflicts.map(({ id, reason }) => [id, reason]), [['chat', 'missing-provider']]);
  const after = f.read();
  assert.equal(after.ai_provider, undefined);
  assert.equal(after.ai_model, undefined);
  assert.deepEqual(after.ai_custom_providers, []);
  assert.deepEqual(after.ai_provider_models, original.ai_provider_models);
  assert.deepEqual(after.ai_tools_model, tools);
  assert.deepEqual(f.apply({ model: null }), { changed: false, conflicts: [] });
});

test('reset restores implicit, built-in and ACP selections without a custom provider record', t => {
  for (const selection of [{}, { ai_provider: '', ai_model: '' }, { ai_provider: 'zai', ai_model: 'saved' },
    { ai_provider: 'acp:claude', ai_model: 'default' }]) {
    const f = fixture(t, selection);
    f.apply({ model });
    assert.deepEqual(f.apply({ model: null }), { changed: true, conflicts: [] });
    const { ai_custom_providers, ai_provider_models, ...restored } = f.read();
    assert.deepEqual(restored, selection);
  }
});

test('config writes preserve exact native integers, including the maximum u64 revision', t => {
  const f = fixture(t, null);
  fs.writeFileSync(f.path('config.json'), '{"cli_settings_revision":18446744073709551615,' +
    '"ai_model_lists_refreshed_at":{"openai":9007199254740993},"extra":[-9223372036854775807,"9007199254740993"]}');
  for (const desired of [{ model }, { mcp: [mcp] }, { model: null, mcp: [] }]) {
    assert.equal(f.apply(desired).changed, true);
    const raw = fs.readFileSync(f.path('config.json'), 'utf8');
    assert.match(raw, /"cli_settings_revision":\s*18446744073709551615\b/);
    assert.match(raw, /"openai":\s*9007199254740993\b/);
    assert.match(raw, /\[\s*-9223372036854775807,\s*"9007199254740993"\s*\]/);
  }
});

test('stores MCP headers and env in Oleafly envelopes and survives Oleafly reissuing a marker', t => {
  const f = fixture(t);
  const stdio = { name: 'direct', transport: 'stdio', command: '/usr/bin/true', args: ['two words'], env: { TOKEN: 'stdio-secret', EMPTY: '' } };
  const foreignRef = `__stored__:v1:${'f'.repeat(64)}`;
  f.write({ ...original, mcp_servers: [{ ...existingServer, env: { SENSITIVE: foreignRef } }] });
  writeSecrets(f, 'mcp-server-secrets.json', { [foreignRef]: 'unrelated-secret' });
  assert.equal(f.apply({ mcp: [mcp, stdio] }).changed, true);
  const cfg = f.read();
  const ref = cfg.mcp_servers[1].headers.Authorization;
  const token = cfg.mcp_servers[2].env.TOKEN;
  assert.match(ref, /^__stored__:v1:[0-9a-f]{64}$/);
  assert.match(token, /^__stored__:v1:[0-9a-f]{64}$/);
  assert.equal(cfg.mcp_servers[2].env.EMPTY, '');
  assert.deepEqual(secrets(f, 'mcp-server-secrets.json'), {
    [ref]: mcp.headers.Authorization, [token]: 'stdio-secret', [foreignRef]: 'unrelated-secret',
  });
  for (const name of ['config.json', stateFile, 'mcp-server-secrets.json']) {
    const bytes = fs.readFileSync(f.path(name), 'utf8');
    assert.doesNotMatch(bytes, /upstream-fixture-secret|stdio-secret|unrelated-secret/);
    assert.equal(fs.statSync(f.path(name)).mode & 0o777, 0o600);
  }

  const rotated = `__stored__:v1:${'a'.repeat(64)}`;
  cfg.mcp_servers[1].headers.Authorization = rotated;
  f.write(cfg);
  writeSecrets(f, 'mcp-server-secrets.json', { [rotated]: mcp.headers.Authorization, [token]: 'stdio-secret', [foreignRef]: 'unrelated-secret' });
  assert.deepEqual(f.apply({ mcp: [mcp, stdio] }), { changed: false, conflicts: [] });

  const nextMcp = { ...mcp, headers: { Authorization: 'Bearer changed-secret' } };
  assert.equal(f.apply({ mcp: [nextMcp] }).changed, true);
  assert.deepEqual(f.read().mcp_servers.map(server => server.name), ['existing', 'magpie']);
  const nextRef = f.read().mcp_servers[1].headers.Authorization;
  assert.deepEqual(secrets(f, 'mcp-server-secrets.json'), { [nextRef]: nextMcp.headers.Authorization, [foreignRef]: 'unrelated-secret' });
  assert.equal(f.apply({ mcp: [] }).changed, true);
  assert.deepEqual(secrets(f, 'mcp-server-secrets.json'), { [foreignRef]: 'unrelated-secret' });
});

test('same-ID provider and same-name MCP collisions never establish ownership', t => {
  const f = fixture(t, { ...original,
    ai_custom_providers: [local, { ...local, id: providerId }],
    mcp_servers: [existingServer, mcp],
  });
  const before = f.read();
  const result = f.apply({ model, mcp: [mcp] });
  assert.equal(result.changed, false);
  assert.deepEqual(result.conflicts.map(({ kind, id, reason }) => [kind, id, reason]), [
    ['model', providerId, 'collision'], ['mcp', mcp.name, 'collision'],
  ]);
  assert.equal(f.exists(stateFile), false);
  assert.deepEqual(f.apply({ model: null, mcp: [] }), { changed: false, conflicts: [] });
  assert.deepEqual(f.read(), before);
});

test('disconnect keeps concurrent selections and edited MCP entries and cleans other owned entries', t => {
  const f = fixture(t);
  f.apply({ model, mcp: [mcp, { name: 'remove-me', transport: 'stdio', command: '/usr/bin/true' }] });
  const cfg = f.read();
  const newProvider = { ...local, id: 'new-provider' };
  cfg.ai_custom_providers.push(newProvider);
  cfg.ai_provider = newProvider.id;
  cfg.ai_model = 'my-new-model';
  cfg.mcp_servers[0].args = ['my-unrelated-edit'];
  cfg.mcp_servers[1].enabled = false;
  f.write(cfg);

  const result = f.apply({ model: null, mcp: [] });
  assert.equal(result.changed, true);
  assert.deepEqual(result.conflicts.map(({ kind, id, reason }) => [kind, id, reason]), [
    ['model', 'chat', 'edited'], ['mcp', 'magpie', 'edited'],
  ]);
  const after = f.read();
  assert.deepEqual(after.ai_custom_providers, [local, newProvider]);
  assert.deepEqual([after.ai_provider, after.ai_model], [newProvider.id, 'my-new-model']);
  assert.deepEqual(after.mcp_servers, cfg.mcp_servers.slice(0, 2));
  assert.equal(f.apply({ model: null, mcp: [] }).changed, false);
  assert.deepEqual(f.apply({ mcp: [mcp] }).conflicts.map(c => c.reason), ['edited']);
  assert.equal(f.read().mcp_servers[1].enabled, false);
});

test('a full assignment withdrawing an edited direct server disables only that server and can resume it', t => {
  const f = fixture(t);
  const direct = { ...mcp, name: 'direct' };
  f.apply({ mcp: [direct] });
  const cfg = f.read();
  const live = cfg.mcp_servers[1];
  delete live.enabled; // Native default is enabled.
  live.url += '/local';
  f.write(cfg);
  const encrypted = fs.readFileSync(f.path('mcp-server-secrets.json'));
  assert.deepEqual(f.apply({}), { changed: false, conflicts: [] });
  assert.throws(() => f.apply({ mcp: [existingServer, {}] }), /invalid name or transport/);
  assert.deepEqual(f.read(), cfg);

  const policy = { mcp: [existingServer] }; // The full desired set withholds the direct server.
  const first = f.apply(policy);
  assert.equal(first.changed, true);
  assert.deepEqual(first.conflicts.map(({ id, reason }) => [id, reason]), [['direct', 'edited'], ['existing', 'collision']]);
  assert.match(first.conflicts[0].message, /disabled/);
  assert.deepEqual(f.read().mcp_servers, [existingServer, { ...live, enabled: false }]);
  assert.deepEqual(fs.readFileSync(f.path('mcp-server-secrets.json')), encrypted);
  assert.deepEqual(f.apply(policy), { changed: false, conflicts: first.conflicts });
  assert.equal(f.apply({ mcp: [direct] }).conflicts[0].reason, 'edited');
  const reassigned = { mcp: [{ ...direct, url: live.url }] };
  assert.deepEqual(f.apply(reassigned), { changed: true, conflicts: [] });
  assert.deepEqual(f.read().mcp_servers, [existingServer, { ...live, enabled: true }]);
  assert.deepEqual(f.apply(reassigned), { changed: false, conflicts: [] });
});

test('withdrawal recovers after config replacement and a renamed local copy frees the assignment name', t => {
  const f = fixture(t);
  f.apply({ mcp: [mcp] });
  const cfg = f.read();
  cfg.mcp_servers[1].url += '/local';
  f.write(cfg);
  interrupted(f, { mcp: [] }, 'after');
  const retry = f.apply({ mcp: [] });
  assert.equal(retry.changed, false);
  assert.deepEqual(retry.conflicts.map(c => c.reason), ['edited']);
  const disabled = f.read();
  assert.equal(disabled.mcp_servers[1].enabled, false);
  disabled.mcp_servers[1].name = 'local-copy';
  f.write(disabled);
  assert.deepEqual(f.apply({ mcp: [mcp] }), { changed: true, conflicts: [] });
  assert.deepEqual(f.read().mcp_servers.slice(0, 2), disabled.mcp_servers);
  assert.equal(f.read().mcp_servers[2].enabled, true);
});

test('duplicate live names are ambiguous on withdrawal', t => {
  const f = fixture(t);
  f.apply({ mcp: [mcp] });
  const cfg = f.read();
  cfg.mcp_servers.push({ ...existingServer, name: mcp.name });
  f.write(cfg);
  const result = f.apply({ mcp: [] });
  assert.equal(result.changed, false);
  assert.deepEqual(result.conflicts.map(c => c.reason), ['collision']);
  assert.deepEqual(f.read(), cfg);
});

test('a local server replacing a withdrawn copy never inherits its ownership', t => {
  const f = fixture(t);
  f.apply({ mcp: [mcp] });
  const cfg = f.read();
  cfg.mcp_servers[1].url += '/local';
  f.write(cfg);
  f.apply({ mcp: [] });
  const replacement = { ...existingServer, name: mcp.name };
  cfg.mcp_servers[1] = replacement;
  f.write(cfg);
  for (const desired of [[], [replacement]]) {
    const result = f.apply({ mcp: desired });
    assert.equal(result.changed, false);
    assert.deepEqual(result.conflicts.map(c => c.reason), ['collision']);
    assert.deepEqual(f.read(), cfg);
  }
  assert.equal(f.exists(stateFile), false);
});

test('the native server limit counts local and disabled entries and admits additions after removals', t => {
  const locals = Array.from({ length: 63 }, (_, i) => ({ ...existingServer, name: 'local-' + i, enabled: false }));
  const f = fixture(t, { mcp_servers: locals });
  const direct = { ...existingServer, name: 'direct' };
  f.apply({ mcp: [direct] });
  const full = f.read();
  const blocked = f.apply({ mcp: [mcp, direct] });
  assert.equal(blocked.changed, false);
  assert.deepEqual(blocked.conflicts.map(c => [c.id, c.reason]), [[mcp.name, 'capacity']]);
  assert.deepEqual(f.read(), full);
  assert.equal(f.exists('mcp-server-secrets.json'), false);
  assert.deepEqual(f.apply({ mcp: [mcp] }), { changed: true, conflicts: [] });
  const swapped = f.read().mcp_servers;
  assert.deepEqual(swapped.slice(0, -1), locals);
  assert.equal(swapped.at(-1).name, mcp.name);
  swapped.at(-1).url += '/local';
  f.write({ mcp_servers: swapped });
  const stillFull = f.apply({ mcp: [direct] });
  assert.deepEqual(stillFull.conflicts.map(c => c.reason), ['edited', 'capacity']);
  assert.deepEqual(f.read().mcp_servers, [...locals, { ...swapped.at(-1), enabled: false }]);
});

test('an explicit Tools model using the managed provider survives switching and protects its dependency', t => {
  const f = fixture(t);
  f.apply({ model });
  const tools = { provider: providerId, model: model.id };
  f.write({ ...f.read(), ai_tools_model: tools });
  const newModel = { ...model, id: 'fixture/second' };
  assert.equal(f.apply({ model: newModel }).changed, true);
  assert.deepEqual(f.read().ai_provider_models[providerId].map(entry => entry.id), [newModel.id, model.id]);
  const reset = f.apply({ model: null });
  assert.equal(reset.conflicts[0].reason, 'in-use');
  assert.equal(f.read().ai_provider, original.ai_provider);
  assert.deepEqual(f.read().ai_tools_model, tools);
  assert.equal(secrets(f, 'ai-secrets.json')[providerId], model.apiKey);
  f.write({ ...f.read(), ai_tools_model: original.ai_tools_model });
  assert.deepEqual(f.apply({ model: null }), { changed: true, conflicts: [] });
  assert.deepEqual(f.read(), original);
});

test('an edited provider blocks model changes without blocking unrelated MCP assignments', t => {
  const f = fixture(t);
  f.apply({ model });
  const cfg = f.read();
  cfg.ai_custom_providers[1].baseURL = 'http://127.0.0.1:49990/v1';
  f.write(cfg);
  const result = f.apply({ model: { ...model, id: 'fixture/second' }, mcp: [mcp] });
  assert.equal(result.changed, true);
  assert.equal(result.conflicts[0].reason, 'edited');
  assert.equal(f.read().ai_model, model.id);
  assert.deepEqual(f.read().ai_custom_providers, cfg.ai_custom_providers);
  assert.equal(f.read().mcp_servers[1].name, 'magpie');
  assert.equal(f.apply({ model: null }).conflicts[0].reason, 'edited');
  assert.equal(f.read().ai_model, original.ai_model);
  assert.deepEqual(f.read().ai_custom_providers, cfg.ai_custom_providers);
});

function interrupted(f, options, when) {
  const run = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const { basename } = require('node:path');
    const { reconcile } = require(process.argv[1]);
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      const config = basename(to) === 'config.json';
      if (config && process.argv[3] === 'before') process.kill(process.pid, 'SIGKILL');
      rename(from, to);
      if (config && process.argv[3] === 'after') process.kill(process.pid, 'SIGKILL');
    };
    reconcile(JSON.parse(process.argv[2]));
  `, require.resolve('../reconcile.cjs'), JSON.stringify({ dataDir: f.dataDir, ...options }), when], { encoding: 'utf8' });
  assert.equal(run.signal, 'SIGKILL', run.stderr);
}

test('a process killed before config replacement leaves the old config valid and retries cleanly', t => {
  const f = fixture(t);
  interrupted(f, { model, mcp: [mcp] }, 'before');
  assert.deepEqual(f.read(), original);
  const [staged] = Object.keys(secrets(f, 'mcp-server-secrets.json'));
  assert.ok(staged);
  assert.deepEqual(f.apply({ model, mcp: [mcp] }), { changed: true, conflicts: [] });
  assert.equal(f.read().ai_model, model.id);
  assert.equal(f.read().mcp_servers.length, 2);
  assert.equal(Object.hasOwn(secrets(f, 'mcp-server-secrets.json'), staged), false);
  assert.deepEqual(f.apply({ model: null, mcp: [] }), { changed: true, conflicts: [] });
  assert.deepEqual(f.read(), original);
});

test('recovery after config replacement respects later user edits and completes interrupted cleanup', t => {
  const f = fixture(t);
  interrupted(f, { model, mcp: [mcp] }, 'after');
  f.write({ ...f.read(), unknown_setting: { concurrent: true } });
  assert.deepEqual(f.apply({ model, mcp: [mcp] }), { changed: false, conflicts: [] });
  interrupted(f, { model: null, mcp: [] }, 'after');
  assert.deepEqual(f.read(), { ...original, unknown_setting: { concurrent: true } });
  assert.equal(secrets(f, 'ai-secrets.json')[providerId], model.apiKey);
  f.apply({ readDesired: () => ({}) });
  assert.deepEqual(secrets(f, 'ai-secrets.json'), {});
  assert.deepEqual(secrets(f, 'mcp-server-secrets.json'), {});
  assert.equal(f.exists(stateFile), false);
});

test('the desired callback runs exclusively under the native configuration lock', t => {
  const f = fixture(t);
  let read = false;
  const result = f.apply({ readDesired: () => {
    assert.throws(() => f.apply({ readDesired: () => { read = true; return { model }; } }), { code: 'OLEAFLY_BUSY' });
    return { model: null, mcp: [] };
  } });
  assert.equal(read, false);
  assert.deepEqual(result, { changed: false, conflicts: [] });
  assert.deepEqual(f.read(), original);
  assert.equal(f.apply({ readDesired: () => ({ model }) }).changed, true);
});

test('invalid config, secret envelopes, desired state, and callback failures have safe errors', t => {
  const f = fixture(t);
  const secret = 'do-not-show-this-secret';
  assert.throws(() => f.apply({ readDesired: () => { throw new Error(secret); } }), error =>
    /staged Oleafly/.test(error.message) && !error.message.includes(secret));
  assert.throws(() => f.apply({ readDesired: () => Promise.resolve({ model }) }), /synchronously/);
  assert.throws(() => f.apply({ model: { ...model, baseURL: `http://user:${secret}@localhost/v1` } }), error =>
    /gateway connection/.test(error.message) && !error.message.includes(secret));
  assert.throws(() => f.apply({ mcp: [{ ...mcp, disabledTools: [secret] }] }), error =>
    /MCP server 'magpie'/.test(error.message) && !error.message.includes(secret));
  assert.throws(() => f.apply({ mcp: [{ ...mcp, headers: { 'Mcp-Session-Id': secret } }] }), /unsupported assignment/);
  f.write({ ai_custom_providers: null });
  assert.throws(() => f.apply({ model }), /invalid model or MCP settings/);
  assert.deepEqual(f.read(), { ai_custom_providers: null });
  fs.writeFileSync(f.path('config.json'), secret);
  assert.throws(() => f.apply({ model }), error => /config.json is invalid/.test(error.message) && !error.message.includes(secret));
  f.write(original);
  writeSecrets(f, 'ai-secrets.json', { existing: secret });
  f.write({ ...f.read('ai-secrets.json'), version: 2 }, 'ai-secrets.json');
  assert.throws(() => f.apply({ model }), error => /Cannot decrypt Oleafly ai-secrets.json/.test(error.message) && !error.message.includes(secret));
  assert.deepEqual(f.read(), original);
});
