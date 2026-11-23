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
  const sync = () => removeSkillCopies({ skillsDir, librarySkillsDir,
    library: { applied: { oleafly: { skills: owned } } } });
  return { at, copy, owned, root, sync };
}

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

test('refuses linked roots and never follows a linked skill or marker', (t) => {
  const { at, copy, owned, root, sync } = fixture(t);
  const target = path.join(root, 'unrelated');
  fs.mkdirSync(target);
  fs.symlinkSync(target, at('linked'));
  owned.push('linked');
  copy('linked-marker');
  fs.renameSync(at('linked-marker', '.magpie-library'), path.join(target, 'receipt'));
  fs.symlinkSync(path.join(target, 'receipt'), at('linked-marker', '.magpie-library'));
  assert.deepEqual(sync(), { removed: [], issues: [] });
  assert.ok(fs.existsSync(path.join(target, 'receipt')));
  fs.renameSync(at(''), path.join(root, 'real-skills'));
  fs.symlinkSync(path.join(root, 'real-skills'), at(''));
  assert.throws(() => sync(), /not a real directory/);
});
