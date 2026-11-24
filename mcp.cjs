'use strict';

const { createHash } = require('node:crypto');
const { closeSync, openSync, readFileSync, readSync, statSync } = require('node:fs');
const { isIPv4 } = require('node:net');
const { homedir } = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const agent = 'oleafly';
const hubName = 'magpie';
const hubPath = '/mcp/magpie/hub';
const toolsPath = '/mcp/magpie/tools';
const protectedHeaders = new Set([
  'accept', 'connection', 'content-length', 'content-type', 'host',
  'mcp-method', 'mcp-name', 'mcp-protocol-version', 'mcp-session-id', 'transfer-encoding',
]);

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const serverName = (name) => name.length > 0 && name.length <= 64 && !/[^a-zA-Z0-9._-]/.test(name);

function httpUrl(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 8192 || !/^https?:\/\/[^/@?#]+(?:[/?]|$)/i.test(value) ||
      /[\x00-\x20\x7f\\#\p{Cs}]/u.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password) return null;
  const host = url.hostname;
  if (url.protocol === 'http:' && host !== 'localhost' && host !== '[::1]' && !(isIPv4(host) && host.startsWith('127.'))) return null;
  return url;
}

function pluginPrefix(plugin) {
  const short = plugin.split(/[/\\]/).at(-1).replace(/^(?:middleware|opencode|tools|page|agent)-(?=.)/, '').replace(/-auth$/, '');
  return (short.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '') || 'plugin').slice(0, 24);
}

function validateMap(values, kind) {
  if (!object(values) || Object.keys(values).length > 128) throw new Error(`Invalid MCP ${kind} map. Check it in Magpie Library.`);
  const names = new Set();
  for (const [key, value] of Object.entries(values)) {
    const header = key.toLowerCase();
    if (kind === 'header') {
      if (!key || /[^!#$%&'*+.^_`|~0-9A-Za-z-]/.test(key) || protectedHeaders.has(header) || header.startsWith('mcp-param-') || names.has(header)) {
        throw new Error('Invalid, duplicate, or reserved MCP header. Check the headers in Magpie Library.');
      }
      names.add(header);
    } else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error('Invalid MCP environment variable name. Check it in Magpie Library.');
    }
    if (typeof value !== 'string' || Buffer.byteLength(value) > 65536 || (kind === 'header' ? /[^\t\x20-\x7e]/ : /[\0\p{Cs}]/u).test(value)) {
      throw new Error(`Invalid MCP ${kind} value. Check it in Magpie Library.`);
    }
    if (value.includes('${') || value === '__stored__' || value.startsWith('__stored__:')) {
      throw new Error('Oleafly cannot resolve this staged MCP value. Route the server through Magpie or update the value in Library.');
    }
  }
}

function expandHome(value) {
  return value.replace(/^~(?=[/\\]|$)/, () => homedir());
}

// npxDirect selects the installed package's own bin under the Magpie host's working directory.
function cachedNpxMatches(directory, npx, args, command, stagedArgs) {
  if (!/(?:^|[/\\])npx(?:-cli)?(?:\.(?:js|cjs|mjs|cmd|bat|exe|ps1))?$/i.test(npx)) return false;
  const qualified = /[/\\]/.test(npx);
  const node = path.join(path.dirname(npx), qualified && process.platform === 'win32' ? 'node.exe' : 'node');
  const index = args.findIndex(arg => arg !== '-y' && arg !== '--yes');
  if (command !== node || index < 1 || !isDeepStrictEqual(stagedArgs.slice(1), args.slice(index + 1).map(expandHome))) return false;
  const spec = args[index];
  const pkg = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(?:@[A-Za-z0-9._~^<>=*| -]+)?$/.exec(spec);
  if (!pkg) return false;
  const hash = createHash('sha256').update(spec).digest('hex').slice(0, 16);
  const root = path.join(directory, 'mcp-npm', hash, 'node_modules', pkg[1]);
  try {
    if (qualified && !statSync(path.resolve(directory, node)).isFile()) return false;
    const { bin } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    let rel = bin;
    if (object(bin)) {
      const bins = Object.values(bin);
      if (!strings(bins)) return false;
      rel = bins.length === 1 ? bins[0] : bin[path.basename(pkg[1])];
    }
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return false;
    const file = path.join(root, rel);
    if (file !== stagedArgs[0] || !file.startsWith(root + path.sep) || !statSync(file).isFile()) return false;
    if (/\.(?:cjs|mjs|js)$/i.test(file)) return true;
    const fd = openSync(file, 'r');
    try {
      const head = Buffer.alloc(128);
      const size = readSync(fd, head, 0, head.length, 0);
      return /^#![^\n]*node/.test(head.toString('utf8', 0, size));
    } finally { closeSync(fd); }
  } catch { return false; }
}

function matchesStdio(assigned, command, args, env, directory) {
  const argv = assigned.args ?? [];
  const vars = assigned.env ?? {};
  if (typeof assigned.command !== 'string' || !strings(argv) || !object(vars)) return false;
  if (Object.keys(vars).length !== Object.keys(env).length) return false;
  for (const [key, value] of Object.entries(vars)) {
    if (typeof value !== 'string' || !Object.hasOwn(env, key)) return false;
    if (env[key] !== expandHome(value).replace(/%(?:HOME|USERPROFILE)%/gi, () => homedir())) return false;
  }
  if (command === expandHome(assigned.command) && isDeepStrictEqual(args, argv.map(expandHome))) return true;
  return cachedNpxMatches(directory, assigned.command, argv, command, args);
}

function headerMap(headers) {
  if (!object(headers)) throw new Error('Invalid MCP header map. Check it in Magpie Library.');
  const entries = Object.entries(headers);
  const map = new Map(entries.map(([key, value]) => [key.toLowerCase(), value]));
  if (map.size !== entries.length) throw new Error('Duplicate MCP header. Check it in Magpie Library.');
  return map;
}

function assignedHeaders(assigned, relay) {
  const headers = headerMap(assigned?.headers ?? {});
  if (assigned?.account) {
    const accounts = assigned.accounts;
    const matches = Array.isArray(accounts) ? accounts.filter(a => a?.id === assigned.account) : [];
    if (matches.length !== 1) throw new Error('Invalid MCP account selection. Check it in Magpie Library.');
    for (const [key, value] of headerMap(matches[0].headers ?? {})) headers.set(key, value);
  }
  if (relay) headers.delete('authorization');
  return headers;
}

function validateEndpoint(url, assigned, origin) {
  if (!assigned) {
    if (url.origin !== origin || url.pathname !== `${hubPath}/${agent}` || url.search) {
      throw new Error('Expected Magpie’s Oleafly-scoped Router URL. Resync MCP in Magpie Library.');
    }
    return;
  }

  const expected = httpUrl(assigned.url);
  const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '');
  if (assigned.plugin) {
    const path = `${toolsPath}/${pluginPrefix(assigned.plugin)}`;
    if (url.origin !== origin || expected?.pathname !== path || expected.search || url.pathname !== path || url.search) {
      throw new Error('Expected the assigned plugin’s Magpie tool endpoint. Resync MCP in Magpie Library.');
    }
    return;
  }

  if ([hubPath, toolsPath].some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    throw new Error('This MCP endpoint can expose tools outside the Oleafly assignment. Assign individual servers in Magpie Library.');
  }
  const relay = url.origin === origin && url.pathname === `/mcp/${encodeURIComponent(assigned.name)}` && !url.search;
  if (url.href !== expected?.href && !relay) {
    throw new Error('MCP endpoint differs from the Library assignment. Resync MCP in Magpie Library.');
  }
  // Oleafly stores URLs verbatim. Limit direct queries to the numeric version selector.
  if (url.search && !/^\?version=\d{1,3}(?:\.\d{1,3}){0,2}$/.test(url.search)) {
    throw new Error('Oleafly stores MCP URLs in plaintext. Route this query through Magpie or use header authentication.');
  }
  return relay && url.href !== expected?.href;
}

function translateEntry(name, entry, assigned, origin, directory) {
  if (!serverName(name)) throw new Error('Oleafly MCP names use up to 64 letters, digits, dots, hyphens, or underscores. Rename the server in Magpie Library.');
  if (!object(entry)) throw new Error('Missing or invalid staged MCP entry. Resync MCP in Magpie Library.');
  const { type, command, args = [], env = {}, headers = {} } = entry;
  if (type === 'sse') throw new Error('Oleafly requires Streamable HTTP for remote MCP. Route this server through Magpie or use its Streamable HTTP URL.');
  if (type !== (assigned?.transport ?? 'http') || !['stdio', 'http'].includes(type)) {
    throw new Error('Invalid MCP transport for this assignment. Resync MCP in Magpie Library.');
  }
  const fields = type === 'stdio' ? ['type', 'command', 'args', 'env'] : ['type', 'url', 'headers'];
  if (Object.keys(entry).some((key) => !fields.includes(key))) {
    throw new Error('This MCP entry has settings Oleafly cannot enforce. Check the entry in Magpie Library.');
  }

  if (type === 'stdio') {
    if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > 4096 || /[\p{Cc}\p{Cs}]/u.test(command)) {
      throw new Error('Invalid MCP command. Check it in Magpie Library.');
    }
    if (!strings(args) || args.length > 128 || args.some((arg) => Buffer.byteLength(arg) > 8192 || /[\0\p{Cs}]/u.test(arg))) {
      throw new Error('Invalid MCP command arguments. Check them in Magpie Library.');
    }
    if ([command, ...args].some((value) => /\$\{|\$[a-z_]|%(?:HOME|USERPROFILE)%/i.test(value))) {
      throw new Error('Oleafly cannot expand MCP command variables. Route the server through Magpie or update its command in Library.');
    }
    validateMap(env, 'env');
    if (!matchesStdio(assigned, command, args, env, directory)) {
      throw new Error('MCP command, arguments, or environment differ from the Library assignment. Resync MCP or route it through Magpie.');
    }
    return { name, transport: 'stdio', command: command.trim(), args: [...args], env: { ...env } };
  }

  const url = httpUrl(entry.url);
  if (!url || entry.url.includes('${') || /%(?![\da-f]{2})/i.test(url.pathname)) {
    throw new Error('Invalid MCP URL. Use HTTPS or loopback HTTP without embedded credentials or fragments.');
  }
  try {
    decodeURIComponent(url.pathname);
  } catch {
    throw new Error('Invalid MCP URL path. Check it in Magpie Library.');
  }
  const relay = validateEndpoint(url, assigned, origin);
  validateMap(headers, 'header');
  if (!isDeepStrictEqual(headerMap(headers), assignedHeaders(assigned, relay))) {
    throw new Error('MCP headers differ from the Library assignment. Resync MCP in Magpie Library.');
  }
  return { name, transport: 'remote', url: url.href, headers: { ...headers } };
}

// Use library.json alongside Claude-format staging because Magpie omits tool restrictions for plugin agents.
// Servers can contain credentials and are inputs to the reconciler's secret transaction.
function translateMcp(staging, library, { gatewayUrl, directory = process.cwd() } = {}) {
  if (staging !== null && (!object(staging) || Object.keys(staging).some((key) => key !== 'mcpServers') ||
      (Object.hasOwn(staging, 'mcpServers') && !object(staging.mcpServers)))) {
    throw new Error('Invalid Oleafly MCP staging document. Resync MCP in Magpie Library.');
  }
  if (!object(library) || (library.mcp != null && !Array.isArray(library.mcp)) ||
      (library.applied !== undefined && !object(library.applied)) ||
      (library.pluginsOffered != null && !strings(library.pluginsOffered)) ||
      (library.mcpHub !== undefined && typeof library.mcpHub !== 'boolean')) {
    throw new Error('Invalid Magpie Library document. Repair it before syncing Oleafly MCP.');
  }

  const libraryEntries = new Map();
  for (const item of library.mcp ?? []) {
    if (!object(item) || typeof item.name !== 'string' ||
        (item.plugin != null && typeof item.plugin !== 'string') ||
        (item.agents != null && !strings(item.agents)) || libraryEntries.has(item.name)) {
      throw new Error('Invalid Magpie Library MCP assignment. Repair it before syncing Oleafly MCP.');
    }
    libraryEntries.set(item.name, item);
  }
  const applied = library.applied?.[agent];
  if (applied !== undefined && (!object(applied) || (applied.mcp !== undefined && !strings(applied.mcp)))) {
    throw new Error('Invalid Magpie Library ownership record for Oleafly MCP. Resync MCP in Magpie Library.');
  }

  const stage = staging?.mcpServers ?? {};
  const owned = new Set(applied?.mcp);
  const origin = httpUrl(gatewayUrl)?.origin;
  const servers = [];
  const issues = [];
  const report = (name, message) => issues.push({ name: name.replace(/\p{Cc}/gu, '\uFFFD').slice(0, 96), message });
  const assigned = [...libraryEntries.values()].filter((item) => item.agents?.includes(agent) && !item.hidden);
  const wantsHub = library.mcpHub && assigned.some(item => item.hub !== 'direct');
  const collision = libraryEntries.has(hubName) || (object(stage[hubName]) && !owned.has(hubName));
  const useHub = wantsHub && !collision;
  const plugins = new Map();
  const offered = [...(library.pluginsOffered ?? []), ...[...libraryEntries.values()].map((item) => item.plugin).filter(Boolean)];
  for (const plugin of offered) {
    const prefix = pluginPrefix(plugin);
    if (!plugins.has(prefix)) plugins.set(prefix, plugin);
    else if (plugins.get(prefix) !== plugin) plugins.set(prefix, null);
  }

  function add(name, item) {
    if (!owned.has(name) || !Object.hasOwn(stage, name)) {
      report(name, 'Magpie did not stage this MCP assignment. Resync MCP in Magpie Library.');
      return;
    }
    try {
      servers.push(translateEntry(name, stage[name], item, origin, directory));
    } catch (error) {
      report(name, error.message);
    }
  }

  if (useHub) add(hubName);
  else if (wantsHub) report(hubName, 'An MCP server named magpie conflicts with the Router. Magpie stages individual assignments.');
  for (const item of assigned) {
    if (useHub && item.hub !== 'direct') continue;
    if (item.plugin && plugins.get(pluginPrefix(item.plugin)) === null) {
      report(item.name, 'Magpie’s direct tool endpoint is shared by multiple plugins. Route this server through Magpie or remove the other plugin.');
      continue;
    }
    if (item.disabledTools !== undefined && (!strings(item.disabledTools) || item.disabledTools.length > 0)) {
      report(item.name, 'Oleafly cannot enforce Magpie’s per-tool restrictions on a direct server. Route it through Magpie to keep those restrictions.');
      continue;
    }
    add(item.name, item);
  }
  return { servers, issues };
}

module.exports = { translateMcp };
