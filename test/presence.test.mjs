import assert from 'node:assert/strict';
import { Presence, deviceLabel, normalizeIp } from '../lib/presence.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('presence');

test('IPv6 映射地址还原成 IPv4', () => {
  assert.equal(normalizeIp('::ffff:192.168.1.7'), '192.168.1.7');
  assert.equal(normalizeIp('192.168.1.7'), '192.168.1.7');
  assert.equal(normalizeIp(undefined), '');
});

test('设备标签只给粗粒度结果', () => {
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'iPhone');
  assert.equal(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'Mac');
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'Windows');
  assert.equal(deviceLabel('curl/8.4.0'), '脚本');
  assert.equal(deviceLabel(''), '未知设备');
});

test('访客进出会改变计数', () => {
  const presence = new Presence();
  assert.deepEqual(presence.stats(), { viewers: 0, devices: 0, admins: 0 });
  const a = presence.join({ ip: '::ffff:10.0.0.2', userAgent: 'iPhone' });
  const b = presence.join({ ip: '10.0.0.2', userAgent: 'iPhone' });
  presence.join({ ip: '10.0.0.9', userAgent: 'Macintosh' });
  // Two tabs from one phone are two viewers but one device.
  assert.deepEqual(presence.stats(), { viewers: 3, devices: 2, admins: 0 });
  presence.leave(a);
  assert.equal(presence.stats().viewers, 2);
  presence.leave(b);
  assert.deepEqual(presence.stats(), { viewers: 1, devices: 1, admins: 0 });
});

test('控制台连接不算访客', () => {
  const presence = new Presence();
  presence.join({ ip: '127.0.0.1', userAgent: 'Macintosh', admin: true });
  presence.join({ ip: '10.0.0.3', userAgent: 'Windows' });
  assert.deepEqual(presence.stats(), { viewers: 1, devices: 1, admins: 1 });
});

test('只暴露元数据，没有会话内容的入口', () => {
  const presence = new Presence();
  const id = presence.join({ ip: '10.0.0.4', userAgent: 'Windows' });
  presence.touch(id, { sessionId: 'sess-1' });
  const [viewer] = presence.list((sessionId) => (
    sessionId === 'sess-1' ? { name: '写周报', provider: 'Qoder CLI', model: 'qwen3-max' } : null
  ));
  assert.equal(viewer.sessionName, '写周报');
  assert.equal(viewer.model, 'qwen3-max');
  assert.deepEqual(Object.keys(viewer).sort(), [
    'admin', 'connectedAt', 'device', 'id', 'ip', 'lastSeenAt', 'model', 'provider',
    'sessionId', 'sessionName',
  ]);
});

test('touch 认不出的 id 会返回 false', () => {
  const presence = new Presence();
  assert.equal(presence.touch('nope', { sessionId: 'x' }), false);
});

test('空 sessionId 会归零而不是存空串', () => {
  const presence = new Presence();
  const id = presence.join({ ip: '10.0.0.5', userAgent: 'Linux' });
  presence.touch(id, { sessionId: 'sess-2' });
  presence.touch(id, { sessionId: '' });
  assert.equal(presence.list()[0].sessionId, null);
});

test('暂停共享只挂断访客', () => {
  const presence = new Presence();
  const closed = [];
  presence.join({ ip: '127.0.0.1', userAgent: 'Macintosh', admin: true, close: () => closed.push('admin') });
  presence.join({ ip: '10.0.0.6', userAgent: 'Windows', close: () => closed.push('guest1') });
  presence.join({ ip: '10.0.0.7', userAgent: 'Android', close: () => closed.push('guest2') });
  assert.equal(presence.disconnect(), 2);
  assert.deepEqual(closed.sort(), ['guest1', 'guest2']);
  assert.deepEqual(presence.stats(), { viewers: 0, devices: 0, admins: 1 });
});

test('踢单个连接', () => {
  const presence = new Presence();
  const keep = presence.join({ ip: '10.0.0.8', userAgent: 'Windows', close: () => {} });
  let kicked = false;
  const target = presence.join({ ip: '10.0.0.9', userAgent: 'Android', close: () => { kicked = true; } });
  assert.equal(presence.disconnect(target), 1);
  assert.equal(kicked, true);
  assert.equal(presence.stats().viewers, 1);
  assert.equal(presence.list()[0].id, keep);
});

test('close 抛错不会连累其他连接', () => {
  const presence = new Presence();
  presence.join({ ip: '10.0.1.1', userAgent: 'Windows', close: () => { throw new Error('socket gone'); } });
  let second = false;
  presence.join({ ip: '10.0.1.2', userAgent: 'Android', close: () => { second = true; } });
  assert.equal(presence.disconnect(), 1);
  assert.equal(second, true);
  assert.equal(presence.stats().viewers, 0);
});

console.log(`\nPRESENCE OK (${passed})`);
