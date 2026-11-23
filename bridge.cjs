'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { removeSkillCopies } = require('./skills.cjs');
const { homedir } = require('node:os');
const { reconcile } = require('./reconcile.cjs');
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
  if (!info.isDirectory() || info.uid !== process.getuid()) {
    throw new Error('Cannot use the Oleafly staging directory. Check its owner and remove any symbolic link.');
  }
  if (info.mode & 0o077) fs.chmodSync(dir, 0o700);
}

function linkSkills(stage, dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('Oleafly’s skills folder must be a real directory. Review it before syncing skills.');
  const link = path.join(stage, 'skills');
  const current = fs.lstatSync(link, { throwIfNoEntry: false });
  if (current?.isSymbolicLink() && fs.readlinkSync(link) === dir) return false;
  if (current && !current.isSymbolicLink()) {
    if (!current.isDirectory() || fs.readdirSync(link).length) {
      throw new Error('The Magpie skill staging path is occupied. Move the existing staging folder aside and retry.');
    }
    fs.rmdirSync(link);
  }
  if (current?.isSymbolicLink()) fs.unlinkSync(link);
  fs.symlinkSync(dir, link);
  return true;
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
  const bundle = '/Applications/Oleafly.app';
  const librarySkillsDir = path.join(directory, 'library', 'skills');
  const specs = installedSpecs(directory, __dirname);
  if (!specs.size) throw new Error('Cannot identify the running Oleafly plugin. Refresh it on the Magpie Plugins page.');
  privateDirectory(stage);
  const enabled = () => pluginList(directory).some(row => specs.has(row.spec) && !row.off);
  const watched = [modelFile, mcpFile, libraryFile, skillsDir, path.join(directory, 'plugins.json'),
    path.join(dataDir, 'config.json'), path.join(dataDir, 'ai-secrets.json'), path.join(dataDir, 'mcp-server-secrets.json')];
  function signature() {
    return watched.map(file => {
      const info = fs.statSync(file, { throwIfNoEntry: false });
      return info ? [info.ino, info.ctimeMs, info.size].join('/') : '';
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

  let settingSkills = false, skillRetry = 0, skillSetupIssue = '';
  function skills(on, issues, exiting) {
    const library = json(libraryFile, 'the Magpie Library') ?? {};
    if (on && !exiting) {
      const newLink = linkSkills(stage, skillsDir);
      if ((newLink || library.skillHow?.oleafly !== 'copy') && !settingSkills && Date.now() >= skillRetry) {
        settingSkills = true;
        const app = '/Applications/magpie.app/Contents/MacOS/magpie';
        const args = library.skillHow?.oleafly !== 'copy' ? ['skill', 'how', 'copy', 'oleafly'] : ['sync'];
        execFile(fs.existsSync(app) ? app : 'magpie', ['library', ...args], {
          env: { ...process.env, MAGPIE_OLEAFLY_SYNCING_SKILLS: '1' }, timeout: 30000,
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
    if (on) return;
    const link = path.join(stage, 'skills');
    if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() && fs.readlinkSync(link) === skillsDir) {
      fs.unlinkSync(link);
    }
    const result = removeSkillCopies({ skillsDir, librarySkillsDir, library });
    for (const issue of result.issues) issues.push(`Skill ${issue.name}. ${issue.message}`);
  }

  function tick(exiting = false) {
    const issues = [];
    try {
      const current = signature();
      if (!exiting && previous === current && !nextProbe && !skillRetry) return;
      const on = enabled();
      const installed = fs.existsSync(bundle) || fs.existsSync(dataDir) || fs.existsSync(modelFile) ||
        fs.existsSync(path.join(home, '.local/bin/oleafly')) ||
        process.env.PATH?.split(path.delimiter).some(dir => fs.existsSync(path.join(dir, 'oleafly')));
      if (!installed) return;
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
            json(libraryFile, 'the Magpie Library') ?? {}, { gatewayUrl: rawAddr && 'http://' + rawAddr });
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
      issues.push(error.code && !error.code.startsWith('OLEAFLY')
        ? 'Cannot synchronize Oleafly. Check the configuration directory permissions and retry.' : error.message);
      previous = undefined;
    }
    publish(issues);
  }

  tick();
  const timer = setInterval(tick, 500);
  timer.unref();
  function stop() {
    stopped = true;
    clearInterval(timer);
    tick(true);
  }
  process.once('exit', stop);
  return stop;
}

module.exports = { startBridge, readModel, installedSpecs, gatewayAvailable };
