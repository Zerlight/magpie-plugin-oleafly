const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');

// Windows transactions use the same Win32 FFI bindings as the Magpie Bun host.
const windows = process.platform === 'win32';
const runtime = windows ? process.env.MAGPIE_BUN || 'bun' : process.execPath;
const flags = windows ? ['test', '--timeout', '60000'] : ['--test'];
const tests = readdirSync(__dirname).filter(name => name.endsWith('.test.cjs')).map(name => './test/' + name);
const run = spawnSync(runtime, [...flags, ...tests], { cwd: path.dirname(__dirname), stdio: 'inherit' });
if (run.error) console.error(windows ? 'Set MAGPIE_BUN to the Magpie Bun executable and retry.' : run.error.message);
process.exitCode = run.status ?? 1;
