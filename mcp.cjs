'use strict';

const { isIPv4 } = require('node:net');

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
}

function translateEntry(name, entry, assigned, origin) {
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
    if ([command, ...args].some((value) => value.includes('${'))) {
      throw new Error('Oleafly cannot expand MCP command variables. Route the server through Magpie or update its command in Library.');
    }
    validateMap(env, 'env');
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
  validateEndpoint(url, assigned, origin);
  validateMap(headers, 'header');
  return { name, transport: 'remote', url: url.href, headers: { ...headers } };
}

// Use library.json alongside Claude-format staging because Magpie omits tool restrictions for plugin agents.
// Servers can contain credentials and are inputs to the reconciler's secret transaction.
function translateMcp(staging, library, { gatewayUrl } = {}) {
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
  const routed = library.mcpHub ? assigned.filter((item) => item.hub !== 'direct') : [];
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
      servers.push(translateEntry(name, stage[name], item, origin));
    } catch (error) {
      report(name, error.message);
    }
  }

  if (routed.length > 0) {
    if (libraryEntries.has(hubName)) {
      report(hubName, 'An MCP server named magpie conflicts with the Router. Rename that server in Magpie Library.');
    } else {
      add(hubName);
    }
  }
  for (const item of assigned) {
    if (library.mcpHub && item.hub !== 'direct') continue;
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
