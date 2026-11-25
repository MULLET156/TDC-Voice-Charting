'use strict';
// CONTRACT §3, §4, §5, §8: signatures, roles, manifest, tiles, health, logs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

test('health needs no signature; everything else does', async () => {
  const t = await startApp();
  try {
    const h = await t.request('GET', '/health', { sign: false });
    assert.equal(h.status, 200);
    assert.deepEqual(h.json(), { ok: true, version: require('../package.json').version, contract: 1 });
    for (const p of ['/', '/manifest.json', '/tiles/drafts', '/history', '/settings', '/static/voice.js']) {
      assert.equal((await t.request('GET', p, { sign: false })).status, 401, p);
    }
    assert.equal((await t.request('POST', '/draft', { sign: false, body: { pat: '8133', kind: 'plan', dictation: 'x' } })).status, 401);
  } finally { await t.close(); }
});

test('wrong, old, future and tampered signatures get 401', async () => {
  const t = await startApp();
  try {
    assert.equal((await t.request('GET', '/', { time: Date.now() - 31000 })).status, 401, 'old');
    assert.equal((await t.request('GET', '/', { time: Date.now() + 31000 })).status, 401, 'future');
    // Signed as an assistant, then the roles were changed to owner.
    const { tdcSignature } = require('../lib/tdc-verify');
    const time = String(Date.now());
    const sig = tdcSignature(require('./helpers').SECRET, time, 'GET', '/', 'asst1', 'assistant', '/m/voice');
    const res = await fetch(`http://127.0.0.1:${t.port}/`, { headers: { 'X-TDC-User': 'asst1', 'X-TDC-Roles': 'owner', 'X-TDC-Base': '/m/voice', 'X-TDC-Time': time, 'X-TDC-Sig': sig } });
    assert.equal(res.status, 401, 'roles changed after signing');
  } finally { await t.close(); }
});

test('manifest follows CONTRACT §4', async () => {
  const t = await startApp();
  try {
    const m = (await t.request('GET', '/manifest.json', { user: 'dashboard', roles: 'system' })).json();
    assert.equal(m.contract, 1);
    assert.equal(m.id, 'voice');
    assert.equal(m.icon, 'mic');
    assert.deepEqual(m.roles.sort(), ['assistant', 'doctor', 'hygienist', 'owner']);
    assert.deepEqual(m.tiles.map((x) => x.id), ['drafts', 'unsigned']);
    assert.deepEqual(m.tiles.find((x) => x.id === 'unsigned').roles.sort(), ['doctor', 'hygienist', 'owner']);
    for (const n of m.nav) assert.ok(n.path.startsWith('/'));
  } finally { await t.close(); }
});

test('roles: front desk is kept out; settings are owner/admin only', async () => {
  const t = await startApp();
  try {
    assert.equal((await t.request('GET', '/', t.as.front)).status, 403);
    assert.equal((await t.request('GET', '/tiles/drafts', t.as.front)).status, 403);
    assert.equal((await t.request('GET', '/tiles/unsigned', t.as.assistant)).status, 403);
    assert.equal((await t.request('GET', '/settings', t.as.doctor)).status, 403);
    assert.equal((await t.request('GET', '/settings', t.as.owner)).status, 200);
    assert.equal((await t.request('GET', '/settings', t.as.admin)).status, 200);
    assert.equal((await t.request('GET', '/', t.as.assistant)).status, 200);
  } finally { await t.close(); }
});

test('tiles are JSON with at most 8 items and module-relative links', async () => {
  const t = await startApp();
  try {
    for (const [p, who] of [['/tiles/drafts', t.as.assistant], ['/tiles/unsigned', t.as.doctor]]) {
      const r = await t.request('GET', p, who);
      assert.equal(r.status, 200);
      const tile = r.json();
      for (const k of ['title', 'value', 'status', 'items', 'link', 'updated']) assert.ok(k in tile, `${p} ${k}`);
      assert.ok(['ok', 'warn', 'alert'].includes(tile.status));
      assert.ok(tile.items.length <= 8);
      for (const i of tile.items) { assert.ok(!/[<>]/.test(i.text)); if (i.href) assert.ok(i.href.startsWith('/') && !i.href.startsWith('//')); }
      assert.ok(!/\d{3}-\d{3}-\d{4}|SSN|Birthdate/i.test(r.text), 'no phone numbers, birthdates or SSNs');
    }
    const u = (await t.request('GET', '/tiles/unsigned', t.as.doctor)).json();
    assert.equal(u.value, '1 unsigned');
  } finally { await t.close(); }
});

test('request logs are one JSON line each, with no query strings', async () => {
  const t = await startApp();
  try {
    await t.request('GET', '/?q=Applewood', t.as.doctor);
    const lines = t.logs.map((l) => JSON.parse(l)).filter((l) => l.method);
    const last = lines[lines.length - 1];
    assert.equal(last.path, '/');
    assert.equal(last.user, 'drsmith');
    for (const k of ['time', 'user', 'method', 'path', 'status', 'ms']) assert.ok(k in last);
    assert.ok(!t.logs.join('\n').includes('Applewood'));
  } finally { await t.close(); }
});
