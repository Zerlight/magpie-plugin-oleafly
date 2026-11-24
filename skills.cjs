'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const marker = '.magpie-library';
const validId = (name) => typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && !/[\\/:\p{Cc}\p{Cs}]/u.test(name) &&
  (process.platform !== 'win32' || !/[. ]$|[<>"|?*]|^(?:con|prn|aux|nul|(?:com|lpt)[1-9¹²³])(?:\.|$)/i.test(name));
const sortNames = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameVersion = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function stat(file) {
  return fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
}

function readRegular(file, before, consume) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameVersion(before, opened)) throw new Error('Skill file changed');
    consume(fd);
    if (!sameVersion(opened, fs.fstatSync(fd, { bigint: true }))) throw new Error('Skill file changed');
  } finally {
    fs.closeSync(fd);
  }
}

// Match Magpie's pinned hashWalk order and byte framing for the files it copies.
function copyHash(root, copiedAt) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  function walk(dir, prefix) {
    const before = stat(dir);
    if (!before?.isDirectory()) throw new Error('Skill directory changed');
    for (const name of fs.readdirSync(dir).sort(sortNames)) {
      if (!prefix && name === marker) continue;
      const file = path.join(dir, name);
      const relative = prefix + name;
      const item = stat(file);
      if (name.includes('\uFFFD') || name === '.git' || !item) throw new Error('Unsupported skill entry');
      if (item.ctimeNs > copiedAt) return false;
      if (item.isDirectory()) {
        if (!walk(file, `${relative}/`)) return false;
      } else if (item.isSymbolicLink()) {
        const target = process.platform === 'win32' ? fs.readlinkSync(file).split(path.sep).join('/') : fs.readlinkSync(file, { encoding: 'buffer' });
        if (!sameVersion(item, stat(file))) throw new Error('Skill link changed');
        hash.update(`link ${relative} `).update(target).update('\n');
      } else {
        hash.update(`file ${relative} ${item.size}\n`);
        readRegular(file, item, (fd) => {
          for (let bytes; (bytes = fs.readSync(fd, buffer)) > 0;) hash.update(buffer.subarray(0, bytes));
        });
      }
    }
    if (!sameVersion(before, stat(dir))) throw new Error('Skill directory changed');
    return true;
  }
  return walk(root, '') ? hash.digest('hex') : null;
}

function copyReceipt(directory, expectedSource) {
  if (stat(path.join(directory, '.oleafly-first-party')) || stat(path.join(directory, '.oleafly-skill.json'))) return null;
  const file = path.join(directory, marker);
  const info = stat(file);
  if (!info?.isFile() || info.nlink !== 1n || info.size > 8192n) return null;
  let receipt;
  readRegular(file, info, (fd) => { receipt = fs.readFileSync(fd, 'utf8'); });
  const prefix = `copied from ${expectedSource} by magpie, and copied again when it changes\nhash `;
  const hash = receipt.startsWith(prefix) && receipt.slice(prefix.length);
  return hash && /^[a-f0-9]{64}\n$/.test(hash) ? { hash: hash.trim(), copiedAt: info.ctimeNs } : null;
}

function removeSkillCopies({ skillsDir, librarySkillsDir, library, retiredOnly = false }) {
  const owned = library?.applied?.oleafly?.skills ?? [];
  if (!Array.isArray(owned) || !owned.every(validId) ||
      !path.isAbsolute(skillsDir) || !path.isAbsolute(librarySkillsDir)) {
    throw new Error('Invalid Oleafly skill cleanup inputs. Check the Oleafly and Magpie Library paths.');
  }
  const removed = new Set();
  const issues = [];
  const candidates = new Set(owned);
  const root = path.dirname(skillsDir);
  const dataDir = stat(root);
  if (!dataDir) return { removed: [], issues };
  const live = stat(skillsDir);
  if (!dataDir.isDirectory() || (live && (!live.isDirectory() ||
      fs.realpathSync(skillsDir) !== path.join(fs.realpathSync(root), path.basename(skillsDir))))) {
    throw new Error('Oleafly’s skills directory is not a real directory in its data folder. Check the skills path before cleanup.');
  }

  function finishRetirement(retired, expected) {
    let name = expected?.name ?? path.basename(retired);
    try {
      const parent = stat(retired);
      if (!parent) return;
      if (!parent.isDirectory()) throw new Error('Unexpected retirement path');
      const entries = fs.readdirSync(retired);
      if (entries.length > 1) throw new Error('Unexpected retirement contents');
      if (entries.length) {
        [name] = entries;
        const moved = path.join(retired, name);
        const item = stat(moved);
        if (!candidates.has(name) || !item?.isDirectory() ||
            (expected && (expected.name !== name || !sameFile(expected.before, item)))) {
          throw new Error('Skill ownership changed');
        }
        const receipt = copyReceipt(moved, path.join(librarySkillsDir, name));
        if (!receipt || (expected && (receipt.hash !== expected.hash || receipt.copiedAt !== expected.copiedAt)) ||
            copyHash(moved, receipt.copiedAt) !== receipt.hash || !sameVersion(parent, stat(retired))) {
          throw new Error('Cannot verify the retired copy against its Magpie receipt');
        }
        fs.rmSync(moved, { recursive: true });
        removed.add(name);
      }
      fs.rmdirSync(retired);
    } catch (error) {
      issues.push({ name, message: `Skill cleanup paused (${error.code || error.message}). Review the retained files at ${retired} before retrying.` });
    }
  }

  for (const entry of fs.readdirSync(root)) {
    if (/^\.magpie-oleafly-retired-[A-Za-z0-9]{6}$/.test(entry)) finishRetirement(path.join(root, entry));
  }
  if (retiredOnly || !live) return { removed: [...removed], issues };

  for (const name of candidates) {
    const directory = path.join(skillsDir, name);
    const before = stat(directory);
    if (!before?.isDirectory()) continue;
    const source = path.join(librarySkillsDir, name);
    try {
      const receipt = copyReceipt(directory, source);
      if (!receipt) continue;
      if (copyHash(directory, receipt.copiedAt) !== receipt.hash) {
        issues.push({ name, message: 'Kept the Magpie skill copy because it has local edits. Review it in Oleafly.' });
        continue;
      }

      const retired = fs.mkdtempSync(path.join(root, '.magpie-oleafly-retired-'));
      const moved = path.join(retired, name);
      // Recheck after unregistration so a concurrent replacement is recoverable.
      fs.renameSync(directory, moved);
      finishRetirement(retired, { name, before, ...receipt });
    } catch {
      issues.push({ name, message: 'Skill cleanup paused. Check the copy in Oleafly and retry.' });
    }
  }
  return { removed: [...removed], issues };
}

module.exports = { removeSkillCopies };
