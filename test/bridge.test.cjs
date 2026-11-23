const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { createHash } = require('node:crypto');
const { reconcile, cancelPendingRemoval } = require('../reconcile.cjs');
const { readModel, installedSpecs, gatewayAvailable, startBridge } = require('../bridge.cjs');

function folder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oleafly-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('malformed model staging keeps credential-bearing parser errors private', (t) => {
  const file = path.join(folder(t), 'agent.json');
  assert.equal(readModel(file), null);
  for (const contents of ['{"gatewayKey":"fixture-password"!', '{"gatewayKey":"fixture-password","baseURL":"https://private:fixture-password@example.com"}']) {
    fs.writeFileSync(file, contents);
    assert.throws(() => readModel(file), error => /Oleafly model selection/.test(error.message) && !error.message.includes('fixture-password'));
  }
  fs.writeFileSync(file, '{}');
  assert.equal(readModel(file), null);
});

test('recognizes local, versioned npm and Git install specs by package directory', (t) => {
  const root = folder(t);
  const store = path.join(root, 'plugins');
  const pkg = path.join(store, 'node_modules', 'magpie-plugin-oleafly');
  fs.mkdirSync(pkg, { recursive: true });
  const git = 'github:example/magpie-plugin-oleafly';
  fs.writeFileSync(path.join(store, 'package.json'), JSON.stringify({ dependencies: { 'magpie-plugin-oleafly': git } }));
  const specs = [pkg, 'magpie-plugin-oleafly@0.1.0', git];
  fs.writeFileSync(path.join(root, 'plugins.json'), JSON.stringify({ plugins: [...specs, 'another-plugin'].map(spec => ({ spec })) }));
  assert.deepEqual(installedSpecs(root, pkg), new Set(specs));
});

test('gateway check uses Magpie identity, a bounded request and no credentials', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.href, 'http://127.0.0.1:4551/api/hello');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined);
    return Response.json({ name: 'magpie' });
  });
  assert.equal(await gatewayAvailable('http://127.0.0.1:4551/v1/'), true);
  globalThis.fetch.mock.mockImplementation(async () => Response.json({ name: 'other' }));
  assert.equal(await gatewayAvailable('http://127.0.0.1:4551/v1'), false);
});

test('retries a failed Library sync after establishing the copy link', (t) => {
  const root = folder(t);
  const prior = { HOME: process.env.HOME, OLEAFLY_DATA_DIR: process.env.OLEAFLY_DATA_DIR };
  process.env.HOME = root;
  process.env.OLEAFLY_DATA_DIR = path.join(root, 'data');
  fs.mkdirSync(process.env.OLEAFLY_DATA_DIR);
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  fs.writeFileSync(path.join(root, 'plugins.json'), JSON.stringify({ plugins: [{ spec: path.dirname(__dirname) }] }));
  fs.writeFileSync(path.join(root, 'library.json'), JSON.stringify({ skillHow: { oleafly: 'copy' } }));
  let time = 10000, tick;
  const callbacks = [];
  t.mock.method(Date, 'now', () => time);
  t.mock.method(globalThis, 'setInterval', fn => { tick = fn; return { unref() {} }; });
  t.mock.method(childProcess, 'execFile', (_bin, args, _options, done) => {
    assert.deepEqual(args, ['library', 'sync']);
    callbacks.push(done);
  });
  const stop = startBridge(root, () => {});
  try {
    assert.equal(callbacks.length, 1);
    callbacks[0](new Error('busy'));
    tick();
    assert.equal(callbacks.length, 1);
    time += 5000;
    tick();
    assert.equal(callbacks.length, 2);
    callbacks[1](null);
    time += 5000;
    tick();
    assert.equal(callbacks.length, 2);
  } finally { stop(); }
});

test('an old removal respects re-enablement, cancellation, and later native edits', (t) => {
  const root = folder(t);
  const config = path.join(root, 'config.json');
  const note = path.join(root, '.magpie-oleafly-cleanup.txt');
  const list = path.join(root, 'plugins.json');
  const spec = 'magpie-plugin-oleafly';
  const ticket = 'a'.repeat(32);
  const pending = () => fs.writeFileSync(note, ticket + '\nPending cleanup.\n');
  const finish = () => {
    const result = childProcess.spawnSync(process.execPath, ['-', root, root, ticket,
      createHash('sha256').update(spec).digest('hex')], { input: fs.readFileSync(require.resolve('../reconcile.cjs')) });
    assert.equal(result.status, 0, result.stderr.toString());
  };
  reconcile({ dataDir: root, model: { id: 'selected', baseURL: 'http://localhost:3499/v1' } });
  const active = fs.readFileSync(config, 'utf8');
  fs.writeFileSync(list, JSON.stringify({ plugins: [{ spec }] }));
  pending();
  finish();
  assert.equal(fs.existsSync(note), false);
  assert.equal(fs.readFileSync(config, 'utf8'), active);
  fs.writeFileSync(list, JSON.stringify({ plugins: [] }));
  pending();
  cancelPendingRemoval(root);
  finish();
  assert.equal(fs.readFileSync(config, 'utf8'), active);
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(active), ai_provider: 'openai', ai_model: 'later' }));
  pending();
  finish();
  assert.equal(JSON.parse(fs.readFileSync(config)).ai_model, 'later');
  assert.match(fs.readFileSync(note, 'utf8'), /chat model changed outside Magpie/);
});
