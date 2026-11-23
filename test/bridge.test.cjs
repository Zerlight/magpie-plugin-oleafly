const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModel, installedSpecs, gatewayAvailable } = require('../bridge.cjs');

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
