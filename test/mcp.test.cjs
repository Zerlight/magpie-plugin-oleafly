'use strict';

const assert = require('node:assert/strict');
const { createDecipheriv } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { translateMcp } = require('../mcp.cjs');
const { reconcile } = require('../reconcile.cjs');

const gatewayUrl = 'http://127.0.0.1:43625';
const hubUrl = `${gatewayUrl}/mcp/magpie/hub/oleafly`;
const pluginUrl = `${gatewayUrl}/mcp/magpie/tools/calc`;
const calcPlugin = '@magpie-community/tools-calc';
const remoteUrl = 'https://research.example/mcp?version=1';
const http = (url) => ({ type: 'http', url });
const stdio = { type: 'stdio', command: 'node', args: ['mock-server.js', 'two words'], env: {} };
const server = (name, transport, rest = {}) => ({ name, transport, agents: ['oleafly'], ...rest });
const library = (mcp, owned = mcp.map((entry) => entry.name), mcpHub = false) => ({
  mcp, mcpHub, applied: { oleafly: { mcp: owned } },
});
const translate = (mcpServers, document, options = {}) => translateMcp({ mcpServers }, document, { gatewayUrl, ...options });

test('Router off translates Magpie’s Claude-format stdio, HTTP, OAuth relays, and per-plugin tools', () => {
  const entries = { local: stdio, remote: http(remoteUrl), oauth: http(`${gatewayUrl}/mcp/oauth`), calc: http(pluginUrl) };
  const document = library([
    server('local', 'stdio'), server('remote', 'http', { url: remoteUrl }),
    server('oauth', 'http', { url: remoteUrl, oauth: { clientId: 'fixture' } }),
    server('calc', 'http', { plugin: calcPlugin, url: pluginUrl }),
  ]);
  assert.deepEqual(translate(entries, document), {
    servers: [
      { name: 'local', transport: 'stdio', command: 'node', args: ['mock-server.js', 'two words'], env: {} },
      { name: 'remote', transport: 'remote', url: remoteUrl, headers: {} },
      { name: 'oauth', transport: 'remote', url: `${gatewayUrl}/mcp/oauth`, headers: {} },
      { name: 'calc', transport: 'remote', url: pluginUrl, headers: {} },
    ],
    issues: [],
  });
});

test('Router on keeps only the scoped hub and assigned direct entries', () => {
  const entries = { magpie: http(hubUrl), local: stdio, calc: http(pluginUrl), direct: http(remoteUrl), foreign: stdio };
  const document = library([
    server('local', 'stdio', { disabledTools: ['hidden'] }),
    server('calc', 'http', { plugin: calcPlugin, url: pluginUrl }),
    server('direct', 'http', { hub: 'direct', url: remoteUrl }),
    server('foreign', 'stdio', { agents: ['codex'] }),
  ], Object.keys(entries), true);
  assert.deepEqual(translate(entries, document), {
    servers: [
      { name: 'magpie', transport: 'remote', url: hubUrl, headers: {} },
      { name: 'direct', transport: 'remote', url: remoteUrl, headers: {} },
    ],
    issues: [],
  });
});

test('rejects stale or broad Router paths without falling back to individually routed entries', () => {
  for (const url of [hubUrl.replace('/oleafly', ''), hubUrl.replace('/oleafly', '/codex'), hubUrl.replace(':43625', ':3425'), `${hubUrl}?tools=all`]) {
    const result = translate({ magpie: http(url), local: stdio }, library([server('local', 'stdio')], ['magpie', 'local'], true));
    assert.deepEqual(result.servers, []);
    assert.match(result.issues[0].message, /Oleafly-scoped/);
  }
  const staged = { magpie: http(hubUrl), local: stdio };
  const directOnly = library([server('local', 'stdio', { hub: 'direct' })], Object.keys(staged), true);
  assert.deepEqual(translate(staged, directOnly).servers.map((entry) => entry.name), ['local']);
  const hubOff = library([server('local', 'stdio')], Object.keys(staged));
  assert.deepEqual(translate(staged, hubOff).servers.map((entry) => entry.name), ['local']);
});

test('requires current assignment and writer ownership and reports Router name collisions', () => {
  const entries = { unowned: stdio, stale: stdio, hidden: stdio, magpie: http(hubUrl) };
  const assignments = [server('unowned', 'stdio'), server('stale', 'stdio', { agents: [] }), server('hidden', 'stdio', { hidden: true })];
  const result = translate(entries, library(assignments, ['stale', 'hidden', 'magpie']));
  assert.deepEqual(result.servers, []);
  assert.deepEqual(result.issues.map((issue) => issue.name), ['unowned']);
  const collision = translate(entries, library([...assignments, server('magpie', 'http', { agents: [] })], ['magpie'], true));
  assert.deepEqual(collision.servers, []);
  assert.match(collision.issues[0].message, /conflicts with the Router/);
});

test('withholds direct disabled tools, unknown access settings, and legacy SSE', () => {
  const inputs = { limited: stdio, restricted: { ...stdio, allowed_tools: ['visible'] }, legacy: { type: 'sse', url: remoteUrl } };
  const assignments = [
    server('limited', 'stdio', { hub: 'direct', disabledTools: ['hidden'] }),
    server('restricted', 'stdio', { hub: 'direct' }), server('legacy', 'sse', { hub: 'direct', url: remoteUrl }),
  ];
  for (const enabled of [false, true]) {
    const { servers, issues } = translate(inputs, library(assignments, Object.keys(inputs), enabled));
    assert.deepEqual(servers, []);
    assert.deepEqual(issues.map((issue) => issue.name), ['limited', 'restricted', 'legacy']);
    assert.match(issues[0].message, /per-tool restrictions/);
    assert.match(issues[1].message, /cannot enforce/);
    assert.match(issues[2].message, /Streamable HTTP/);
  }
});

test('rejects wrong plugin endpoints, broad tools, injected URL credentials and non-loopback HTTP', () => {
  const plugin = server('calc', 'http', { plugin: calcPlugin, url: pluginUrl });
  for (const url of [pluginUrl.replace('/calc', ''), pluginUrl.replace('/calc', '/other'), pluginUrl.replace('127.0.0.1', 'localhost')]) {
    const result = translate({ calc: http(url) }, library([plugin]));
    assert.deepEqual(result.servers, []);
    assert.match(result.issues[0].message, /assigned plugin/);
  }
  for (const url of [
    `http://127.attacker.example:43625/mcp`, `https://user:pass@research.example/mcp`, `${remoteUrl}#x`,
    `${gatewayUrl}/mcp/magpie/tools`, pluginUrl, `${gatewayUrl}/mcp/magpie/%68ub/other`,
  ]) {
    const { servers, issues } = translate({ remote: http(url) }, library([server('remote', 'http', { url })]));
    assert.deepEqual(servers, []);
    assert.equal(issues[0].name, 'remote');
    assert.ok(!JSON.stringify(issues).includes(url));
  }
});

test('withholds shared direct plugin endpoints and keeps the scoped Router usable', () => {
  const assigned = server('calc', 'http', { plugin: calcPlugin, url: pluginUrl });
  const pluginsOffered = [calcPlugin, '@another/tools-calc'];
  const direct = translate({ calc: http(pluginUrl) }, { ...library([assigned]), pluginsOffered });
  assert.deepEqual(direct.servers, []);
  assert.equal(direct.issues[0].name, 'calc');
  assert.match(direct.issues[0].message, /shared by multiple plugins/);

  const routed = translate({ magpie: http(hubUrl) }, { ...library([assigned], ['magpie'], true), pluginsOffered });
  assert.equal(routed.servers[0].url, hubUrl);
  assert.deepEqual(routed.issues, []);
});

test('reconcile encrypts translated env and headers and ignores unassigned entries', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'magpie-oleafly-mcp-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const secret = 'fixture-sensitive-value';
  const result = translate({
    local: { ...stdio, env: { TOKEN: secret, EMPTY: '' } },
    remote: { ...http(remoteUrl), headers: { Authorization: `Bearer ${secret}` } },
    missing: stdio,
    nil: stdio,
  }, library([
    { name: 'missing', transport: 'stdio' },
    server('local', 'stdio'),
    server('nil', 'stdio', { agents: null }),
    server('remote', 'http', { url: remoteUrl }),
  ]));
  assert.deepEqual(result.servers.map((entry) => entry.name), ['local', 'remote']);
  assert.deepEqual(result.servers[0].env, { TOKEN: secret, EMPTY: '' });
  assert.deepEqual(result.servers[1].headers, { Authorization: `Bearer ${secret}` });
  assert.deepEqual(result.issues, []);

  const sync = () => reconcile({ dataDir, readDesired: () => ({ mcp: result.servers }) });
  assert.deepEqual(sync(), { changed: true, conflicts: [] });
  const read = (name) => readFileSync(join(dataDir, name), 'utf8');
  const config = read('config.json');
  const state = read('.magpie-oleafly-state.json');
  assert.ok(!config.includes(secret) && !state.includes(secret));
  const [local, remote] = JSON.parse(config).mcp_servers;
  const references = [local.env.TOKEN, remote.headers.Authorization];
  references.forEach(ref => assert.match(ref, /^__stored__:v1:[a-f0-9]{64}$/));
  assert.equal(local.env.EMPTY, '');

  const { nonce, ciphertext } = JSON.parse(read('mcp-server-secrets.json'));
  const sealed = Buffer.from(ciphertext, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', readFileSync(join(dataDir, 'ai-secrets.key')), Buffer.from(nonce, 'base64'));
  cipher.setAuthTag(sealed.subarray(-16));
  const values = JSON.parse(Buffer.concat([cipher.update(sealed.subarray(0, -16)), cipher.final()]));
  assert.deepEqual(references.map(ref => values[ref]), [secret, `Bearer ${secret}`]);
  assert.deepEqual(sync(), { changed: false, conflicts: [] });
});

test('withholds invalid values and imported secret references without leaking staged secrets', () => {
  const sensitive = 'fixture-sensitive-value';
  const document = library([server('remote', 'http', { url: remoteUrl })]);
  for (const headers of [
    { Authorization: '${TOKEN}' }, { Authorization: '__stored__' }, { Authorization: `__stored__:v1:${'b'.repeat(64)}` },
    { Authorization: 'value\r\nToken: another' }, { 'MCP-Param-Run': sensitive }, { Host: sensitive },
    { Authorization: sensitive, authorization: sensitive }, { Authorization: 3 },
  ]) {
    const { servers, issues } = translate({ remote: { ...http(remoteUrl), headers } }, document);
    assert.deepEqual(servers, []);
    assert.ok(!JSON.stringify(issues).includes(sensitive));
  }
});

test('blocks malformed snapshots and permits an empty or removed staging file', () => {
  for (const staging of [[], 'secret', { mcpServers: [] }, { servers: {} }]) {
    assert.throws(() => translateMcp(staging, {}), /Invalid Oleafly MCP staging document/);
  }
  for (const document of [null, { mcp: {} }, { applied: [] }, { mcpHub: 'true' }, { mcp: [{ name: 'bad', agents: 'oleafly' }] }]) {
    assert.throws(() => translate({}, document), /Invalid Magpie Library/);
  }
  for (const stage of [null, {}, { mcpServers: {} }]) {
    assert.deepEqual(translateMcp(stage, { mcp: null }), { servers: [], issues: [] });
  }
});
