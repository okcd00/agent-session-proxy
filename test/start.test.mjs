/**
 * Smoke-tests every `start.sh` argument path. `--help` makes server.js print and
 * exit, so this exercises the launcher's own quoting and variable handling
 * without binding a port or touching config.json.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile('./start.sh', args, { cwd: ROOT, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout, stderr });
    });
  });
}

function record(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}  ${detail}`);
  }
}

async function check(name, args, env) {
  const { code, stdout, stderr } = await run(args, env);
  record(name, code === 0 && stdout.includes('Usage: node server.js'), `exit=${code}\n${stderr.trim()}`);
  return stdout + stderr;
}

console.log('start.sh');

await check('不给口令时交给 config.json', ['--help']);
await check('命令行给口令', ['我的口令', '--help']);
await check('ASP_TOKEN 给口令', ['--help'], { ASP_TOKEN: '环境变量口令' });
await check('ASP_ADMIN_TOKEN 一起给', ['我的口令', '--help'], { ASP_ADMIN_TOKEN: '管理口令' });
await check('只给 ASP_ADMIN_TOKEN', ['--help'], { ASP_ADMIN_TOKEN: '管理口令' });

const empty = await run(['', '--help']);
record('显式给空口令要报错', empty.code !== 0, `exit=${empty.code}`);

// A passphrase committed to the repo is a public one, so TOKEN may only ever come
// from an argument or the environment — never from a literal in this file.
const source = readFileSync(path.join(ROOT, 'start.sh'), 'utf8');
const assignments = source.match(/^\s*TOKEN=.*$/gm) ?? [];
const literal = assignments.filter((line) => !/^\s*TOKEN=(''|"\$1"|"\$ASP_TOKEN")\s*$/.test(line));
record('start.sh 里没有写死的口令', assignments.length > 0 && literal.length === 0, literal.join(' | '));

if (failures.length) {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`\nSTART OK (${passed})`);
