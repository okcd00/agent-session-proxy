/**
 * Boots a real server in a throwaway copy of the repo and drives the admin
 * console API over HTTP. The copy matters: config.json holds the live
 * passphrase, and a test must never rewrite it.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARE = 'share-secret';
const ADMIN = 'admin-secret';
const PORT = 8700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(120);
  }
  return false;
}

async function call(pathname, { method = 'GET', body, token, admin } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (admin) headers['x-admin-token'] = admin;
  const res = await fetch(`${BASE}${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, data, text };
}

/** Minimal SSE client: enough to appear in the presence registry and read hello. */
function openStream({ token, admin } = {}) {
  const query = [token && `token=${token}`, admin && `admin=${admin}`].filter(Boolean).join('&');
  const controller = new AbortController();
  const viewer = { hello: null, events: [], closed: false, close: () => controller.abort() };
  viewer.ready = (async () => {
    const res = await fetch(`${BASE}/api/stream?${query}`, { signal: controller.signal });
    if (!res.ok) {
      viewer.closed = true;
      viewer.status = res.status;
      return;
    }
    viewer.status = res.status;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ') && event) {
            const payload = JSON.parse(line.slice(6));
            if (event === 'hello') viewer.hello = payload;
            viewer.events.push([event, payload]);
            event = null;
          }
          index = buffer.indexOf('\n');
        }
      }
    } catch { /* aborted or hung up by the server */ }
    viewer.closed = true;
  })();
  return viewer;
}

async function adminState() {
  const { status, data } = await call('/api/admin/state', { admin: ADMIN });
  assert.equal(status, 200, `admin state returned ${status}`);
  return data;
}

async function main() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'asp-admin-test-'));
  const workspace = path.join(dir, 'ws');
  const app = path.join(dir, 'app');
  const skip = new Set(['config.json', 'sessions.json', '.git', 'node_modules', 'shared_workspace']);
  cpSync(ROOT, app, {
    recursive: true,
    filter: (src) => !skip.has(path.basename(src)) || src === ROOT,
  });

  const child = spawn('node', [
    'server.js', '--port', String(PORT), '--host', '127.0.0.1',
    '--token', SHARE, '--admin-token', ADMIN, '--workspace', workspace,
    // A stub binary keeps the test off the real CLIs: session metadata is all
    // these routes report, and none of it needs a working agent.
    '--qodercli', '/bin/echo', '--codex', '/bin/echo',
  ], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });

  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });

  const streams = [];
  try {
    const up = await until(async () => {
      try {
        return (await call('/api/health')).status === 200;
      } catch {
        return false;
      }
    }, 15_000);
    check('服务起来了', up, log.slice(-400));
    if (!up) return;

    console.log('\n  权限隔离');
    check('health 报 sharing=true', (await call('/api/health')).data.sharing === true);
    check('无口令访问 admin → 401', (await call('/api/admin/state')).status === 401);
    check('分享口令当管理口令 → 401', (await call('/api/admin/state', { admin: SHARE })).status === 401);
    check('Bearer 分享口令进不了 admin → 401', (await call('/api/admin/state', { token: SHARE })).status === 401);
    check('管理口令 → 200', (await call('/api/admin/state', { admin: ADMIN })).status === 200);
    check('分享口令关不掉服务', (await call('/api/admin/shutdown', { method: 'POST', token: SHARE })).status === 401);
    check('服务还活着', child.exitCode === null);
    check('管理口令进不了聊天接口', (await call('/api/sessions', { admin: ADMIN })).status === 401);

    console.log('\n  访客计数');
    const guest = openStream({ token: SHARE });
    streams.push(guest);
    check('访客收到 hello', await until(async () => guest.hello !== null));
    const viewerId = guest.hello?.viewerId;
    check('hello 带 viewerId', typeof viewerId === 'string' && viewerId.length > 0);
    check('控制台看到 1 位访客', await until(async () => (await adminState()).stats.viewers === 1));

    const hostTab = openStream({ token: SHARE, admin: ADMIN });
    streams.push(hostTab);
    check('主人自己的页签也能连', await until(async () => hostTab.hello !== null));
    const withHost = await adminState();
    check('主人不算访客', withHost.stats.viewers === 1, withHost.stats);
    check('主人被标记为 admin', withHost.stats.admins === 1, withHost.stats);

    console.log('\n  会话可见、内容不可见');
    const created = await call('/api/sessions', {
      method: 'POST', token: SHARE,
      body: { name: '测试会话', provider: 'qodercli', cwd: workspace },
    });
    check('建会话 201', created.status === 201, created.data);
    const sid = created.data.session.id;

    check('上报在看的会话', (await call('/api/presence', {
      method: 'POST', token: SHARE, body: { viewerId, sessionId: sid },
    })).status === 200);
    const watched = await adminState();
    const watcher = watched.viewers.find((v) => !v.admin);
    check('控制台显示会话名', watcher.sessionName === '测试会话', watcher);
    check('控制台显示后端', /Qoder/.test(watcher.provider), watcher);
    check('控制台带来源 IP', ['127.0.0.1', '::1'].includes(watcher.ip), watcher);
    check('控制台没有 transcript 字段', !('transcript' in watcher));

    const blob = JSON.stringify(watched);
    check('admin/state 不含 transcript', !blob.includes('transcript'));
    check('admin/state 不含 live 流式文本', !blob.includes('"live"'));
    const row = watched.sessions.find((s) => s.id === sid);
    check('会话行有模型字段', 'model' in row, row);
    check('会话行没有内容字段', !('transcript' in row) && !('live' in row), Object.keys(row));

    console.log('\n  暂停 / 恢复');
    const paused = await call('/api/admin/sharing', { method: 'POST', admin: ADMIN, body: { enabled: false } });
    check('暂停返回 sharing=false', paused.data.sharing === false, paused.data);
    check('暂停断开了访客', paused.data.disconnected >= 1, paused.data);
    check('访客流被挂断', await until(async () => guest.closed));
    check('主人的页签没被挂断', hostTab.closed === false);
    const denied = await call('/api/sessions', { token: SHARE });
    check('访客请求 → 503', denied.status === 503, denied.status);
    check('503 带 sharing=false', denied.data?.sharing === false, denied.data);
    check('health 报 sharing=false', (await call('/api/health')).data.sharing === false);
    check('暂停时控制台仍可用', (await call('/api/admin/state', { admin: ADMIN })).status === 200);
    check('主人带管理口令仍可聊天', (await call('/api/sessions', { token: SHARE, admin: ADMIN })).status === 200);

    const resumed = await call('/api/admin/sharing', { method: 'POST', admin: ADMIN, body: { enabled: true } });
    check('恢复返回 sharing=true', resumed.data.sharing === true, resumed.data);
    check('恢复后访客可用', (await call('/api/sessions', { token: SHARE })).status === 200);

    console.log('\n  踢人与断线回收');
    const guest2 = openStream({ token: SHARE });
    streams.push(guest2);
    check('新访客接入', await until(async () => guest2.hello !== null));
    const kicked = await call('/api/admin/kick', {
      method: 'POST', admin: ADMIN, body: { viewerId: guest2.hello.viewerId },
    });
    check('踢人返回 1', kicked.data.disconnected === 1, kicked.data);
    check('被踢的流断开', await until(async () => guest2.closed));
    check('踢完计数归零', await until(async () => (await adminState()).stats.viewers === 0));

    const guest3 = openStream({ token: SHARE });
    streams.push(guest3);
    check('再接一个', await until(async () => (await adminState()).stats.viewers === 1));
    guest3.close();
    check('主动断开后计数归零', await until(async () => (await adminState()).stats.viewers === 0));

    console.log('\n  地址与落盘');
    const state = await adminState();
    check('绑定单地址时只广告该地址', state.lanUrls.length === 1
      && state.lanUrls[0] === `http://127.0.0.1:${PORT}`, state.lanUrls);
    check('分享链接带口令', state.shareUrl === `http://127.0.0.1:${PORT}/?token=${SHARE}`, state.shareUrl);
    const config = JSON.parse(readFileSync(path.join(app, 'config.json'), 'utf8'));
    check('config.json 存了 adminToken', config.adminToken === ADMIN);
    check('config.json 存了 token', config.token === SHARE);

    console.log('\n  控制台关闭服务');
    const stopping = await call('/api/admin/shutdown', { method: 'POST', admin: ADMIN });
    check('shutdown 返回 ok', stopping.data?.stopping === true, stopping.data);
    check('进程真的退出了', await until(async () => child.exitCode !== null, 10_000), child.exitCode);
  } finally {
    for (const stream of streams) stream.close();
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length) {
    console.log(`\n${passed} passed, ${failures.length} failed`);
    console.log('--- server log ---');
    console.log(log.slice(-2_000));
    process.exit(1);
  }
  console.log(`\nADMIN OK (${passed})`);
}

console.log('admin console');
await main();
