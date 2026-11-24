'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { removeSkillCopies } = require('../skills.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oleafly-skill-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillsDir = path.join(root, 'skills');
  const librarySkillsDir = path.join(root, 'magpie', 'library', 'skills');
  fs.mkdirSync(skillsDir);
  const at = (name, ...rest) => path.join(skillsDir, name, ...rest);
  const owned = [];
  function copy(name, libraryDir = librarySkillsDir) {
    const directory = at(name);
    fs.mkdirSync(at(name, 'references'), { recursive: true });
    fs.writeFileSync(at(name, 'SKILL.md'), 'instructions');
    fs.writeFileSync(at(name, 'references', 'guide.txt'), 'guide');
    const hash = createHash('sha256').update('file SKILL.md 12\ninstructionsfile references/guide.txt 5\nguide').digest('hex');
    fs.writeFileSync(at(name, '.magpie-library'), `copied from ${path.join(libraryDir, name)} by magpie, and copied again when it changes\nhash ${hash}\n`);
    owned.push(name);
    return directory;
  }
  const sync = (options) => removeSkillCopies({ skillsDir, librarySkillsDir, ...options,
    library: { applied: { oleafly: { skills: owned } } } });
  return { at, copy, owned, root, sync };
}

test('Windows skill cleanup rejects names that alias another path', { skip: process.platform !== 'win32' }, t => {
  const { copy, owned, sync, at } = fixture(t);
  copy('paper');
  for (const alias of ['paper.', '.. ', 'NUL.txt']) {
    owned.push(alias);
    assert.throws(() => sync(), /Invalid Oleafly skill cleanup inputs/);
    owned.pop();
    assert.ok(fs.existsSync(at('paper', 'SKILL.md')));
  }
});

test('disable removes unchanged owned copies while preserving edited assets and user skills', (t) => {
  const { at, copy, owned, sync } = fixture(t);
  copy('pristine');
  copy('edited');
  fs.writeFileSync(at('edited', 'references', 'guide.txt'), 'user edit');
  copy('other-library', '/other/magpie/library/skills');
  copy('unowned');
  owned.pop();
  fs.mkdirSync(at('user'));
  fs.writeFileSync(at('user', 'SKILL.md'), 'user instructions');
  owned.push('user');

  const result = sync();
  assert.deepEqual(result.removed, ['pristine']);
  assert.deepEqual(result.issues.map((issue) => issue.name), ['edited']);
  assert.deepEqual(sync(), { removed: [], issues: result.issues });
  assert.equal(fs.existsSync(at('pristine')), false);
  assert.equal(fs.readFileSync(at('edited', 'references', 'guide.txt'), 'utf8'), 'user edit');
  assert.equal(fs.readFileSync(at('user', 'SKILL.md'), 'utf8'), 'user instructions');
  assert.ok(fs.existsSync(at('other-library')));
  assert.ok(fs.existsSync(at('unowned')));
});

test('cleanup preserves a bundled folder with Oleafly’s provenance marker', (t) => {
  const { at, copy, sync } = fixture(t);
  copy('bundled');
  fs.writeFileSync(at('bundled', '.oleafly-first-party'), 'oleafly-first-party-v1\n');
  assert.deepEqual(sync(), { removed: [], issues: [] });
  assert.ok(fs.existsSync(at('bundled')));
});

test('retry completes an interrupted retirement even after the live skills directory is gone', (t) => {
  const { at, copy, root, sync } = fixture(t);
  copy('pending');
  const failure = t.mock.method(fs, 'rmSync', () => { throw new Error('busy'); });
  const paused = sync();
  failure.mock.restore();
  const [retired] = fs.readdirSync(root).filter(name => name.startsWith('.magpie-oleafly-retired-'));
  assert.equal(paused.issues[0].name, 'pending');
  assert.ok(paused.issues[0].message.includes(path.join(root, retired)));
  assert.ok(fs.existsSync(path.join(root, retired, 'pending', 'SKILL.md')));
  fs.rmdirSync(at(''));

  assert.deepEqual(sync(), { removed: ['pending'], issues: [] });
  assert.ok(!fs.existsSync(path.join(root, retired)));
  assert.deepEqual(sync(), { removed: [], issues: [] });
});

test('restart recovers the retired copy and preserves a newly applied live copy of the same skill', (t) => {
  const { at, copy, root, sync } = fixture(t);
  const retired = fs.mkdtempSync(path.join(root, '.magpie-oleafly-retired-'));
  fs.renameSync(copy('notes'), path.join(retired, 'notes'));
  copy('notes');

  assert.deepEqual(sync({ retiredOnly: true }), { removed: ['notes'], issues: [] });
  assert.ok(!fs.existsSync(retired));
  assert.equal(fs.readFileSync(at('notes', 'SKILL.md'), 'utf8'), 'instructions');
});

test('retired copies with edits, missing ownership or a foreign receipt remain available for review', (t) => {
  const { copy, owned, root, sync } = fixture(t);
  const paths = new Map();
  for (const name of ['edited', 'foreign', 'partial', 'unowned']) {
    const retired = fs.mkdtempSync(path.join(root, '.magpie-oleafly-retired-'));
    const directory = path.join(retired, name);
    fs.renameSync(copy(name, name === 'foreign' ? '/other/library' : undefined), directory);
    paths.set(name, directory);
  }
  owned.pop();
  fs.writeFileSync(path.join(paths.get('edited'), 'SKILL.md'), 'my notes');
  fs.unlinkSync(path.join(paths.get('partial'), '.magpie-library'));

  const result = sync();
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.issues.map(issue => issue.name).sort(), [...paths.keys()]);
  for (const { name, message } of result.issues) {
    assert.ok(message.includes(path.dirname(paths.get(name))));
    assert.ok(fs.existsSync(path.join(paths.get(name), 'SKILL.md')));
  }
  assert.equal(fs.readFileSync(path.join(paths.get('edited'), 'SKILL.md'), 'utf8'), 'my notes');
  assert.deepEqual(sync(), result);
});

test('retry clears an empty retirement directory after the last copy was removed', (t) => {
  const { root, sync } = fixture(t);
  const empty = fs.mkdtempSync(path.join(root, '.magpie-oleafly-retired-'));
  assert.deepEqual(sync(), { removed: [], issues: [] });
  assert.ok(!fs.existsSync(empty));
});

test('recovery never follows a linked retirement directory', (t) => {
  const { at, copy, root, sync } = fixture(t);
  copy('notes');
  const link = path.join(root, '.magpie-oleafly-retired-ABC123');
  fs.symlinkSync(at(''), link, process.platform === 'win32' ? 'junction' : 'dir');
  const result = sync({ retiredOnly: true });
  assert.deepEqual(result.removed, []);
  assert.ok(result.issues.some(issue => issue.message.includes(link)));
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.existsSync(at('notes', 'SKILL.md')));
});

test('refuses linked roots and never follows a linked skill or marker', (t) => {
  const { at, copy, owned, root, sync } = fixture(t);
  const target = path.join(root, 'unrelated');
  fs.mkdirSync(target);
  fs.symlinkSync(target, at('linked'), process.platform === 'win32' ? 'junction' : 'dir');
  owned.push('linked');
  copy('linked-marker');
  fs.renameSync(at('linked-marker', '.magpie-library'), path.join(target, 'receipt'));
  if (process.platform === 'win32') fs.linkSync(path.join(target, 'receipt'), at('linked-marker', '.magpie-library'));
  else fs.symlinkSync(path.join(target, 'receipt'), at('linked-marker', '.magpie-library'));
  assert.deepEqual(sync(), { removed: [], issues: [] });
  assert.ok(fs.existsSync(path.join(target, 'receipt')));
  fs.renameSync(at(''), path.join(root, 'real-skills'));
  fs.symlinkSync(path.join(root, 'real-skills'), at(''), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => sync(), /not a real directory/);
});
