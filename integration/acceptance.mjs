import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { models, referenceFile, resultText, serveFixtures, toolMarker } from './fixtures.mjs';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const fixtureScript = fileURLToPath(new URL('./fixtures.mjs', import.meta.url));
const magpie = realpathSync(process.env.MAGPIE_BIN ?? '/Applications/magpie.app/Contents/MacOS/magpie');
const oleafly = realpathSync(process.env.OLEAFLY_BIN ?? '/Applications/Oleafly.app/Contents/MacOS/oleafly-cli');
const [mode, extra] = process.argv.slice(2);
if (extra || (mode && !['--preflight', '--gui', '--cli'].includes(mode))) {
  throw new Error('Usage: node integration/acceptance.mjs [--preflight | --gui | --cli]');
}
const packageDir = realpathSync(process.env.OLEAFLY_PLUGIN_DIR ?? repo);
const packageManifest = path.join(packageDir, 'package.json');
const magpieBase = path.basename(path.dirname(magpie)) === 'MacOS'
  ? path.resolve(magpie, '../../../..')
  : path.dirname(magpie);
const hasPortableData = ['.portable', 'data'].some(name => existsSync(path.join(magpieBase, name)));
if (hasPortableData) throw new Error('Magpie has adjacent portable data. Use a copy of the installed binary in an empty directory.');

const root = mkdtempSync('/private/tmp/magpie-oleafly-acceptance-');
const dir = name => path.join(root, name);
for (const name of ['home', 'bin', 'tmp', 'project', 'oleafly', 'xdg-config', 'xdg-data', 'xdg-cache', 'xdg-state']) {
  mkdirSync(dir(name), { mode: 0o700 });
}
const env = {
  HOME: dir('home'), USERPROFILE: dir('home'), SHELL: '/bin/sh',
  PATH: dir('bin') + ':/usr/bin:/bin:/usr/sbin:/sbin',
  TMPDIR: dir('tmp'), XDG_CONFIG_HOME: dir('xdg-config'), XDG_DATA_HOME: dir('xdg-data'),
  XDG_CACHE_HOME: dir('xdg-cache'), XDG_STATE_HOME: dir('xdg-state'),
  OLEAFLY_DATA_DIR: dir('oleafly'), MAGPIE_NO_ACCOUNTS: '1', MAGPIE_NO_STATS: '1',
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  NO_COLOR: '1', TERM: 'dumb', LANG: 'en_US.UTF-8',
};
if (process.env.MAGPIE_BUN) env.MAGPIE_BUN = realpathSync(process.env.MAGPIE_BUN);
symlinkSync(oleafly, dir('bin/oleafly'));
const configPath = dir('oleafly/config.json');
const libraryPath = dir('xdg-config/magpie/library.json');
const skill = 'acceptance-receipt';
const skillDestination = dir('oleafly/skills/' + skill);
const asset = Buffer.from([0x4d, 0x50, 0x4f, 0x00]);
const pluginFixtureName = 'fixturekit';
const pluginFixture = dir(pluginFixtureName);
const tools = ['stdioprobe', 'remoteprobe', 'pluginprobe'];
const blockedTool = 'unassignedprobe';
const group = 'group/acceptance-route';
const mcpPermissions = ['--apply', '--allow', 'write,commands,network'];
let host;
let fixture;
let stage = 'setup';
let failures = 0;
let stopRequested;
const stopSignal = new Promise(resolve => { stopRequested = resolve; });
process.once('SIGINT', stopRequested);
process.once('SIGTERM', stopRequested);

function check(condition, message) {
  if (!condition) throw new Error(message);
}
function json(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function write(file, value) { writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
function replaceConfig(value) {
  write(configPath + '.fixture', value);
  renameSync(configPath + '.fixture', configPath);
}
const config = () => json(configPath);
const library = () => json(libraryPath);
const mcp = (name) => config().mcp_servers?.find(entry => entry.name === name);
function pass(label) { console.log('PASS  ' + label); }
function fail(label, error) {
  failures++;
  console.error('FAIL  ' + label + ' — ' + (error instanceof SyntaxError ? 'invalid fixture JSON' : error.message));
}
async function scenario(label, exercise) {
  try { await exercise(); } catch (error) { fail(label, error); }
}

function diagnostic(output) {
  // Emit only fixed categories, since child output can contain config values.
  for (const [pattern, category] of [
    [/unknown (agent|target)|no agent.*oleafly/i, 'Oleafly agent or Library target unavailable'],
    [/bun.*(download|not ready|can't|no such|failed)/i, 'Bun runtime unavailable'],
    [/relative path|not detected/i, 'agent detection failed'],
    [/connection refused|connect error/i, 'connection refused'],
    [/permission denied|operation not permitted/i, 'permission denied'],
    [/no provider|model.*not found|not set.*model/i, 'provider or model unavailable'],
    [/unsupported|unknown flag|unexpected argument/i, 'unsupported command or argument'],
  ]) if (pattern.test(output)) return category;
  return 'child output withheld';
}
async function run(bin, args, childEnv = env) {
  try {
    const { stdout } = await exec(bin, args, { cwd: dir('project'), env: childEnv, timeout: 25000, maxBuffer: 2 << 20 });
    return stdout;
  } catch (error) {
    throw new Error(path.basename(bin) + ' ' + args.slice(0, 2).join(' ') +
      ' failed (' + (error.code ?? error.signal ?? 'no status') + ', ' +
      diagnostic(error.stdout + '\n' + error.stderr) + ')');
  }
}
const mg = (...args) => run(magpie, args);
async function eventually(predicate, message) {
  const deadline = Date.now() + 7500;
  do {
    if (await predicate()) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(message);
}
async function port() {
  const socket = net.createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const result = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return result;
}
let webAddress;
async function startHost() {
  const child = spawn(magpie, ['serve', ...(webAddress ? ['--web=' + webAddress] : [])], {
    cwd: dir('project'), env, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  const resident = { child, diagnostics: '', done: new Promise(resolve => {
    child.once('exit', resolve);
    child.once('error', resolve);
  }) };
  child.stderr.on('data', chunk => {
    resident.diagnostics = (resident.diagnostics + chunk).slice(-32000);
  });
  host = resident;
  await eventually(async () => {
    if (child.exitCode !== null) throw new Error('resident Magpie exited at startup');
    try { return (await gateway('/api/hello')).ok; } catch { return false; }
  }, 'resident Magpie did not open the isolated gateway');
}
async function stopHost() {
  if (!host) return;
  const { child, done } = host;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 4500);
  await done;
  clearTimeout(timer);
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  host = undefined;
}
function gateway(url) {
  return fetch('http://' + env.MAGPIE_ADDR + url, { signal: AbortSignal.timeout(2500) });
}
async function refreshHost() {
  check((await gateway('/v1/models')).ok, 'resident model catalog refresh failed');
}
async function probeGateway() {
  const start = fixture.upstream.length;
  const response = await fetch('http://' + env.MAGPIE_ADDR + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: group, messages: [{ role: 'user', content: 'Readiness fixture' }] }),
    signal: AbortSignal.timeout(7500),
  });
  check(response.ok && (await response.json()).choices?.[0]?.message?.content === resultText &&
    fixture.upstream.slice(start).some(call => call.model === models[0]), 'resident gateway did not route a request to the local fixture');
}
async function setModel(model) {
  const before = host.diagnostics.length;
  const output = await mg('oleafly', model);
  await refreshHost();
  try {
    await eventually(() => config().ai_model === model, 'Oleafly config did not pick up ' + model);
  } catch (error) {
    const desiredPath = dir('home/.magpie-oleafly/agent.json');
    const desired = existsSync(desiredPath) ? json(desiredPath) : {};
    const conditions = [
      desired.model === model ? 'descriptor model written' : 'descriptor model missing or stale',
      desired.baseURL === 'http://' + env.MAGPIE_ADDR + '/v1' ? 'descriptor gateway correct' : 'descriptor gateway missing or different',
      typeof desired.gatewayKey === 'string' && desired.agentId === 'oleafly' ? 'descriptor identity present' : 'descriptor identity missing',
    ];
    const reports = [
      [/cannot reach the selected Magpie gateway/i, 'gateway unavailable reported'],
      [/invalid Oleafly model selection/i, 'invalid selection reported'],
      [/different settings for the Magpie provider/i, 'provider conflict reported'],
      [/chat model changed outside Magpie/i, 'chat conflict reported'],
      [/config transaction|configuration is busy/i, 'config lock reported'],
      [/Oleafly settings updated/i, 'a bridge update was reported'],
      [/Cannot identify the running Oleafly plugin/i, 'plugin registration failure reported'],
    ];
    for (const [pattern, label] of reports) if (pattern.test(host.diagnostics.slice(before))) conditions.push(label);
    throw new Error(error.message + ' (' + conditions.join(', ') + ')');
  }
  return output;
}
async function resetModel(original) {
  await mg('oleafly', 'default');
  await refreshHost();
  await eventually(() => config().ai_provider === original.ai_provider && config().ai_model === original.ai_model,
    'Agent default did not restore the original selection');
}
async function interruptBeforeWrite(from, to) {
  const lock = spawn('/usr/bin/lockf', ['-k', dir('oleafly/.config-store.lock'),
    '/bin/sh', '-c', 'echo locked; read -r release'], { cwd: dir('project'), env, stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = once(lock, 'close');
  try {
    const ready = await Promise.race([once(lock.stdout, 'data'), closed, delay(2000)]);
    check(ready?.[0]?.toString().trim() === 'locked', 'fixture failed to hold Oleafly’s config lock');
    const before = readFileSync(configPath);
    await mg('oleafly', to);
    await delay(750);
    check(readFileSync(configPath).equals(before) && config().ai_model === from,
      'reconciliation modified config while the Oleafly lock was held');
    await stopHost();
  } finally {
    lock.stdin.end();
    await closed;
  }
  await startHost();
  await refreshHost();
  await eventually(() => config().ai_model === to, 'resident restart did not apply the pending model after lock release');
}
async function conversation(expected, options = [], plan = []) {
  const live = config();
  const provider = live.ai_custom_providers.find(entry => entry.id === live.ai_provider);
  const allowed = [fixture.base + '/v1', 'http://' + env.MAGPIE_ADDR + '/v1'];
  check(provider && allowed.includes(provider.baseURL.replace(/\/$/, '')), 'selected provider is outside the two fixture endpoints');
  const start = fixture.upstream.length;
  fixture.plan(plan);
  try {
    const reply = await run(oleafly, ['agent', 'run', '--json', '--no-input', '--timeout', '15',
      '--max-steps', '8', ...options, 'Run the acceptance fixture and return its marker.']);
    check(reply.includes(resultText), 'fresh Oleafly CLI did not return the fixture reply');
    const calls = fixture.upstream.slice(start);
    check(calls.length > 0 && calls.every(call => call.model === expected), 'upstream received the wrong model');
    for (const item of plan) {
      check(calls.some(call => call.receipts.includes(item.marker)), 'CLI did not receive the result from ' + item.name);
    }
    return calls[0].tools;
  } finally {
    fixture.plan([]);
  }
}
function writeSkill(where, marker) {
  mkdirSync(path.join(where, 'references'), { recursive: true });
  mkdirSync(path.join(where, 'assets'), { recursive: true });
  writeFileSync(path.join(where, 'SKILL.md'), '---\nname: ' + skill + '\ndescription: Read the acceptance receipt.\n---\n\nRead the receipt.\n');
  writeFileSync(path.join(where, referenceFile), marker + '\n');
  writeFileSync(path.join(where, 'assets/receipt.bin'), asset);
}
function copyIs(marker) {
  return existsSync(skillDestination) && lstatSync(skillDestination).isDirectory() &&
    existsSync(path.join(skillDestination, referenceFile)) &&
    readFileSync(path.join(skillDestination, referenceFile), 'utf8').trim() === marker &&
    existsSync(path.join(skillDestination, 'assets/receipt.bin')) &&
    readFileSync(path.join(skillDestination, 'assets/receipt.bin')).equals(asset);
}
function writePluginTool() {
  mkdirSync(pluginFixture);
  write(path.join(pluginFixture, 'package.json'), { name: pluginFixtureName, version: '1.0.0', main: './index.mjs' });
  writeFileSync(path.join(pluginFixture, 'index.mjs'), `export default async () => ({
    tool: { pluginprobe: {
      description: 'Return the plugin acceptance fixture marker.',
      args: { type: 'object', properties: {} },
      execute() { return ${JSON.stringify(toolMarker('pluginprobe'))}; },
    } },
  });\n`);
}
async function mcpMatrix(routed) {
  await mg('library', 'mcp', 'router', routed ? 'on' : 'off');
  await refreshHost();
  await eventually(() => mcp('remoteprobe') &&
    (routed ? mcp('magpie') && !mcp('stdioprobe') && !mcp(pluginFixtureName)
      : !mcp('magpie') && mcp('stdioprobe') && mcp(pluginFixtureName)),
  'Oleafly MCP config did not converge for Router ' + (routed ? 'on' : 'off'));
  check(Boolean(library().mcpHub) === routed, 'plugin changed the selected global Router setting');
  check(!mcp(blockedTool), 'unassigned server appeared in Oleafly config');
  if (routed) {
    const hub = new URL(mcp('magpie').url);
    check(hub.host === env.MAGPIE_ADDR && hub.pathname === '/mcp/magpie/hub/oleafly',
      'Router URL did not use the Oleafly scope and isolated gateway port');
  }
  // Use the actual Oleafly 0.4.13 identifier the tool would receive if assigned.
  const server = routed ? 'magpie' : blockedTool;
  const tool = routed ? blockedTool + '__' + blockedTool : blockedTool;
  const suffix = createHash('sha256').update(server + '\0' + tool).digest('hex').slice(0, 12);
  const forbidden = 'mcp_ext_' + server + '_' + tool.replace('__', '_').slice(0, 24) + '_' + suffix;
  const exposed = await conversation(models[0], mcpPermissions, [
    ...tools.map(name => ({ name, marker: toolMarker(name) })),
    { name: 'unassigned MCP rejection', force: forbidden, marker: 'The tool ' + forbidden + ' is not available in this run.' },
  ]);
  check(!exposed.some(name => name.includes(blockedTool)), 'model saw an unassigned MCP tool');
}
async function detached(original, action) {
  await mg('library', 'skill', 'agents', skill, 'oleafly');
  await eventually(() => copyIs('library-skill-v2'), 'managed skill was not present before plugin ' + action);
  await pluginAction(action);
  await refreshHost();
  await eventually(() => config().ai_provider === original.ai_provider && config().ai_model === original.ai_model &&
    config().ai_custom_providers.length === original.ai_custom_providers.length &&
    !mcp('remoteprobe') && !mcp('magpie') && !mcp('stdioprobe') && !mcp(pluginFixtureName),
  'plugin ' + action + ' failed to clean up in the resident host');
  check((await mg('ls')).split('\n').every(line => !/^\s+Oleafly\b/i.test(line)), 'detected row survived plugin ' + action);
  check(mcp('unrelated').args.includes('editedprobe'), 'later unrelated MCP edit was replaced');
  check(Boolean(library().mcpHub), 'plugin ' + action + ' changed the global MCP Router setting');
  await conversation(models[1], ['--no-mcp']);
  await eventually(() => !existsSync(skillDestination), 'plugin ' + action + ' left an owned skill copy');
}
async function callResidentPluginTool() {
  const response = await fetch('http://' + env.MAGPIE_ADDR + '/mcp/magpie/tools/' + pluginFixtureName, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pluginprobe', arguments: {} },
    }),
    signal: AbortSignal.timeout(7500),
  });
  check(response.ok && (await response.text()).includes(toolMarker('pluginprobe')), 'resident fixture plugin tool call failed');
}
async function pluginAction(action) {
  if (!webAddress) return mg('plugin', action, packageDir);
  const request = await webSession();
  if (action === 'on' || action === 'off') return request('/api/plugins/off', { spec: packageDir, off: action === 'off' });
  return request('/api/plugins/' + (action === 'rm' ? 'remove' : 'add'), { spec: packageDir });
}
async function webSession() {
  const origin = 'http://' + webAddress;
  const session = await fetch(origin + '/_magpie/sign-in', {
    method: 'POST', body: new URLSearchParams({ key: env.MAGPIE_WEB_KEY }), redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
  const cookie = session.headers.get('set-cookie')?.split(';', 1)[0];
  check(session.status === 303 && cookie, 'isolated Magpie web sign-in failed');
  return async function request(endpoint, body) {
    const response = await fetch(origin + endpoint, {
      method: body ? 'POST' : 'GET',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body), signal: AbortSignal.timeout(7500),
    });
    check(response.ok, 'Magpie web control rejected ' + endpoint);
    return response.json();
  };
}
async function exerciseWeb(original) {
  const request = await webSession();
  let state, agents;
  await request('/api/agents/rescan', {});
  await eventually(async () => {
    state = await request('/api/state');
    agents = state.agents?.filter(agent => agent.id === 'oleafly');
    return agents?.length === 1;
  }, 'Magpie web did not show one Oleafly agent');
  const selected = 'acceptance/' + models[0];
  const field = agents[0].fields.find(item => item.key === 'model');
  const options = field?.list ? state.optionLists[field.list - 1].map(index => state.options[index]) : field?.options;
  const option = options?.find(item => item.ref === selected);
  check(option, 'Magpie web picker did not offer the fixture model');
  const picked = await request('/api/set', { agent: 'oleafly', field: 'model', value: option.value });
  check(/new conversation|reopen/i.test(picked.notice ?? ''), 'Magpie web model control did not return the restart notice');
  await refreshHost();
  await eventually(() => config().ai_model === selected, 'Magpie web model control did not configure Oleafly');
  await conversation(models[0], ['--no-mcp']);
  await request('/api/library/servers/agents', { name: 'remoteprobe', agents: ['oleafly'] });
  await eventually(() => mcp('remoteprobe'), 'Magpie web Library assignment did not reach Oleafly');
  await request('/api/library/servers/tools', { name: 'remoteprobe', names: ['remoteprobe'] });
  await eventually(() => !mcp('remoteprobe') && /\[Oleafly\].*MCP remoteprobe.*per-tool restrictions/i.test(host.diagnostics),
    'restricted direct MCP entry was not withheld and identified');
  await request('/api/library/servers/tools', { name: 'remoteprobe', names: [] });
  await eventually(() => mcp('remoteprobe'), 'clearing the restriction did not restore the direct entry');
  await request('/api/library/servers/agents', { name: 'remoteprobe', agents: [] });
  await eventually(() => !mcp('remoteprobe'), 'Magpie web Library removal did not reach Oleafly');
  await request('/api/set', { agent: 'oleafly', field: 'model', value: '' });
  await eventually(() => config().ai_provider === original.ai_provider && config().ai_model === original.ai_model,
    'Magpie web model reset did not restore the original selection');
  pass('Magpie web model pick and reset, MCP assignment and removal, and direct MCP restriction withholding');
}

try {
  fixture = await serveFixtures();
  env.MAGPIE_ADDR = '127.0.0.1:' + await port();
  // Built-in catalog/update checks may try public URLs. Keep those requests on loopback.
  env.HTTP_PROXY = env.HTTPS_PROXY = env.ALL_PROXY = fixture.base;
  env.http_proxy = env.https_proxy = env.all_proxy = fixture.base;
  stage = 'binary versions and baseline';
  check(/^magpie 0\.1\.4705\b/.test(await mg('version')), 'expected Magpie 0.1.4705');
  check(/^oleafly 0\.4\.13\b/.test(await run(oleafly, ['--version'])), 'expected Oleafly 0.4.13');
  await mg('update', 'auto', 'off');
  writeFileSync(dir('project/main.md'), '# Acceptance fixture\n');
  const stdio = name => ({ name, enabled: true, transport: 'stdio', command: process.execPath, args: [fixtureScript, 'stdio', name], env: {} });
  const original = {
    ai_provider: 'local-original', ai_model: models[1],
    ai_custom_providers: [{ id: 'local-original', name: 'Original fixture', baseURL: fixture.base + '/v1', keyOptional: true, reasoningEffort: false }],
    ai_provider_models: { 'local-original': models.map(id => ({ id, name: id, enabled: true, source: 'manual' })) },
    ai_tools_model: { provider: 'local-original', model: models[0] },
    mcp_servers: [stdio('unrelated')],
  };
  write(configPath, original);
  await mg('provider', 'add', 'Acceptance fixture', 'id=acceptance', 'url=' + fixture.base + '/v1',
    'models=' + models.join(','), 'key=' + randomBytes(24).toString('hex'));
  await mg('group', 'add', 'Acceptance route', 'models=acceptance/' + models[0], 'routing=order');
  await mg('library', 'mcp', 'router', 'off');
  await mg('library', 'skill', 'router', 'off');
  webAddress = mode !== '--cli' && mode !== '--preflight' ? '127.0.0.1:' + await port() : undefined;
  if (webAddress) env.MAGPIE_WEB_KEY = randomBytes(24).toString('hex');
  await startHost();
  const catalog = await (await gateway('/v1/models')).json();
  for (const id of [...models.map(model => 'acceptance/' + model), group]) {
    check(catalog.data.some(model => model.id === id), 'resident gateway did not expose ' + id);
  }
  await probeGateway();
  await conversation(models[1], ['--no-mcp']);
  pass('installed binary versions, resident gateway routed a fixture request, and original Oleafly CLI model worked');
  stage = 'native MCP and Library fixture setup';
  writePluginTool();
  await mg('plugin', 'add', pluginFixture);
  await refreshHost();
  await mg('library', 'mcp', 'add', 'stdioprobe', process.execPath, fixtureScript, 'stdio', 'stdioprobe', 'agents=none');
  await mg('library', 'mcp', 'add', 'remoteprobe', fixture.base + '/mcp', 'agents=none');
  await mg('library', 'mcp', 'router', 'remoteprobe', 'direct');
  await mg('library', 'mcp', 'add', blockedTool, process.execPath, fixtureScript, 'stdio', blockedTool, 'agents=none');
  await eventually(() => library().mcp?.some(entry => entry.name === pluginFixtureName), 'Library did not register the plugin-provided tool server');
  writeSkill(dir('home/.agents/skills/' + skill), 'library-skill-v1');
  await mg('library', 'skill', 'hand-over', skill);
  await mg('library', 'skill', 'agents', skill, 'none');
  writeSkill(skillDestination, 'user-skill-receipt');
  pass('Magpie loaded the fixture tool plugin and registered the local Library items');
  if (mode === '--preflight') {
    const pluginURL = library().mcp.find(entry => entry.name === pluginFixtureName).url;
    replaceConfig({ ...original, mcp_servers: [
      stdio('stdioprobe'),
      { name: 'remoteprobe', transport: 'remote', url: fixture.base + '/mcp' },
      { name: pluginFixtureName, transport: 'remote', url: pluginURL },
    ] });
    await conversation(models[1], mcpPermissions,
      tools.map(name => ({ name, marker: toolMarker(name) })));
    pass('native Oleafly CLI executed the stdio, HTTP and Magpie plugin tool fixtures');
  }
  if (mode !== '--preflight') {
    stage = 'local package installation and detection';
    check(existsSync(packageManifest) && json(packageManifest).magpie?.agent, 'Oleafly plugin package manifest is unavailable');
    await pluginAction('add');
    const plugins = JSON.parse(await mg('plugin', 'list', '--json'));
    check(plugins.loaded?.length && plugins.loaded.every(entry => !(entry.Error || entry.error)),
      'Magpie reported an installed plugin host error');
    const rows = (await mg('ls')).split('\n').filter(line => /^\s+Oleafly\b/i.test(line));
    check(rows.length === 1, 'Magpie did not list exactly one detected Oleafly agent');
    check(config().ai_provider === original.ai_provider && config().ai_model === original.ai_model,
      'plugin installation changed the selected Oleafly model');
    pass('Magpie Plugins installed the package and Agents detected one Oleafly row');
    if (webAddress) await scenario('Magpie web controls', () => exerciseWeb(original));
    if (mode === '--gui') {
      const launcher = dir('magpie-web.html');
      writeFileSync(launcher, '<!doctype html><form method="post" action="http://' +
        webAddress + '/_magpie/sign-in"><input type="hidden" name="key" value="' + env.MAGPIE_WEB_KEY +
        '"><button>Open isolated Magpie</button></form>\n', { mode: 0o600 });
      console.log('READY  Open ' + launcher + ' in a browser. Stop with Ctrl-C.');
      console.log('       Oleafly fixture data directory: ' + env.OLEAFLY_DATA_DIR);
      console.log('       Fixture project: ' + dir('project'));
      await Promise.race([stopSignal, host.done]);
    } else {
      stage = 'first connection and Usage attribution';
      const first = 'acceptance/' + models[0];
      check(/new conversation|reopen/i.test(await setModel(first)), 'Magpie CLI did not return the restart notice');
      const managed = config().ai_provider;
      check(managed !== original.ai_provider, 'managed selection reused the original provider ID');
      await conversation(models[0], ['--no-mcp']);
      await eventually(async () => /\n\s+Oleafly\s+[^\n]*\b[1-9]\d* calls?\b/i.test(await mg('usage')),
        'Magpie Usage did not attribute the fixture request to Oleafly');
      pass('first CLI run used the nondefault Magpie port and appeared under Oleafly in Usage');

      stage = 'switch and resident restart';
      await setModel('acceptance/' + models[1]);
      await conversation(models[1], ['--no-mcp']);
      await setModel(group);
      await conversation(models[0], ['--no-mcp']);
      await mg('library', 'sync');
      await stopHost();
      await startHost();
      await refreshHost();
      await conversation(models[0], ['--no-mcp']);
      check(config().ai_custom_providers.filter(entry => entry.id === managed).length === 1, 'managed provider was duplicated');
      check(JSON.stringify(config().ai_tools_model) === JSON.stringify(original.ai_tools_model), 'Tools model override changed');
      pass('second model, routing group, sync and resident restart kept one provider and the Tools model');

      stage = 'Library MCP assignment and Router modes';
      for (const name of ['stdioprobe', 'remoteprobe', pluginFixtureName]) await mg('library', 'mcp', 'agents', name, 'oleafly');
      await mcpMatrix(false);
      pass('Router off executed assigned stdio, HTTP and plugin tools and rejected an unassigned call');
      await mcpMatrix(true);
      pass('Router on executed scoped hub tools, retained the direct HTTP entry and rejected an unassigned call');

      await scenario('skill copy and collision', async () => {
        const collision = await mg('library', 'skill', 'agents', skill, 'oleafly');
        check(copyIs('user-skill-receipt') && /of its own|keep the agent's/i.test(collision),
          'same-name skill collision was not preserved or reported');
        await mg('library', 'skill', 'keep-own', skill, 'oleafly');
        check(copyIs('user-skill-receipt'), 'Keep own changed the user skill');
        await mg('library', 'skill', 'agents', skill, 'oleafly');
        await mg('library', 'skill', 'use-library', skill, 'oleafly');
        check(copyIs('library-skill-v1'), 'assigned skill was not copied as a directory with its reference');
        check(library().skillHow?.oleafly === 'copy' && !library().copySkills, 'skill copy setting was not scoped to Oleafly');
        const skillsRoot = dir('xdg-config/magpie/library/skills');
        const librarySkill = path.join(skillsRoot, skill);
        check(readdirSync(librarySkill).includes('references'), 'handed-over Library skill is missing its reference folder');
        writeFileSync(path.join(librarySkill, referenceFile), 'library-skill-v2\n');
        await mg('library', 'sync');
        check(copyIs('library-skill-v2'), 'Library sync did not refresh the changed reference');
        await conversation(models[0], ['--no-mcp', '--skill', skill], [
          { name: 'load_skill', args: { id: skill }, marker: skill },
          { name: 'read_skill_file', args: { id: skill, path: referenceFile }, marker: 'library-skill-v2' },
        ]);
        await mg('library', 'skill', 'agents', skill, 'none');
        check(!existsSync(skillDestination) || copyIs('user-skill-receipt'), 'removing the assignment left a managed skill');
        const backups = dir('xdg-config/magpie/backups');
        check(copyIs('user-skill-receipt') || (existsSync(backups) && readdirSync(backups).some(stamp => {
          const saved = path.join(backups, stamp, 'oleafly', 'skills', skill, referenceFile);
          return existsSync(saved) && readFileSync(saved, 'utf8').trim() === 'user-skill-receipt';
        })), 'Magpie did not preserve the replaced user skill');
        pass('Library collision handling, real skill copy, and updated reference read by Oleafly CLI');
      });

      await scenario('interrupted configuration sync', async () => {
        await interruptBeforeWrite(group, first);
        await conversation(models[0], ['--no-mcp']);
        pass('held Oleafly config lock preserved valid bytes, and resident restart applied the pending model');
      });

      await scenario('unavailable gateway and recovery', async () => {
        const before = readFileSync(configPath);
        const second = 'acceptance/' + models[1];
        await run(magpie, ['oleafly', second], { ...env, MAGPIE_ADDR: new URL(fixture.base).host });
        await eventually(() => /\[Oleafly\].*cannot reach the selected Magpie gateway/i.test(host.diagnostics),
          'resident Magpie did not report the unavailable gateway');
        check(readFileSync(configPath).equals(before), 'unavailable gateway replaced the last valid config');
        await setModel(second);
        await conversation(models[1], ['--no-mcp']);
        pass('unavailable gateway retained the valid config and the CLI recovered after reselection');
      });

      stage = 'default with independent Library assignments';
      await resetModel(original);
      check(config().ai_custom_providers.length === 1 && mcp('magpie') && mcp('remoteprobe'),
        'model reset left a managed provider or removed assigned MCP');
      await conversation(models[1], ['--no-mcp']);
      pass('Agent default restored the original usable model and retained Library assignments');

      stage = 'later edits and conflict visibility';
      await setModel(group);
      const edited = config();
      const laterProvider = { ...original.ai_custom_providers[0], id: 'local-later', name: 'Later fixture provider' };
      edited.ai_custom_providers.push(laterProvider);
      edited.ai_provider_models[laterProvider.id] = original.ai_provider_models[original.ai_provider];
      edited.ai_provider = laterProvider.id;
      edited.ai_model = models[1];
      edited.mcp_servers.find(entry => entry.name === 'unrelated').args = stdio('editedprobe').args;
      replaceConfig(edited);
      await mg('oleafly', 'default');
      await refreshHost();
      await eventually(() => config().ai_custom_providers.length === 2 && config().ai_provider === laterProvider.id &&
        config().ai_model === models[1], 'disconnect replaced later provider or chat edits');
      check(mcp('unrelated').args.includes('editedprobe'), 'disconnect replaced the unrelated MCP edit');
      await conversation(models[1], ['--no-mcp']);
      await scenario('manual edit conflict report', async () => {
        await eventually(() => /\[Oleafly\].*chat model changed outside Magpie/i.test(host.diagnostics),
          'resident Magpie did not report the preserved chat conflict');
        pass('disconnect reported and kept the later chat choice, new provider and unrelated MCP edit');
      });

      stage = 'plugin disable';
      const later = config();
      await setModel(group);
      await detached(later, 'off');
      pass('resident plugin disable restored the later usable model and removed owned MCP and skill entries');
      stage = 'plugin re-enable and uninstall';
      await pluginAction('on');
      // This makes the still-running Magpie reload its plugin catalog after a CLI list change.
      await refreshHost();
      check((await mg('ls')).split('\n').filter(line => /^\s+Oleafly\b/i.test(line)).length === 1,
        're-enable did not restore the detected agent');
      try {
        await setModel(group);
      } catch (error) {
        fail('re-enable in the running host', error);
        try {
          await callResidentPluginTool();
          await eventually(() => config().ai_model === group, 'a resident plugin tool call did not recover the connection');
          pass('a real plugin tool call woke the resident host and applied the pending selection');
        } catch {
          await stopHost();
          await startHost();
          await setModel(group);
          pass('a resident restart recovered the re-enabled connection');
        }
      }
      await conversation(models[0], ['--no-mcp']);
      await detached(later, 'rm');
      pass('resident uninstall removed owned MCP and skill entries and left the later provider usable');
    }
  }
} catch (error) {
  fail(stage, error);
} finally {
  await stopHost();
  fixture?.close();
  rmSync(root, { force: true, recursive: true });
}
if (failures) process.exitCode = 1;
