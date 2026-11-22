/*
 * In-process test runner.
 *
 * `node --test test/` spawns one child process per test file, which is
 * blocked in sandboxed environments (spawn EPERM). Importing the test files
 * here registers their tests with node:test and runs them in this process,
 * which behaves identically for our purposes.
 *
 * Run with:  npm test
 */

import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const testDir = path.join(process.cwd(), 'test');
const files = (await readdir(testDir)).filter((f) => f.endsWith('.test.mjs')).sort();

for (const f of files) {
  await import(pathToFileURL(path.join(testDir, f)).href);
}
