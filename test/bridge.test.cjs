const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { createHash } = require('node:crypto');
const { reconcile, cancelPendingRemoval } = require('../reconcile.cjs');
const { readModel, installedSpecs, gatewayAvailable, startBridge, hasDesktopEntry, hasAppImage, hasWindowsRegistration, magpieCommand } = require('../bridge.cjs');

function folder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oleafly-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Linux desktop detection requires a usable launcher and honors hidden entries', { skip: process.platform === 'win32' }, t => {
  const root = folder(t);
  const apps = path.join(root, 'applications');
  fs.mkdirSync(apps);
  const entry = 'appimagekit-oleafly.desktop';
  const target = path.join(root, 'desktop executable');
  const fields = '[Desktop Entry]\nType=Application\nName=Oleafly\n';
  const launcher = exec => fs.writeFileSync(path.join(apps, entry), fields + exec);
  launcher(`Exec="${target}" %F\n`);
  assert.equal(hasDesktopEntry([apps]), false);
  fs.writeFileSync(target, '', { mode: 0o600 });
  assert.equal(hasDesktopEntry([apps]), false);
  fs.chmodSync(target, 0o700);
  assert.equal(hasDesktopEntry([root, apps]), true);
  launcher(`TryExec=${target}.missing\nExec="${target}" %F\n`);
  assert.equal(hasDesktopEntry([apps]), false);
  launcher(`TryExec=${target}\nExec="${apps}"\n`);
  assert.equal(hasDesktopEntry([apps]), false);
  launcher(`TryExec=${target}\n[Desktop Action Launch]\nExec="${target}"\n`);
  assert.equal(hasDesktopEntry([apps]), false);
  const prior = process.env.PATH;
  try {
    process.env.PATH = root;
    fs.symlinkSync(target, path.join(root, 'oleafly-desktop'));
    launcher('TryExec=oleafly-desktop\nExec=oleafly-desktop %U\n');
    assert.equal(hasDesktopEntry([apps]), true);
  } finally {
    if (prior === undefined) delete process.env.PATH;
    else process.env.PATH = prior;
  }
  launcher(`Exec="${target}" %F\n`);
  fs.writeFileSync(path.join(root, entry), '[Desktop Entry]\nHidden=true\n');
  assert.equal(hasDesktopEntry([root, apps]), false);
});

test('Linux AppImage detection requires an executable file', { skip: process.platform === 'win32' }, t => {
  const root = folder(t);
  const image = path.join(root, 'Oleafly_0.4.13_aarch64.AppImage');
  fs.writeFileSync(image, '', { mode: 0o600 });
  assert.equal(hasAppImage(root), false);
  fs.chmodSync(image, 0o700);
  assert.equal(hasAppImage(root), true);
});

test('Windows detects a protocol registered after discovery starts', { skip: process.platform !== 'win32' }, t => {
  const root = folder(t);
  const protocol = path.basename(root);
  const regKey = 'HKCU\\Software\\Classes\\' + protocol;
  const exe = path.join(root, '安装目录', 'oleafly.exe');
  fs.mkdirSync(path.dirname(exe));
  fs.writeFileSync(exe, '');
  assert.equal(hasWindowsRegistration(protocol), false);
  const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  childProcess.execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($env:TEST_REG_PATH); try { $k.SetValue('', ('"' + $env:TEST_DESKTOP + '" "%1"')) } finally { $k.Close() }`],
  { env: { ...process.env, TEST_REG_PATH: regKey.slice(5) + '\\shell\\open\\command', TEST_DESKTOP: exe } });
  t.after(() => childProcess.execFileSync(path.join(process.env.SystemRoot, 'System32/reg.exe'), ['delete', regKey, '/f']));
  assert.equal(hasWindowsRegistration(protocol), true);
  fs.unlinkSync(exe);
  assert.equal(hasWindowsRegistration(protocol), false);
});

test('Linux uses the running Magpie executable after renaming or upgrading it', { skip: process.platform !== 'linux' }, t => {
  const parent = `/proc/${process.ppid}/exe`;
  let name;
  t.mock.method(fs, 'readlinkSync', file => {
    assert.equal(file, parent);
    return '/opt/magpie/' + name;
  });
  for (name of ['magpie.real', 'magpie-linux-arm64 (deleted)', 'magpie.real (deleted)']) {
    assert.equal(magpieCommand(), parent);
  }
  name = 'other.real (deleted)';
  assert.equal(magpieCommand(), 'magpie');
});

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

function bridgeFixture(t) {
  const root = folder(t);
  const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, OLEAFLY_DATA_DIR: process.env.OLEAFLY_DATA_DIR };
  process.env.HOME = root;
  process.env.USERPROFILE = root;
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
  t.mock.method(Date, 'now', () => time);
  t.mock.method(globalThis, 'setInterval', fn => { tick = fn; return { unref() {} }; });
  return { root, advance(ms = 0) { time += ms; tick(); } };
}

test('discovery follows the native CLI when no desktop executable is available', { skip: process.platform === 'darwin' }, t => {
  const { root, advance } = bridgeFixture(t);
  const cli = path.join(root, process.platform === 'win32' ? 'oleafly-cli.exe' : 'oleafly-cli');
  const marker = path.join(root, '.magpie-oleafly', 'desktop');
  const priorPath = process.env.PATH;
  process.env.PATH = root;
  t.after(() => { process.env.PATH = priorPath; });
  const access = fs.accessSync;
  t.mock.method(fs, 'accessSync', (file, mode) => {
    if (mode === fs.constants.X_OK && file !== cli) throw new Error('No desktop or alias installed');
    return access(file, mode);
  });
  t.mock.method(childProcess, 'execFile', () => {});
  const stop = startBridge(root, () => {});
  try {
    assert.equal(fs.existsSync(marker), false);
    fs.writeFileSync(cli, '', { mode: 0o700 });
    advance(3000);
    assert.equal(fs.existsSync(marker), true);
    fs.unlinkSync(cli);
    advance(3000);
    assert.equal(fs.existsSync(marker), false);
  } finally { stop(); }
});

test('retries a failed Library sync after establishing the copy link', (t) => {
  const { root, advance } = bridgeFixture(t);
  const callbacks = [];
  t.mock.method(childProcess, 'execFile', (_bin, args, _options, done) => {
    assert.deepEqual(args, ['library', 'sync']);
    callbacks.push(done);
  });
  const stop = startBridge(root, () => {});
  try {
    assert.equal(callbacks.length, 1);
    callbacks[0](new Error('busy'));
    advance();
    assert.equal(callbacks.length, 1);
    advance(5000);
    assert.equal(callbacks.length, 2);
    callbacks[1](null);
    advance(5000);
    assert.equal(callbacks.length, 2);
  } finally { stop(); }
});

test('desktop detection recovers after a conflict or a transient directory error', t => {
  const { root, advance } = bridgeFixture(t);
  fs.writeFileSync(path.join(process.env.OLEAFLY_DATA_DIR, 'config.json'), '{}');
  const stage = path.join(root, '.magpie-oleafly');
  const marker = path.join(stage, 'desktop');
  fs.mkdirSync(stage, { mode: 0o700 });
  fs.writeFileSync(marker, 'existing file');
  t.mock.method(childProcess, 'execFile', () => {});
  const notices = [];
  const stop = startBridge(root, message => notices.push(message));
  try {
    advance(3000);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'existing file');
    assert.ok(notices.some(message => message.includes('desktop detection directory')));
    fs.unlinkSync(marker);
    advance(3000);
    assert.ok(fs.lstatSync(marker).isDirectory());
    advance();
    fs.rmdirSync(marker);
    const mkdir = fs.mkdirSync;
    let attempts = 0;
    t.mock.method(fs, 'mkdirSync', (dir, options) => {
      if (dir === marker && ++attempts === 1) throw new Error('temporarily unavailable');
      return mkdir(dir, options);
    });
    advance(3000);
    assert.equal(attempts, 1);
    assert.equal(fs.existsSync(marker), false);
    advance();
    assert.equal(attempts, 1);
    advance(3000);
    assert.ok(fs.lstatSync(marker).isDirectory());
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
