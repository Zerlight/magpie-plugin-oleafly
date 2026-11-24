'use strict';

const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } = require('node:crypto');
const { homedir } = require('node:os');
const { basename, join, resolve, toNamespacedPath } = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const PROVIDER = 'magpie-oleafly';
const CONFIG = 'config.json';
const STATE = '.magpie-oleafly-state.json';
const CLEANUP_NOTE = '.magpie-oleafly-cleanup.txt';
const KEY = 'ai-secrets.key';
const AI_SECRETS = 'ai-secrets.json';
const MCP_SECRETS = 'mcp-server-secrets.json';
const MCP_MARKER = '__stored__';
const SECRET_REF = /^__stored__:v1:[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const NAME = /^[a-zA-Z0-9_.-]{1,64}$/;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_MCP_SERVERS = 64;
// Oleafly 0.4.13's native provider catalog is independent of ai_custom_providers.
const BUILTIN_PROVIDERS = new Set([
  'openai', 'anthropic', 'google', 'zai', 'groq', 'openrouter', 'deepseek', 'mistral', 'xai', 'perplexity', 'ollama',
]);
const MODEL_SLOTS = ['selection', 'provider', 'catalog', 'key'];
const PROTECTED_HEADERS = new Set([
  'accept', 'connection', 'content-length', 'content-type', 'host', 'mcp-method',
  'mcp-name', 'mcp-protocol-version', 'mcp-session-id', 'transfer-encoding',
]);

class ReconcileError extends Error {}

function fail(message, code = 'OLEAFLY_CONFIG') {
  throw Object.assign(new ReconcileError(message), { code });
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !JSON.isRawJSON(value);
const string = value => typeof value === 'string';
const textMap = value => object(value) && Object.values(value).every(string);
const control = value => /[\u0000-\u001f\u007f-\u009f]/u.test(value);
const own = (value, key) => Object.hasOwn(value, key) ? value[key] : undefined;

const windows = process.platform === 'win32';
let winFiles;

function windowsFiles() {
  if (winFiles) return winFiles;
  const { dlopen, CString, ptr, toArrayBuffer } = require('bun:ffi');
  const api = (args, returns = 'i32') => ({ args, returns });
  // HANDLE is pointer-sized. A signed return preserves INVALID_HANDLE_VALUE (-1) on both 64-bit ABIs.
  const k = dlopen('kernel32.dll', {
    CreateFileW: api(['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'ptr'], 'isize'),
    GetLastError: api([], 'u32'),
    GetFileType: api(['isize'], 'u32'),
    GetFileInformationByHandle: api(['isize', 'ptr']),
    LockFileEx: api(['isize', 'u32', 'u32', 'u32', 'u32', 'ptr']),
    ReadFile: api(['isize', 'ptr', 'u32', 'ptr', 'ptr']),
    WriteFile: api(['isize', 'ptr', 'u32', 'ptr', 'ptr']),
    FlushFileBuffers: api(['isize']),
    CloseHandle: api(['isize']),
    MoveFileExW: api(['ptr', 'ptr', 'u32']),
    LocalFree: api(['ptr'], 'ptr'),
  }).symbols;
  const security = dlopen('advapi32.dll', {
    GetTokenInformation: api(['isize', 'u32', 'ptr', 'u32', 'ptr']),
    ConvertSidToStringSidA: api(['ptr', 'ptr']),
    ConvertStringSecurityDescriptorToSecurityDescriptorA: api(['ptr', 'u32', 'ptr', 'ptr']),
  }).symbols;

  // Oleafly protects its files with a non-inheriting DACL granting only TokenUser full access.
  const token = Buffer.alloc(16 + 68); // TOKEN_USER followed by SECURITY_MAX_SID_SIZE.
  const out = Buffer.alloc(8);
  const size = Buffer.alloc(4);
  const address = buffer => Number(buffer.readBigUInt64LE());
  if (!security.GetTokenInformation(-4n, 1, token, token.length, size) || // GetCurrentProcessToken(), TokenUser
      !security.ConvertSidToStringSidA(address(token), out)) fail('Cannot identify the current Windows account for Oleafly.');
  const sid = address(out);
  let attributes;
  try {
    const sddl = Buffer.from('D:P(A;;FA;;;' + new CString(sid).toString() + ')\0');
    if (!security.ConvertStringSecurityDescriptorToSecurityDescriptorA(sddl, 1, out, size)) {
      fail('Cannot secure the Oleafly configuration for the current Windows account.');
    }
    const descriptor = address(out);
    try {
      // Store SECURITY_ATTRIBUTES and its self-relative descriptor together for the cached CreateFileW calls.
      attributes = Buffer.alloc(24 + size.readUInt32LE());
      attributes.set(new Uint8Array(toArrayBuffer(descriptor, 0, size.readUInt32LE())), 24);
      attributes.writeUInt32LE(24);
      attributes.writeBigUInt64LE(BigInt(ptr(attributes, 24)), 8);
    } finally {
      k.LocalFree(descriptor);
    }
  } finally {
    k.LocalFree(sid);
  }

  const wide = path => {
    if (path.includes('\0')) fail('The Oleafly file path is invalid.');
    return Buffer.from(toNamespacedPath(path) + '\0', 'utf16le');
  };
  const OPEN_EXISTING = 3, OPEN_ALWAYS = 4, CREATE_NEW = 1;
  const READ = 0x80000000, WRITE = 0x40000000;
  function open(path, access, share, creation) {
    const handle = k.CreateFileW(wide(path), access, share, creation === OPEN_EXISTING ? null : attributes,
      creation, 0x00200000 /* FILE_FLAG_OPEN_REPARSE_POINT */, null);
    if (handle === -1n) {
      const error = k.GetLastError();
      if (creation === OPEN_EXISTING && (error === 2 || error === 3)) return undefined;
      fail(`Cannot open Oleafly ${basename(path)}. Check its permissions and retry.`);
    }
    return handle;
  }
  function fileInfo(handle, name) {
    const info = Buffer.alloc(52); // BY_HANDLE_FILE_INFORMATION
    if (k.GetFileType(handle) !== 1 || !k.GetFileInformationByHandle(handle, info) ||
        (info.readUInt32LE() & 0x410)) { // FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT
      fail(`Oleafly ${name} is not a supported regular file. Review it before retrying.`);
    }
    return info;
  }
  winFiles = {
    read(root, name, maximum) {
      const handle = open(join(root, name), READ, 5 /* share read/delete */, OPEN_EXISTING);
      if (handle === undefined) return undefined;
      try {
        const info = fileInfo(handle, name);
        const length = info.readUInt32LE(32) * 2 ** 32 + info.readUInt32LE(36);
        if (length > Math.min(maximum, 0xffffffff)) {
          fail(`Oleafly ${name} is not a supported regular file. Review it before retrying.`);
        }
        const bytes = Buffer.alloc(length);
        const count = Buffer.alloc(4);
        if (length && (!k.ReadFile(handle, bytes, length, count, null) || count.readUInt32LE() !== length)) {
          fail(`Cannot read Oleafly ${name}. Check its permissions and retry.`);
        }
        return bytes;
      } finally {
        k.CloseHandle(handle);
      }
    },
    lock(root, name, run, wait) {
      const handle = open(join(root, name), READ + WRITE, 3 /* share read/write */, OPEN_ALWAYS);
      try {
        fileInfo(handle, name);
        // fs4 locks u64::MAX bytes at offset zero with a synchronous handle.
        if (!k.LockFileEx(handle, wait ? 2 : 3, 0, 0xffffffff, 0xffffffff, Buffer.alloc(32))) {
          if (k.GetLastError() === 33) {
            fail(`Oleafly ${name} is busy. Retry after the current operation finishes.`, 'OLEAFLY_BUSY');
          }
          fail(`Cannot acquire Oleafly ${name}. Check its permissions and retry.`);
        }
        return run();
      } finally {
        k.CloseHandle(handle);
      }
    },
    replace(temp, target, bytes) {
      const handle = open(temp, WRITE, 0, CREATE_NEW);
      try {
        try {
          const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
          const count = Buffer.alloc(4);
          if (!k.WriteFile(handle, data, data.length, count, null) || count.readUInt32LE() !== data.length ||
              !k.FlushFileBuffers(handle)) throw new Error();
        } finally {
          k.CloseHandle(handle);
        }
        // Never overwrite a concurrently created native key. All other files replace in-place.
        const flags = basename(target) === KEY ? 8 : 9; // WRITE_THROUGH | optional REPLACE_EXISTING
        if (!k.MoveFileExW(wide(temp), wide(target), flags)) throw new Error();
      } catch (error) {
        try { fs.unlinkSync(temp); } catch { /* Preserve the write error. */ }
        throw error;
      }
    },
  };
  return winFiles;
}

function readFile(root, name, maximum = Infinity) {
  let fd;
  try {
    if (windows) return windowsFiles().read(root, name, maximum);
    fd = fs.openSync(join(root, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) {
      fail(`Oleafly ${name} is not a supported regular file. Review it before retrying.`);
    }
    return fs.readFileSync(fd);
  } catch (error) {
    if (error instanceof ReconcileError) throw error;
    if (error.code === 'ENOENT' && fd === undefined) return undefined;
    fail(`Cannot read Oleafly ${name}. Check its permissions and retry.`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function parseObject(bytes, name) {
  try {
    // AppConfig includes u64 revisions and timestamps. Keep native number tokens through every config write.
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), name === CONFIG
      ? (_, item, context) => typeof item === 'number' ? JSON.rawJSON(context.source) : item
      : undefined);
    if (object(value)) return value;
  } catch {
    // Parser diagnostics can include credentials from the source text.
  }
  fail(`Oleafly ${name} is invalid. Repair it before retrying.`);
}

function syncDirectory(root) {
  if (windows) return;
  const fd = fs.openSync(root, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function replace(root, name, bytes) {
  const target = join(root, name);
  const temp = `${target}.magpie-${randomBytes(12).toString('hex')}.tmp`;
  let temporary = false;
  try {
    if (windows) return windowsFiles().replace(temp, target, bytes);
    const fd = fs.openSync(temp, 'wx', 0o600);
    temporary = true;
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
    temporary = false;
    syncDirectory(root);
  } catch {
    fail(`Cannot save Oleafly ${name}. Check available space and permissions, then retry.`);
  } finally {
    if (temporary) {
      try { fs.unlinkSync(temp); } catch { /* Preserve the original write error. */ }
    }
  }
}

function withLock(root, name, run, wait = false) {
  if (windows) return windowsFiles().lock(root, name, run, wait);
  let fd;
  try {
    fd = fs.openSync(join(root, name), fs.constants.O_RDWR | fs.constants.O_CREAT |
      fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    if (!fs.fstatSync(fd).isFile()) fail(`Oleafly ${name} is not a regular file. Review it before retrying.`);

    // fs4 uses flock on Unix. The inherited open file description keeps the lock in this process.
    const mac = process.platform === 'darwin';
    const args = mac ? (wait ? ['-s', '3'] : ['-s', '-t', '0', '3']) : (wait ? ['-x', '3'] : ['-x', '-n', '3']);
    const result = spawnSync(mac ? '/usr/bin/lockf' : '/usr/bin/flock', args,
      { stdio: ['ignore', 'ignore', 'ignore', fd] });
    if (result.status === (mac ? 75 : 1)) {
      fail(`Oleafly ${name} is busy. Retry after the current operation finishes.`, 'OLEAFLY_BUSY');
    }
    if (result.status !== 0) fail(`Cannot acquire Oleafly ${name}. Verify that the system file-lock utility is available.`);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error instanceof ReconcileError) throw error;
    fail(`Cannot open Oleafly ${name}. Check that it is a writable regular file and retry.`);
  }
  try {
    return run();
  } finally {
    fs.closeSync(fd);
  }
}

function readSecrets(raw, key, name) {
  if (raw === undefined) return Object.create(null);
  const envelope = parseObject(raw, name);
  try {
    const nonce = Buffer.from(envelope.nonce, 'base64');
    const sealed = Buffer.from(envelope.ciphertext, 'base64');
    if (envelope.version !== 1 || nonce.length !== 12 || sealed.length < 16 ||
        nonce.toString('base64') !== envelope.nonce || sealed.toString('base64') !== envelope.ciphertext) {
      throw new Error();
    }
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(sealed.subarray(-16));
    const decoded = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
    const values = parseObject(decoded, name);
    if (textMap(values)) return Object.assign(Object.create(null), values);
  } catch {
    // Secret files and crypto errors can contain input that should stay private.
  }
  fail(`Cannot decrypt Oleafly ${name}. Restore its matching secret key and retry.`);
}

function writeSecrets(root, name, key, values) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(values)), cipher.final(), cipher.getAuthTag()]);
  replace(root, name, JSON.stringify({ version: 1, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64') }));
}

function fingerprint(key, value) {
  if (value === undefined) return null;
  const canonical = JSON.stringify(value, (_, item) => object(item)
    ? Object.fromEntries(Object.keys(item).sort().map(field => [field, item[field]])) : item);
  return createHmac('sha256', key).update(canonical).digest('hex');
}

function url(value) {
  if (!string(value) || value !== value.trim() || control(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.hash) return parsed;
  } catch { /* The URL can contain credentials. */ }
}

function mcpShape(entry) {
  return object(entry) && string(entry.name) &&
    (entry.enabled === undefined || typeof entry.enabled === 'boolean') &&
    (entry.transport === 'stdio'
      ? string(entry.command) && (entry.args === undefined || Array.isArray(entry.args) && entry.args.every(string)) &&
        (entry.env === undefined || textMap(entry.env))
      : entry.transport === 'remote' && string(entry.url) && (entry.headers === undefined || textMap(entry.headers)));
}

function mcpDefaults(entry) {
  const enabled = entry.enabled ?? true;
  return entry.transport === 'stdio' ? { ...entry, enabled, args: entry.args ?? [], env: entry.env ?? {} }
    : { ...entry, enabled, headers: entry.headers ?? {} };
}

function desiredMcp(entries) {
  if (entries === undefined) return undefined;
  if (!Array.isArray(entries)) fail('Oleafly MCP assignments must be an array. Refresh the Library assignments and retry.');
  const servers = new Map();
  for (const entry of entries) {
    if (!mcpShape(entry) || !NAME.test(entry.name)) {
      fail('An Oleafly MCP assignment has an invalid name or transport. Review the Library assignment and retry.');
    }
    const server = mcpDefaults(entry);
    const stdio = server.transport === 'stdio';
    const fields = stdio ? ['command', 'args', 'env'] : ['url', 'headers'];
    const endpoint = stdio ? undefined : url(server.url);
    const values = Object.entries(stdio ? server.env : server.headers);
    const unsupported = Object.keys(server).some(field => !['name', 'enabled', 'transport', ...fields].includes(field));
    const invalidValues = values.length > 128 || values.some(([field, value]) => {
      if (Buffer.byteLength(value) > 65536 || value.includes('\0') || isMarker(value)) return true;
      if (stdio) return !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field);
      const header = field.toLowerCase();
      return PROTECTED_HEADERS.has(header) || header.startsWith('mcp-param-') ||
        !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(header) || /[^\t\x20-\x7e]/.test(value);
    });
    const invalidEndpoint = stdio
      ? !server.command.trim() || control(server.command) || Buffer.byteLength(server.command) > 4096 ||
        server.args.length > 128 || server.args.some(arg => arg.includes('\0') || Buffer.byteLength(arg) > 8192)
      : !endpoint || Buffer.byteLength(server.url) > 8192 ||
        endpoint.protocol === 'http:' && !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(endpoint.hostname);
    if (unsupported || invalidValues || invalidEndpoint || servers.has(server.name)) {
      fail(`Oleafly MCP server '${server.name}' has an invalid, duplicate, or unsupported assignment. Review it in Magpie Library and retry.`);
    }
    servers.set(server.name, stdio ? { ...server, command: server.command.trim() } : { ...server, url: endpoint.href });
  }
  return servers;
}

function isMarker(value) {
  return value === MCP_MARKER || value.startsWith(`${MCP_MARKER}:`);
}

function valueField(server) {
  return server.transport === 'stdio' ? 'env' : 'headers';
}

function secretReference(server, field, value) {
  if (value === MCP_MARKER) {
    const kind = server.transport === 'stdio' ? 'env' : 'header';
    return `${Buffer.byteLength(server.name)}:${server.name}:${kind}:${field}`;
  }
  return value;
}

function mcpValues(entry, secrets) {
  const server = mcpDefaults(entry);
  const field = valueField(server);
  const values = Object.entries(server[field]).map(([name, value]) => {
    if (!isMarker(value)) return [name, value];
    const reference = secretReference(server, name, value);
    if ((value === MCP_MARKER || SECRET_REF.test(value)) && secrets[reference]) return [name, secrets[reference]];
    return [name, null];
  });
  return { ...server, [field]: Object.fromEntries(values) };
}

function references(servers) {
  return new Set(servers.flatMap(server => Object.entries(server[valueField(server)] ?? {})
    .filter(([, value]) => isMarker(value)).map(([field, value]) => secretReference(server, field, value))));
}

function readState(raw) {
  if (!raw) return { version: 1, owned: {} };
  const state = parseObject(raw, STATE);
  const hash = value => string(value) && DIGEST.test(value);
  const slot = name => MODEL_SLOTS.includes(name) || name.startsWith('mcp:') && NAME.test(name.slice(4));
  const owned = value => object(value) && Object.entries(value).every(([name, record]) => slot(name) &&
    (name === 'selection' ? object(record) && hash(record.last) && Array.isArray(record.previous) &&
      record.previous.length === 2 && record.previous.every(value => value === null || string(value))
      : hash(record) || name.startsWith('mcp:') && object(record) && hash(record.withdrawn)));
  const pending = state.pending;
  if (state.version === 1 && owned(state.owned) && (pending === undefined || object(pending) && owned(pending.owned) &&
      object(pending.effects) && Object.entries(pending.effects).every(([name, value]) => slot(name) && (value === null || hash(value))) &&
      Array.isArray(pending.refs) && pending.refs.every(value => string(value) && SECRET_REF.test(value)) &&
      (pending.dropKey === undefined || hash(pending.dropKey)))) return state;
  fail(`Oleafly ${STATE} is invalid. Restore the ownership record before retrying.`);
}

function validConfig(cfg) {
  const optional = (field, valid) => cfg[field] === undefined || valid(cfg[field]);
  if (!optional('ai_provider', string) || !optional('ai_model', string) || !optional('ai_keys', textMap) ||
      !optional('ai_custom_providers', value => Array.isArray(value) && value.every(entry => object(entry) &&
        string(entry.id) && string(entry.name) && (entry.baseURL === undefined || string(entry.baseURL)) &&
        ['keyOptional', 'key_optional', 'reasoningEffort'].every(field => entry[field] === undefined || typeof entry[field] === 'boolean'))) ||
      !optional('ai_provider_models', value => object(value) && Object.values(value).every(models => Array.isArray(models) &&
        models.every(model => object(model) && string(model.id) && string(model.name) &&
          (model.enabled === undefined || typeof model.enabled === 'boolean') && (model.source === undefined || string(model.source))))) ||
      !optional('ai_tools_model', value => value === null || object(value) && string(value.provider) && string(value.model)) ||
      !optional('mcp_servers', value => Array.isArray(value) && value.every(mcpShape))) {
    fail('Oleafly config.json contains invalid model or MCP settings. Repair it before retrying.');
  }
}

function reconcileLocked(root, model, mcp, rawState) {
  const state = readState(rawState);
  const cfg = parseObject(readFile(root, CONFIG, MAX_CONFIG_BYTES) ?? Buffer.from('{}'), CONFIG);
  validConfig(cfg);
  const rawKey = readFile(root, KEY, 32);
  const rawAI = readFile(root, AI_SECRETS);
  const rawMcp = readFile(root, MCP_SECRETS);
  // Oleafly's file-backed app and connector stores share this key.
  const otherStore = !rawKey && ['app-secrets.json', 'connector-secrets.json'].some(name =>
    fs.lstatSync(join(root, name), { throwIfNoEntry: false }));
  if ((rawKey && rawKey.length !== 32) || (!rawKey && (rawAI || rawMcp || rawState || otherStore))) {
    fail(`Oleafly ${KEY} is missing or invalid. Restore the secret key before retrying.`);
  }
  const key = rawKey ?? randomBytes(32);
  const ai = readSecrets(rawAI, key, AI_SECRETS);
  const secrets = readSecrets(rawMcp, key, MCP_SECRETS);
  const mark = value => fingerprint(key, value);
  const selection = () => [cfg.ai_provider ?? null, cfg.ai_model ?? null];
  const providers = () => (cfg.ai_custom_providers ?? []).filter(entry => entry.id === PROVIDER);
  const servers = name => (cfg.mcp_servers ?? []).filter(entry => entry.name === name);
  const one = entries => entries.length ? entries : undefined;
  const actual = slot => {
    switch (slot) {
      case 'selection': return mark(selection().map(value => value ?? ''));
      case 'provider': return mark(one(providers()));
      case 'catalog': return mark(own(cfg.ai_provider_models ?? {}, PROVIDER));
      case 'key': return mark(ai[PROVIDER]);
      default: return mark(one(servers(slot.slice(4)).map(entry => mcpValues(entry, secrets))));
    }
  };

  // Recover only the slots that match the interrupted transaction's intended result.
  const owned = { ...state.owned };
  const pending = state.pending;
  const garbage = new Set(pending?.refs);
  if (pending) {
    const removed = !providers().length && cfg.ai_provider !== PROVIDER && cfg.ai_tools_model?.provider !== PROVIDER;
    const becameKeyless = pending.effects.provider && pending.effects.provider === actual('provider') &&
      providers()[0].keyOptional;
    if (pending.dropKey && actual('key') === pending.dropKey && (removed || becameKeyless)) {
      delete ai[PROVIDER];
      writeSecrets(root, AI_SECRETS, key, ai);
    }
    for (const [slot, expected] of Object.entries(pending.effects)) {
      if (actual(slot) !== expected) continue;
      if (own(pending.owned, slot) === undefined) delete owned[slot];
      else owned[slot] = pending.owned[slot];
    }
    // Persist recovered ownership before planning another transaction.
    pruneSecrets(root, key, cfg, secrets, garbage);
    saveState(root, owned);
    garbage.clear();
  }

  const before = { ...owned };
  const effects = {};
  const conflicts = [];
  let configChanged = false;
  let aiStaged = false;
  let mcpStaged = false;
  let dropKey;

  function record(slot, expected, owner = expected) {
    effects[slot] = expected;
    if (owner === null) delete owned[slot];
    else owned[slot] = owner;
  }

  function conflict(kind, id, reason, message) {
    conflicts.push({ kind, id, reason, message });
  }

  function modelConflict(id, reason, message) {
    conflict('model', id, reason, message);
  }

  const bundle = ['provider', 'catalog', 'key'];
  const edited = bundle.filter(slot => actual(slot) !== (owned[slot] ?? null));
  const legacyKey = own(cfg.ai_keys ?? {}, PROVIDER) !== undefined;
  const selectionEdited = owned.selection && actual('selection') !== owned.selection.last;

  if (model) {
    if (edited.length || legacyKey || !owned.selection && cfg.ai_provider === PROVIDER && !owned.provider) {
      const reason = bundle.some(slot => owned[slot]) ? 'edited' : 'collision';
      modelConflict(PROVIDER, reason, 'Oleafly already has different settings for the Magpie provider. Review that provider before reconnecting.');
    } else if (selectionEdited) {
      modelConflict('chat', 'edited', 'Oleafly’s chat model changed outside Magpie. Reset the Oleafly connection in Magpie before selecting a model again.');
    } else {
      const provider = { id: PROVIDER, name: 'Magpie', baseURL: model.baseURL, keyOptional: !model.apiKey, reasoningEffort: false };
      const toolsModel = cfg.ai_tools_model?.provider === PROVIDER ? cfg.ai_tools_model.model : undefined;
      const ids = new Set([model.id]);
      if (toolsModel) ids.add(toolsModel);
      const catalog = [...ids].map(id => ({ id, name: id, enabled: true, source: 'manual' }));
      const previous = owned.selection?.previous ?? selection();
      if (actual('provider') !== mark([provider])) {
        cfg.ai_custom_providers = (cfg.ai_custom_providers ?? []).filter(entry => entry.id !== PROVIDER).concat(provider);
        record('provider', mark([provider]));
        configChanged = true;
      }
      if (actual('catalog') !== mark(catalog)) {
        cfg.ai_provider_models = { ...cfg.ai_provider_models, [PROVIDER]: catalog };
        record('catalog', mark(catalog));
        configChanged = true;
      }
      if (actual('selection') !== mark([PROVIDER, model.id])) {
        cfg.ai_provider = PROVIDER;
        cfg.ai_model = model.id;
        const last = actual('selection');
        record('selection', last, { last, previous });
        configChanged = true;
      }
      if (model.apiKey !== ai[PROVIDER]) {
        if (model.apiKey) {
          ai[PROVIDER] = model.apiKey;
          record('key', actual('key'));
          aiStaged = true;
        } else {
          dropKey = owned.key;
          record('key', null);
        }
      }
    }
  } else if (model === null && (owned.selection || bundle.some(slot => owned[slot]))) {
    if (owned.selection) {
      if (selectionEdited) {
        modelConflict('chat', 'edited', 'Oleafly’s chat model changed outside Magpie. The current chat selection was kept.');
        record('selection', actual('selection'), null);
      } else {
        const [provider] = owned.selection.previous;
        const missing = provider && !BUILTIN_PROVIDERS.has(provider) && !provider.startsWith('acp:') &&
          !cfg.ai_custom_providers?.some(entry => entry.id === provider);
        if (missing) {
          modelConflict('chat', 'missing-provider', 'The previous Oleafly chat provider was removed. Chat was reset to the Oleafly default.');
        }
        for (const [index, field] of ['ai_provider', 'ai_model'].entries()) {
          const previous = missing ? null : owned.selection.previous[index];
          if (previous === null) delete cfg[field];
          else cfg[field] = previous;
        }
        record('selection', actual('selection'), null);
        configChanged = true;
      }
    }
    if (cfg.ai_provider === PROVIDER || cfg.ai_tools_model?.provider === PROVIDER) {
      modelConflict(PROVIDER, 'in-use', 'Oleafly still uses the Magpie provider for Chat or Tools. Select another model in Oleafly and retry cleanup.');
    } else if (edited.some(slot => actual(slot) !== null) || legacyKey) {
      modelConflict(PROVIDER, 'edited', 'Oleafly’s Magpie provider settings changed outside Magpie. Review that provider to finish cleanup.');
    } else {
      if (providers().length) {
        cfg.ai_custom_providers = cfg.ai_custom_providers.filter(entry => entry.id !== PROVIDER);
        configChanged = true;
      }
      if (actual('catalog') !== null) {
        delete cfg.ai_provider_models[PROVIDER];
        configChanged = true;
      }
      dropKey = owned.key;
      for (const slot of bundle) record(slot, null);
    }
  }

  if (mcp) {
    // Withdraw first so a removed server can make room for a new assignment in the same transaction.
    const withdrawn = Object.keys(owned).filter(slot => slot.startsWith('mcp:'))
      .map(slot => slot.slice(4)).filter(name => !mcp.has(name));
    for (const name of [...withdrawn, ...mcp.keys()]) {
      const slot = `mcp:${name}`;
      const matches = servers(name);
      const wanted = mcp.get(name);
      const present = actual(slot);
      if (present === null && (!wanted || owned[slot]?.withdrawn)) {
        record(slot, null);
        if (!wanted) continue;
      }
      let owner = owned[slot];
      if (owner?.withdrawn && matches.length === 1 && present !== owner.withdrawn) {
        const live = mcpValues(matches[0], secrets);
        // After withdrawal only the enable switch belongs to reconciliation. A different same-name entry is local.
        if (mark([{ ...live, enabled: !live.enabled }]) !== owner.withdrawn) {
          record(slot, present, null);
          owner = undefined;
        }
      }
      const next = mark(wanted ? [wanted] : undefined);
      if (!wanted && owner && matches.length === 1 && present !== owner) {
        if (matches[0].enabled !== false) {
          matches[0].enabled = false;
          configChanged = true;
        }
        record(slot, actual(slot), { withdrawn: owner.withdrawn ?? present });
        conflict('mcp', name, 'edited',
          `Withdrawn Oleafly MCP server '${name}' is disabled. Its local edits were kept. Rename or remove it to apply a different assignment.`);
        continue;
      }
      if (wanted && owner?.withdrawn === next && matches.length === 1) {
        if (present !== next) {
          matches[0].enabled = wanted.enabled;
          configChanged = true;
        }
        record(slot, next);
        continue;
      }
      if (present !== (owner ?? null)) {
        const reason = owner && matches.length <= 1 ? 'edited' : 'collision';
        conflict('mcp', name, reason,
          `Oleafly MCP server '${name}' differs from the managed assignment. Review or rename it in Oleafly and retry.`);
        continue;
      }
      if (present === next) continue;
      if (wanted && !matches.length && (cfg.mcp_servers?.length ?? 0) >= MAX_MCP_SERVERS) {
        conflict('mcp', name, 'capacity',
          `Oleafly supports up to ${MAX_MCP_SERVERS} MCP servers. Remove a server to make room for '${name}'.`);
        continue;
      }
      for (const ref of references(matches)) if (SECRET_REF.test(ref)) garbage.add(ref);
      let replacement;
      if (wanted) {
        const field = valueField(wanted);
        const values = Object.entries(wanted[field]).map(([name, value]) => {
          if (!value) return [name, value];
          const ref = `${MCP_MARKER}:v1:${randomBytes(32).toString('hex')}`;
          secrets[ref] = value;
          garbage.add(ref);
          mcpStaged = true;
          return [name, ref];
        });
        replacement = { ...wanted, [field]: Object.fromEntries(values) };
      }
      cfg.mcp_servers = (cfg.mcp_servers ?? []).filter(entry => entry.name !== name);
      if (replacement) cfg.mcp_servers.push(replacement);
      record(slot, next);
      configChanged = true;
    }
  }

  const changed = configChanged || aiStaged || Boolean(dropKey && ai[PROVIDER]);
  if (!changed) {
    if (!isDeepStrictEqual(before, owned)) saveState(root, owned);
    return { changed, conflicts };
  }

  const serialized = configChanged ? JSON.stringify(cfg, null, 2) : undefined;
  if (serialized && Buffer.byteLength(serialized) > MAX_CONFIG_BYTES) {
    fail('The updated Oleafly config.json would exceed 4 MiB. Reduce its configuration before retrying.');
  }
  if (!rawKey) replace(root, KEY, key);
  replace(root, STATE, JSON.stringify({ version: 1, owned: before, pending: { owned, effects, refs: [...garbage], dropKey } }));
  if (mcpStaged) writeSecrets(root, MCP_SECRETS, key, secrets);
  if (aiStaged) writeSecrets(root, AI_SECRETS, key, ai);
  if (serialized) replace(root, CONFIG, serialized);
  if (dropKey && ai[PROVIDER]) {
    delete ai[PROVIDER];
    writeSecrets(root, AI_SECRETS, key, ai);
  }
  pruneSecrets(root, key, cfg, secrets, garbage);
  saveState(root, owned);
  return { changed, conflicts };
}

function pruneSecrets(root, key, cfg, secrets, garbage) {
  if (!garbage.size) return;
  const live = references(cfg.mcp_servers ?? []);
  const unused = [...garbage].filter(ref => !live.has(ref) && Object.hasOwn(secrets, ref));
  if (!unused.length) return;
  for (const ref of unused) delete secrets[ref];
  writeSecrets(root, MCP_SECRETS, key, secrets);
}

function saveState(root, owned) {
  if (Object.keys(owned).length) {
    replace(root, STATE, JSON.stringify({ version: 1, owned }));
    return;
  }
  try {
    fs.unlinkSync(join(root, STATE));
    syncDirectory(root);
  } catch (error) {
    if (error.code !== 'ENOENT') fail(`Cannot clear Oleafly ${STATE}. Check its permissions and retry.`);
  }
}

/**
 * Reconcile synchronously. Supply `model: { id, baseURL, apiKey }`, or `null`
 * to restore the preceding chat selection. Supply `mcp` as the complete array
 * of Oleafly-format servers. Omit a domain to leave its ownership in place.
 * `readDesired()` can supply both values after acquisition of the config lock.
 * Returns `{ changed, conflicts }`, or throws a display-safe error with a code.
 */
function reconcile(options = {}) {
  try {
    const { HOME, USERPROFILE, OLEAFLY_DATA_DIR } = process.env;
    const home = windows ? USERPROFILE || HOME : HOME || USERPROFILE;
    const root = resolve(options.dataDir ?? (OLEAFLY_DATA_DIR || join(home || homedir(), '.oleafly')));
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    return withLock(root, '.config-store.lock', () => {
      let desired = options;
      if (options.readDesired !== undefined) {
        try { desired = options.readDesired(); } catch {
          fail('Cannot read the staged Oleafly model or MCP assignments. Refresh the Magpie selection and retry.');
        }
        if (!object(desired) || typeof desired.then === 'function') fail('Oleafly’s desired-state reader must return its assignments synchronously.');
      }
      const model = desired.model;
      if (model !== undefined && model !== null) {
        const endpoint = object(model) ? url(model.baseURL) : undefined;
        if (!endpoint || endpoint.search || !string(model.id) || !model.id.trim() || control(model.id) ||
            (model.apiKey !== undefined && (!string(model.apiKey) || !model.apiKey.trim() || /[^\x21-\x7e]/.test(model.apiKey)))) {
          fail('The Magpie model or gateway connection is invalid. Select the Oleafly model again in Magpie.');
        }
      }
      const mcp = desiredMcp(desired.mcp);
      const state = readFile(root, STATE);
      if (!state && !model && !mcp?.size) return { changed: false, conflicts: [] };
      return withLock(root, '.secret-store.lock', () => reconcileLocked(root, model, mcp, state));
    });
  } catch (error) {
    if (error instanceof ReconcileError) throw error;
    fail('Cannot update the Oleafly data directory. Check its permissions and retry.');
  }
}

const specDigest = spec => createHash('sha256').update(spec).digest('hex');
const pendingAdvice = 'Oleafly cleanup is pending. Once Oleafly finishes saving, enable the plugin in Magpie (reinstall it if removed), then disable it again to finish cleanup.';
const currentRemoval = (root, ticket) => readFile(root, CLEANUP_NOTE)?.toString().startsWith(ticket + '\n');
const removalError = error => error instanceof ReconcileError ? error.message :
  'Oleafly cleanup could not finish. Check permissions and retry removal in Magpie.';

function finishRemoval(root, directory, ticket, hashes, wait) {
  return withLock(root, '.config-store.lock', () => withLock(root, '.secret-store.lock', () => {
    if (!currentRemoval(root, ticket)) return '';
    const list = parseObject(readFile(directory, 'plugins.json'), 'plugins.json');
    if (!Array.isArray(list.plugins) || list.plugins.some(row => !object(row) || !string(row.spec) ||
        (row.off !== undefined && typeof row.off !== 'boolean'))) {
      fail('Check the Magpie plugin list before retrying cleanup.');
    }
    let notice = '';
    if (!list.plugins.some(row => !row.off && hashes.includes(specDigest(row.spec)))) {
      const state = readFile(root, STATE);
      if (state) notice = reconcileLocked(root, null, new Map(), state).conflicts.map(issue => issue.message).join('\n');
    }
    if (currentRemoval(root, ticket)) {
      if (notice) replace(root, CLEANUP_NOTE, notice + '\n');
      else fs.rmSync(join(root, CLEANUP_NOTE), { force: true });
    }
    return notice;
  }, wait), wait);
}

function tryRemoval(root, directory, ticket, hashes, budgetMs) {
  const deadline = performance.now() + budgetMs;
  for (;;) {
    try {
      return finishRemoval(root, directory, ticket, hashes, false);
    } catch (error) {
      if (error.code !== 'OLEAFLY_BUSY') return removalError(error);
      const left = deadline - performance.now();
      if (left <= 0) return pendingAdvice;
      Bun.sleepSync(Math.min(50, left));
    }
  }
}

function removalReceipt(note) {
  if (!note) return;
  const [ticket, , identity] = note.toString().split('\n');
  if (!/^[0-9a-f]{32}$/.test(ticket) || !identity) return;
  const [profile, ...hashes] = identity.split(' ');
  if (DIGEST.test(profile) && hashes.length && hashes.every(hash => DIGEST.test(hash))) return { ticket, profile, hashes };
}

const sameInstallation = (receipt, directory, hashes) => receipt.profile === specDigest(resolve(directory)) &&
  hashes.some(hash => receipt.hashes.includes(hash));

// Retry once. An enabled alias cancels its own receipt; foreign profiles and install specs leave it intact.
function retryPendingRemoval(root, directory, specs) {
  try {
    const receipt = removalReceipt(readFile(root, CLEANUP_NOTE));
    const hashes = Array.from(specs, specDigest);
    if (!receipt || !sameInstallation(receipt, directory, hashes)) return '';
    return tryRemoval(root, directory, receipt.ticket, [...receipt.hashes, ...hashes], 0);
  } catch (error) {
    return removalError(error);
  }
}

function deferRemoval(root, directory, specs, sourceFd) {
  const ticket = randomBytes(16).toString('hex');
  const hashes = Array.from(specs, specDigest);
  if (windows) {
    // Magpie closes the host's Windows job on exit. Save recovery first and leave room in its two-second stop window.
    // Both native locks may be busy. Serialize receipt publication separately for profiles sharing a data directory.
    try {
      const receipt = withLock(root, '.magpie-oleafly-cleanup.lock', () => {
        const existing = removalReceipt(readFile(root, CLEANUP_NOTE));
        if (existing) return existing;
        const profile = specDigest(resolve(directory));
        replace(root, CLEANUP_NOTE, [ticket, pendingAdvice, [profile, ...hashes].join(' '), ''].join('\n'));
        return { ticket, profile, hashes };
      });
      if (!sameInstallation(receipt, directory, hashes)) {
        return 'Another Magpie profile or installation has a pending Oleafly cleanup. Finish that cleanup before retrying removal.';
      }
      return tryRemoval(root, directory, receipt.ticket, [...receipt.hashes, ...hashes], 750);
    } catch (error) {
      return removalError(error);
    }
  }
  replace(root, CLEANUP_NOTE, ticket + '\nWaiting for Oleafly to release its configuration lock.\n');
  const child = spawn(process.execPath, ['-', root, directory, ticket, ...hashes], {
    cwd: '/', detached: true, stdio: [sourceFd, 'ignore', 'ignore'],
  });
  child.unref();
  return `Oleafly cleanup is waiting for its configuration lock. Any conflict will be recorded in ${join(root, CLEANUP_NOTE)}.`;
}

function cancelPendingRemoval(root) {
  const note = readFile(root, CLEANUP_NOTE);
  if (note && /^[0-9a-f]{32}\n/.test(note.toString()) && !removalReceipt(note)) {
    fs.rmSync(join(root, CLEANUP_NOTE), { force: true });
  }
}

module.exports = { reconcile, deferRemoval, retryPendingRemoval, cancelPendingRemoval };

// Magpie can unload the package while Oleafly is still writing. The host passes
// this already-open module on stdin so this one cleanup can finish after unload.
if (process.argv[1] === '-' && basename(module.filename) === '[stdin]') {
  const [root, directory, ticket, ...specs] = process.argv.slice(2);
  try {
    finishRemoval(root, directory, ticket, specs, true);
  } catch (error) {
    if (currentRemoval(root, ticket)) replace(root, CLEANUP_NOTE, removalError(error) + '\n');
    process.exitCode = 1;
  }
}
