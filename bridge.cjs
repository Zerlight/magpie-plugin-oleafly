'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { removeSkillCopies } = require('./skills.cjs');
const { homedir } = require('node:os');
const { reconcile, deferRemoval, retryPendingRemoval, cancelPendingRemoval } = require('./reconcile.cjs');
const { translateMcp } = require('./mcp.cjs');

function json(file, label) {
  let bytes;
  try {
    bytes = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${label}. Check its permissions and retry.`);
  }
  try {
    const value = JSON.parse(bytes);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* Parser messages can contain credentials. */ }
  throw new Error(`Invalid ${label}. Repair the JSON and retry.`);
}

function pluginList(directory) {
  const rows = json(path.join(directory, 'plugins.json'), 'the Magpie plugin list')?.plugins;
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.spec !== 'string')) {
    throw new Error('Cannot identify the Oleafly plugin in Magpie. Refresh the Plugins page.');
  }
  return rows;
}

// Capture the install spec before Magpie removes an npm or Git dependency on uninstall.
function installedSpecs(directory, packageDir) {
  const deps = path.join(directory, 'plugins');
  const dependencies = json(path.join(deps, 'package.json'), 'the Magpie package manifest')?.dependencies ?? {};
  const root = fs.realpathSync(packageDir);
  return new Set(pluginList(directory).filter(({ spec }) => {
    let location = spec.replace(/^file:\/\//, '');
    if (!path.isAbsolute(location)) {
      const dep = Object.keys(dependencies).find(name => dependencies[name] === spec);
      const name = dep ?? spec.replace(/(?!^)@[^/]*$/, '');
      if (!/^(@[\w.-]+\/)?[\w-][\w.-]*$/.test(name)) return false;
      location = path.join(deps, 'node_modules', name);
    }
    try { return fs.realpathSync(location) === root; }
    catch { return false; }
  }).map(({ spec }) => spec));
}

function readModel(file) {
  const raw = json(file, 'the Oleafly model selection');
  if (!raw || !Object.keys(raw).length) return null;
  let url;
  try { url = new URL(raw.baseURL); } catch { /* Report the item without its contents. */ }
  if (raw.agentId !== 'oleafly' || !url || !['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/v1' ||
      !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(url.hostname) ||
      typeof raw.model !== 'string' || !raw.model.trim() || /[\x00-\x1f\x7f]/.test(raw.model) ||
      raw.gatewayKey !== 'magpie-oleafly') {
    throw new Error('Invalid Oleafly model selection. Select the model again on the Magpie Agents page.');
  }
  return { id: raw.model, baseURL: url.href, apiKey: raw.gatewayKey };
}

function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(dir);
  if (!info.isDirectory() || (process.platform !== 'win32' && info.uid !== process.getuid())) {
    throw new Error('Cannot use the Oleafly staging directory. Check its owner and remove any symbolic link.');
  }
  if (process.platform === 'win32') {
    const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const command = fs.readFileSync(path.join(__dirname, 'windows-host.ps1'), 'utf8');
    const result = childProcess.spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...process.env, MAGPIE_OLEAFLY_STAGE: dir, MAGPIE_OLEAFLY_PARENT: String(process.ppid) },
      encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    if (result.status !== 0) throw new Error('Cannot secure the Oleafly staging folder. Check its Windows owner and permissions.');
    return JSON.parse(result.stdout.trim());
  }
  if (info.mode & 0o077) fs.chmodSync(dir, 0o700);
}

function desktopDirectories(home, env) {
  if (process.platform !== 'linux') return [];
  const roots = [env.XDG_DATA_HOME || path.join(home, '.local/share'),
    ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')];
  return roots.filter(root => path.isAbsolute(root)).map(root => path.join(root, 'applications'));
}

function directoryNames(dir) {
  try { return fs.readdirSync(dir); }
  catch { return []; } // An unavailable launcher is not evidence of an installation.
}

function executableFile(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch { return false; }
}

function executableOnPath(command) {
  if (path.isAbsolute(command)) return executableFile(command);
  if (!command || command.includes('/')) return false;
  return (process.env.PATH || '').split(path.delimiter).some(dir => dir && executableFile(path.join(dir, command)));
}

let registry;
function hasWindowsRegistration(protocol = 'oleafly') {
  if (process.platform !== 'win32') return false;
  registry ??= require('bun:ffi').dlopen('advapi32.dll', {
    RegGetValueW: { args: ['isize', 'ptr', 'ptr', 'u32', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
  });
  const subkey = Buffer.from(protocol + '\\shell\\open\\command\0', 'utf16le');
  const data = Buffer.alloc(65536); // Maximum Win32 command line in UTF-16.
  const size = new Uint32Array([data.length]);
  const status = registry.symbols.RegGetValueW(-2147483648n /* HKEY_CLASSES_ROOT */, subkey, null,
    6 /* REG_SZ or REG_EXPAND_SZ */, null, data, size);
  if (status !== 0) return false;
  const program = /^"([^"]+\\oleafly\.exe)"/i.exec(data.toString('utf16le', 0, size[0]))?.[1];
  return !!program && path.isAbsolute(program) && executableFile(program);
}

function desktopString(value) {
  const escapes = { s: ' ', t: '\t', n: '\n', r: '\r', '\\': '\\' };
  return value.replace(/\\([stnr\\])/g, (_, key) => escapes[key]);
}

function hasLaunchTarget(section) {
  const tryExec = /^TryExec=([^\r\n]*)/m.exec(section);
  if (tryExec && !executableOnPath(desktopString(tryExec[1].trim()))) return false;
  const exec = /^Exec=([^\r\n]*)/m.exec(section);
  if (!exec) return false;
  // Desktop entries quote the program separately from arguments such as %F.
  const word = /^(?:"((?:[^"\\]|\\.)*)"|([^\s"]+))(?=\s|$)/.exec(desktopString(exec[1].trim()));
  if (!word) return false;
  const program = word[1] === undefined ? word[2] : word[1].replace(/\\(["`$\\])/g, '$1');
  return executableOnPath(program.replace(/%%/g, '%'));
}

function hasDesktopEntry(dirs) {
  const seen = new Set();
  for (const dir of dirs) {
    for (const name of directoryNames(dir)) {
      if (!/oleafly.*\.desktop$/i.test(name) || seen.has(name)) continue;
      seen.add(name);
      const file = path.join(dir, name);
      let contents;
      try {
        if (!fs.statSync(file).isFile()) continue;
        contents = fs.readFileSync(file, 'utf8');
      } catch { continue; }
      const section = contents.split(/^\[Desktop Entry\][ \t]*\r?$/m)[1]?.split(/^\[/m, 1)[0] || '';
      if (/^Type=Application\s*$/m.test(section) && /^Name=Oleafly\s*$/im.test(section) &&
          !/^Hidden=true\s*$/im.test(section) && hasLaunchTarget(section)) return true;
    }
  }
  return false;
}

function hasAppImage(dir) {
  return directoryNames(dir).some(name => {
    if (!/^oleafly(?:[-_. ][\w. -]+)?\.appimage$/i.test(name)) return false;
    return executableFile(path.join(dir, name));
  });
}

function magpieCommand(parentPath) {
  if (process.platform === 'win32' && parentPath && path.isAbsolute(parentPath) &&
      /^magpie(?:-cli)?(?:-windows-(?:amd64|arm64))?(?:\.real)?\.exe$/i.test(path.basename(parentPath))) return parentPath;
  if (process.platform === 'linux') {
    // Magpie starts the Bun host directly, including when the desktop launcher is outside PATH.
    const parent = `/proc/${process.ppid}/exe`;
    try {
      const name = path.basename(fs.readlinkSync(parent)).replace(/ \(deleted\)$/, '');
      if (/^magpie(?:-cli)?(?:-linux-(?:arm64|amd64))?(?:\.real)?$/i.test(name)) return parent;
    } catch { /* Hosts without procfs use PATH. */ }
  }
  const app = '/Applications/magpie.app/Contents/MacOS/magpie';
  return process.platform === 'darwin' && fs.existsSync(app) ? app : 'magpie';
}

function linkSkills(stage, dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('Oleafly’s skills folder must be a real directory. Review it before syncing skills.');
  const link = path.join(stage, 'skills');
  const current = fs.lstatSync(link, { throwIfNoEntry: false });
  if (current?.isSymbolicLink() && pointsToSkills(link, dir)) return false;
  if (current && !current.isSymbolicLink()) {
    if (!current.isDirectory() || fs.readdirSync(link).length) {
      throw new Error('The Magpie skill staging path is occupied. Move the existing staging folder aside and retry.');
    }
    fs.rmdirSync(link);
  }
  if (current?.isSymbolicLink()) fs.unlinkSync(link);
  fs.symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
  return true;
}

function pointsToSkills(link, dir) {
  const target = fs.readlinkSync(link);
  return path.isAbsolute(target) && path.relative(target, dir) === '';
}

async function gatewayAvailable(baseURL) {
  try {
    const endpoint = new URL(baseURL);
    endpoint.pathname = endpoint.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '') + '/api/hello';
    const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(2000) });
    return response.ok && (await response.json()).name === 'magpie';
  } catch { return false; }
}

function startBridge(directory, report) {
  const home = homedir();
  const stage = path.join(home, '.magpie-oleafly');
  const dataDir = path.resolve(process.env.OLEAFLY_DATA_DIR || path.join(home, '.oleafly'));
  const modelFile = path.join(stage, 'agent.json');
  const mcpFile = path.join(stage, 'mcp.json');
  const libraryFile = path.join(directory, 'library.json');
  const skillsDir = path.join(dataDir, 'skills');
  const bundles = process.platform === 'darwin' ? ['/Applications/Oleafly.app', path.join(home, 'Applications/Oleafly.app')] : [];
  const applications = desktopDirectories(home, process.env);
  const images = path.join(home, 'Applications');
  const desktop = path.join(stage, 'desktop');
  const librarySkillsDir = path.join(directory, 'library', 'skills');
  const specs = installedSpecs(directory, __dirname);
  if (!specs.size) throw new Error('Cannot identify the running Oleafly plugin. Refresh it on the Magpie Plugins page.');
  const windowsHost = privateDirectory(stage);
  const windowsApps = process.platform === 'win32' ? [
    ...[process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).map(root => path.join(root, 'Oleafly/oleafly.exe')),
    ...(process.env.LOCALAPPDATA ? ['Programs/Oleafly/oleafly.exe', 'Oleafly/bin/oleafly.exe']
      .map(file => path.join(process.env.LOCALAPPDATA, file)) : []),
  ] : [];
  const enabled = () => pluginList(directory).some(row => specs.has(row.spec) && !row.off);
  if (process.platform === 'win32') {
    const notice = retryPendingRemoval(dataDir, directory, specs);
    if (notice) report(notice);
  } else if (enabled()) cancelPendingRemoval(dataDir);
  const cleanupSource = process.platform === 'win32' ? undefined : fs.openSync(require.resolve('./reconcile.cjs'), 'r');
  const watched = [stage, desktop, dataDir, modelFile, mcpFile, libraryFile, skillsDir, path.join(directory, 'plugins.json'),
    path.join(dataDir, 'config.json'), path.join(dataDir, 'ai-secrets.json'), path.join(dataDir, 'mcp-server-secrets.json')];
  function signature() {
    return watched.map(file => {
      const info = fs.statSync(file, { throwIfNoEntry: false });
      return info ? [info.ino, info.ctimeMs, info.mtimeMs, info.size].join('/') : '';
    }).join('|');
  }

  let lastIssues = '';
  function publish(issues) {
    const notice = [...new Set(issues)].join('\n');
    if (notice && notice !== lastIssues) report(notice);
    lastIssues = notice;
  }

  let verified, probing, nextProbe = 0;
  let previous;
  let desktopPresent = false, cliPresent = false, nextDiscovery = 0;
  let retryDesktop = false;
  let stopped = false;
  function verifiedModel(model, issues, exiting) {
    if (!model) { verified = undefined; nextProbe = 0; return null; }
    const id = JSON.stringify([model.baseURL, model.id]);
    if (verified === id) return model;
    if (!exiting && !probing && Date.now() >= nextProbe) {
      probing = id;
      gatewayAvailable(model.baseURL).then(ok => {
        if (ok) { verified = id; nextProbe = 0; }
        else nextProbe = Date.now() + 2500;
        probing = undefined;
        previous = undefined;
        if (!stopped) tick();
      });
    }
    if (nextProbe > Date.now()) issues.push('Oleafly cannot reach the selected Magpie gateway. Start the gateway or check its address. The connection will retry.');
    return undefined;
  }

  let settingSkills = false, skillRetry = 0, skillSetupIssue = '', recoverRetired = true;
  function skills(on, issues, exiting) {
    const library = json(libraryFile, 'the Magpie Library') ?? {};
    if (on && !exiting) {
      const newLink = linkSkills(stage, skillsDir);
      if ((newLink || skillRetry || library.skillHow?.oleafly !== 'copy') && !settingSkills && Date.now() >= skillRetry) {
        settingSkills = true;
        skillRetry = 0;
        const args = library.skillHow?.oleafly !== 'copy' ? ['skill', 'how', 'copy', 'oleafly'] : ['sync'];
        childProcess.execFile(magpieCommand(windowsHost?.parent), ['library', ...args], {
          env: { ...process.env, MAGPIE_OLEAFLY_SYNCING_SKILLS: '1' }, timeout: 30000, windowsHide: true,
        }, error => {
          settingSkills = false;
          skillRetry = error ? Date.now() + 5000 : 0;
          skillSetupIssue = error ? 'Magpie could not apply copy mode to Oleafly skills. Check the Oleafly agent on the Library page and retry.' : '';
          previous = undefined;
          if (!stopped) tick();
        });
      }
    }
    if (skillSetupIssue) issues.push(skillSetupIssue);
    if (on && !recoverRetired) return;
    const link = path.join(stage, 'skills');
    if (!on && fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() && pointsToSkills(link, skillsDir)) {
      fs.unlinkSync(link);
    }
    const result = removeSkillCopies({ skillsDir, librarySkillsDir, library, retiredOnly: on });
    recoverRetired = false;
    for (const issue of result.issues) issues.push(`Skill ${issue.name}. ${issue.message}`);
  }

  function tick(exiting = false) {
    const issues = [];
    try {
      const discoveryDue = Date.now() >= nextDiscovery;
      if (discoveryDue) {
        desktopPresent = bundles.some(bundle => fs.existsSync(bundle)) || windowsApps.some(executableFile) || fs.existsSync(path.join(dataDir, 'config.json')) ||
          executableFile(path.join(home, '.local/bin/oleafly')) || hasDesktopEntry(applications) ||
          (process.platform === 'linux' && hasAppImage(images)) ||
          executableOnPath(process.platform === 'win32' ? 'oleafly-cli.exe' : 'oleafly-cli') || hasWindowsRegistration();
        cliPresent = executableOnPath(process.platform === 'win32' ? 'oleafly.exe' : 'oleafly');
        nextDiscovery = Date.now() + 3000;
      }
      const current = [desktopPresent, cliPresent, signature()].join('|');
      const needsDesktopRetry = retryDesktop && discoveryDue;
      if (!exiting && previous === current && !needsDesktopRetry && !nextProbe && (!skillRetry || Date.now() < skillRetry)) return;
      const on = enabled();
      if (!on) fs.rmSync(mcpFile, { force: true });
      // Magpie checks the descriptor's dir even when the desktop app has no CLI on PATH.
      try {
        if (on && desktopPresent) fs.mkdirSync(desktop, { recursive: true, mode: 0o700 });
        else if (fs.lstatSync(desktop, { throwIfNoEntry: false })?.isDirectory() && !fs.readdirSync(desktop).length) fs.rmdirSync(desktop);
        retryDesktop = false;
      } catch {
        retryDesktop = true;
        issues.push('Cannot update the Oleafly desktop detection directory. Check ~/.magpie-oleafly/desktop.');
      }
      if (!desktopPresent && !cliPresent && !fs.existsSync(dataDir) && !fs.existsSync(modelFile)) {
        previous = current;
        publish(issues);
        return;
      }
      try { skills(on, issues, exiting); }
      catch (error) { issues.push(error.code ? 'Cannot access the Oleafly skills folder. Check its permissions and retry.' : error.message); }
      const result = reconcile({ dataDir, readDesired() {
        if (!enabled()) return { model: null, mcp: [] };
        let model, mcp;
        try { model = verifiedModel(readModel(modelFile), issues, exiting); }
        catch (error) { issues.push(error.message); }
        try {
          const rawAddr = process.env.MAGPIE_ADDR;
          const staged = translateMcp(json(mcpFile, 'the Oleafly MCP staging file'),
            json(libraryFile, 'the Magpie Library') ?? {}, { directory, gatewayUrl: rawAddr && 'http://' + rawAddr });
          mcp = staged.servers;
          for (const issue of staged.issues) issues.push(`MCP ${issue.name}. ${issue.message}`);
        } catch (error) { issues.push(error.message); }
        return { model, mcp };
      } });
      for (const conflict of result.conflicts) issues.push(conflict.message);
      if (result.changed && on && !issues.length && !exiting) {
        report('Oleafly settings updated. Reopen Oleafly for a changed chat model. Reopen Assistant MCP settings to refresh the server list.', 'info');
      }
      previous = current;
    } catch (error) {
      if (exiting && error.code === 'OLEAFLY_BUSY' && !enabled()) {
        const notice = deferRemoval(dataDir, directory, specs, cleanupSource);
        if (notice) issues.push(notice);
      } else {
        issues.push(error.code && !error.code.startsWith('OLEAFLY')
          ? 'Cannot synchronize Oleafly. Check the configuration directory permissions and retry.' : error.message);
      }
      previous = undefined;
    }
    publish(issues);
  }

  tick();
  const timer = setInterval(tick, 500);
  timer.unref();
  function stop() {
    if (stopped) return;
    stopped = true;
    process.removeListener('exit', stop);
    clearInterval(timer);
    try { tick(true); }
    finally { if (cleanupSource !== undefined) fs.closeSync(cleanupSource); }
  }
  process.once('exit', stop);
  return stop;
}

module.exports = { startBridge, readModel, installedSpecs, gatewayAvailable, hasDesktopEntry, hasAppImage, hasWindowsRegistration, magpieCommand };
