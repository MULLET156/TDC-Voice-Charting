'use strict';
// Repo-wide rules: no inline scripts, no browser speech API, no outside fonts,
// no npm dependencies, vendored core unchanged, Claude never gets write tools.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { claudeTools, runClaudeTool, cleanSurf } = require('../lib/drafting');
const { READ_TOOLS, WRITE_TOOLS } = require('../lib/od');
const { startApp, makeDraft } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ours = () => [...fs.readdirSync(path.join(ROOT, 'lib')).map((f) => `lib/${f}`), ...fs.readdirSync(path.join(ROOT, 'public')).map((f) => `public/${f}`), 'server.js'];

test('never the browser speech API (Chrome sends audio to Google)', () => {
  for (const f of ours()) {
    assert.ok(!/SpeechRecognition|webkitSpeech|speechSynthesis/.test(read(f).replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')), f);
  }
});

test('no outside fonts or scripts, and no npm dependencies', () => {
  for (const f of ours()) assert.ok(!/fonts\.(googleapis|gstatic)\.com|use\.typekit|cdn\.|unpkg|jsdelivr/.test(read(f)), f);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

test('vendored opendental-core matches its CHECKSUMS (never edited)', () => {
  const dir = path.join(ROOT, 'vendor', 'opendental-core');
  for (const line of fs.readFileSync(path.join(dir, 'CHECKSUMS'), 'utf8').trim().split('\n')) {
    const [sum, name] = line.split(/\s+/);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex'), sum, name);
  }
});

test('Claude gets reading tools only; writing tools are a separate list', () => {
  for (const kind of ['plan', 'note']) {
    const names = claudeTools(kind).map((t) => t.name);
    for (const n of names) assert.ok(!/plan_procedure|create|add_|set_|append|remove|update|write/.test(n), n);
  }
  for (const w of WRITE_TOOLS) assert.ok(!READ_TOOLS.has(w));
});

test("Claude's tools always use the picked patient, whatever it asks for", async () => {
  const calls = [];
  const od = { read: async (name, args) => { calls.push([name, args]); return { results: [] }; }, getPatient: async (n) => ({ PatNum: n }), priorities: async () => [] };
  await runClaudeTool(od, 8133, '2026-11-16', 'get_current_chart', { pat_num: 101, status: 'TP' });
  await runClaudeTool(od, 8133, '2026-11-16', 'get_treatment_plans', { pat_num: 101 });
  assert.deepEqual(calls.map((c) => c[1].pat_num), [8133, 8133]);
  assert.deepEqual(await runClaudeTool(od, 8133, '2026-11-16', 'get_patient', { pat_num: 101 }), { PatNum: 8133 });
});

test('surfaces as spoken become letters', () => {
  assert.equal(cleanSurf('m o d'), 'MOD');
  assert.equal(cleanSurf('M-O-D'), 'MOD');
  assert.equal(cleanSurf('do'), 'DO');
});

test('rendered pages have no inline scripts and use the shared look', async () => {
  const t = await startApp();
  try {
    const id = await makeDraft(t, { who: t.as.doctor });
    for (const p of ['/', '/?pat=8133', '/?q=Apple', `/draft/${id}`, '/history', '/settings']) {
      const html = (await t.request('GET', p, t.as.owner)).text;
      for (const s of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
        assert.match(s[1], /\ssrc="/, `${p}: script without src`);
        assert.equal(s[2].trim(), '', `${p}: inline script`);
      }
      assert.ok(!/\son[a-z]+\s*=/i.test(html), `${p}: on...= attribute`);
      assert.match(html, /<link rel="stylesheet" href="\/shared\/tdc\.css">/);
      assert.match(html, /<script src="\/shared\/shell\.js" defer><\/script>/);
      assert.match(html, /<body data-module="voice">/);
      assert.match(html, /<main class="tdc-main">/);
      assert.match(html, /viewport-fit=cover/);
    }
  } finally { await t.close(); }
});

test('the dictation box does not send text to spell-check services', async () => {
  const t = await startApp();
  try {
    const html = (await t.request('GET', '/?pat=8133', t.as.doctor)).text;
    assert.match(html, /<textarea id="dictation"[^>]*spellcheck="false"/);
    assert.match(html, /<form class="tdc-dictate"[^>]*autocomplete="off"/);
  } finally { await t.close(); }
});
