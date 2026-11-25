'use strict';
// The whole flow with made-up data: pick patient -> dictate -> Draft -> review
// -> Confirm -> write -> read back. Writes happen only after Confirm, only by a
// confirming role, only to allowed patients, and are never signed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeDraft, formState, fakeGateway, fakeClaude, PLAN_ANSWER } = require('./helpers');

function editForm(html, extra = {}) {
  const { version, ids } = formState(html);
  const f = new URLSearchParams({ version });
  for (const { i, id } of ids) {
    f.set(`l${i}.id`, id);
    for (const k of ['procCode', 'tooth', 'surfaces', 'toothRange', 'note']) {
      const m = html.match(new RegExp(`name="l${i}\\.${k}" value="([^"]*)"`));
      if (m) f.set(`l${i}.${k}`, m[1]);
    }
    const sel = html.match(new RegExp(`name="l${i}\\.priorityDefNum"[^>]*>([\\s\\S]*?)</select>`));
    if (sel) { const s = sel[1].match(/value="(\d+)" selected/); f.set(`l${i}.priorityDefNum`, s ? s[1] : '0'); }
  }
  f.set('target', 'none');
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
}

test('patient search finds by last name, "Last, First" and number', async () => {
  const t = await startApp();
  try {
    let r = await t.request('GET', '/?q=Apple', t.as.doctor);
    assert.match(r.text, /Applewood, Dana/);
    assert.match(r.text, /Applegate, Sam/);
    r = await t.request('GET', `/?q=${encodeURIComponent('Applegate, S')}`, t.as.doctor);
    assert.ok(!r.text.includes('Applewood'));
    r = await t.request('GET', '/?q=8133', t.as.doctor);
    assert.match(r.text, /Testpatient, Rae/);
    r = await t.request('GET', '/?pat=8133', t.as.doctor);
    assert.match(r.text, /id="dictation"[^>]*autofocus/);
    assert.match(r.text, /Tap here and dictate with Wispr Flow, or type/);
  } finally { await t.close(); }
});

test('assistant drafts; Claude only gets read tools; nothing is written until Confirm', async () => {
  const t = await startApp();
  try {
    const id = await makeDraft(t, { who: t.as.assistant });
    assert.equal(t.gateway.writes().length, 0, 'no writes while drafting');
    // Claude's tools: reading and the draft hand-in only.
    const tools = t.claude.requests[0].body.tools.map((x) => x.name).sort();
    assert.deepEqual(tools, ['get_current_chart', 'get_patient', 'get_treatment_plans', 'list_priorities', 'lookup_procedure_code', 'submit_draft']);
    assert.ok(t.claude.requests[0].body.messages[0].content.includes('Crown on thirty'));
    assert.equal(t.claude.requests[0].headers['x-api-key'], 'sk-test-not-real');

    const page = await t.request('GET', `/draft/${id}`, t.as.assistant);
    assert.equal(page.status, 200);
    assert.match(page.text, /value="D2740"/);
    assert.match(page.text, /value="MOD"/, 'surfaces said as "m o d" become MOD');
    assert.match(page.text, /value="502" selected/, 'priority "2" becomes its DefNum');
    assert.ok(!page.text.includes('id="confirm-btn"'), 'assistants get no Confirm button');

    // An assistant trying to confirm anyway.
    const r = await t.request('POST', `/draft/${id}`, { ...t.as.assistant, body: editForm(page.text, { action: 'confirm' }) });
    assert.equal(r.status, 303);
    assert.equal(t.gateway.writes().length, 0, 'assistant cannot write');
    const again = await t.request('GET', `/draft/${id}`, t.as.assistant);
    assert.match(again.text, /Only a doctor, hygienist or owner can Confirm/);

    // The drafts tile shows it for the assistant.
    const tile = (await t.request('GET', '/tiles/drafts', t.as.assistant)).json();
    assert.equal(tile.value, '1 waiting');
    assert.match(tile.items[0].text, /Testpatient, R\. — plan, 2 lines/);
  } finally { await t.close(); }
});

test('doctor confirms: procedures written with DefNum priority, read back, history records who', async () => {
  const t = await startApp();
  try {
    const id = await makeDraft(t, { who: t.as.assistant });
    const page = await t.request('GET', `/draft/${id}`, t.as.doctor);
    assert.match(page.text, /id="confirm-btn"/);
    const r = await t.request('POST', `/draft/${id}`, { ...t.as.doctor, body: editForm(page.text, { action: 'confirm' }) });
    assert.equal(r.status, 303, r.text);
    assert.match(r.location, /^\/m\/voice\/done\//);

    const written = t.gateway.procs.filter((p) => p.PatNum === 8133 && p.ProcStatus === 'TP');
    assert.equal(written.length, 2);
    const crown = written.find((p) => p.CodeNum === 1);
    assert.equal(crown.ToothNum, '30');
    assert.equal(crown.Priority, 502, 'priority sent as the definition number');
    const comp = written.find((p) => p.CodeNum === 2);
    assert.equal(comp.Surf, 'MOD');
    assert.equal(comp.ToothNum, '3');

    const done = await t.request('GET', r.location.replace('/m/voice', ''), t.as.doctor);
    assert.match(done.text, /Written to Open Dental/);
    assert.match(done.text, /Read back/);
    assert.match(done.text, /\$1200\.00/);
    assert.match(done.text, /Not signed/);
    // Only the confirming person sees the result page.
    assert.equal((await t.request('GET', r.location.replace('/m/voice', ''), t.as.hygienist)).status, 404);

    // The draft is gone; history records who dictated and who confirmed.
    assert.equal((await t.request('GET', `/draft/${id}`, t.as.doctor)).status, 404);
    const hist = JSON.parse(fs.readFileSync(path.join(t.dir, 'history.json'), 'utf8'));
    assert.equal(hist[0].result, 'written');
    assert.equal(hist[0].dictatedBy.user, 'asst1');
    assert.equal(hist[0].confirmedBy.user, 'drsmith');
    assert.equal(hist[0].lines.length, 2);
    const h = await t.request('GET', '/history', t.as.doctor);
    assert.match(h.text, /Dictated by <strong>Ann Assistant<\/strong> · confirmed by <strong>Dr Smith<\/strong>/);
  } finally { await t.close(); }
});

test('a new named plan is created once and the lines are put on it', async () => {
  const t = await startApp();
  try {
    const id = await makeDraft(t, { who: t.as.doctor });
    const page = await t.request('GET', `/draft/${id}`, t.as.doctor);
    const f = editForm(page.text, { action: 'confirm' });
    f.set('target', 'new'); f.set('heading', 'Phase 2');
    const r = await t.request('POST', `/draft/${id}`, { ...t.as.doctor, body: f });
    assert.match(r.location, /done/);
    const plan = t.gateway.plans.find((p) => p.Heading === 'Phase 2');
    assert.ok(plan);
    assert.equal(t.gateway.attaches.filter((a) => a.TreatPlanNum === plan.TreatPlanNum).length, 2);
    assert.equal(t.gateway.attaches[0].Priority, 502);
  } finally { await t.close(); }
});

test('design stage with the demo database: Confirm writes only to PatNum 8133', async () => {
  const t = await startApp({ gateway: fakeGateway({ stage: 'design', fake: false }) });
  try {
    const id = await makeDraft(t, { who: t.as.doctor, patNum: 101 });
    const page = await t.request('GET', `/draft/${id}`, t.as.doctor);
    assert.match(page.text, /writes go only to the test patient/);
    await t.request('POST', `/draft/${id}`, { ...t.as.doctor, body: editForm(page.text, { action: 'confirm' }) });
    assert.equal(t.gateway.writes().length, 0, 'nothing written for PatNum 101');
    assert.match((await t.request('GET', `/draft/${id}`, t.as.doctor)).text, /nothing was written/);

    const ok = await makeDraft(t, { who: t.as.doctor, patNum: 8133 });
    const p2 = await t.request('GET', `/draft/${ok}`, t.as.doctor);
    const r = await t.request('POST', `/draft/${ok}`, { ...t.as.doctor, body: editForm(p2.text, { action: 'confirm' }) });
    assert.match(r.location, /done/);
    assert.ok(t.gateway.writes().length > 0);
    assert.ok(t.gateway.writes().every((w) => !/\/patients/.test(w.path)));
  } finally { await t.close(); }
});

test('gateway not in the design stage: patient pages pause, nothing is read', async () => {
  const g = fakeGateway({ stage: 'live', fake: false });
  const t = await startApp({ gateway: g });
  try {
    const r = await t.request('GET', '/?q=Apple', t.as.doctor);
    assert.equal(r.status, 503);
    assert.match(r.text, /paused/i);
    assert.ok(!g.calls.some((c) => c.path.includes('/patients')));
    assert.equal(t.app.state.paused.length > 0, true);
    // The gateway comes back in the design stage: pages work again after the next check.
    g.health.stage = 'design';
    await t.app.checkStage();
    assert.equal((await t.request('GET', '/?q=Apple', t.as.doctor)).status, 200);
  } finally { await t.close(); }
});

test('a failure part-way keeps written lines, and retry never writes them twice', async () => {
  const g = fakeGateway();
  g.failPlanAfter = 1;
  const t = await startApp({ gateway: g });
  try {
    const id = await makeDraft(t, { who: t.as.doctor });
    let page = await t.request('GET', `/draft/${id}`, t.as.doctor);
    await t.request('POST', `/draft/${id}`, { ...t.as.doctor, body: editForm(page.text, { action: 'confirm' }) });
    page = await t.request('GET', `/draft/${id}`, t.as.doctor);
    assert.match(page.text, /Partly written/);
    assert.match(page.text, /Fake failure for the test/);
    assert.equal(g.procs.filter((p) => p.PatNum === 8133 && p.ProcStatus === 'TP').length, 1);
    g.failPlanAfter = Infinity;
    const r = await t.request('POST', `/draft/${id}`, { ...t.as.doctor, body: editForm(page.text, { action: 'confirm' }) });
    assert.match(r.location, /done/);
    assert.equal(g.procs.filter((p) => p.PatNum === 8133 && p.ProcStatus === 'TP').length, 2, 'the first line was not written again');
  } finally { await t.close(); }
});

test('lines with problems block Confirm until fixed', async () => {
  const claude = fakeClaude(() => ({ draft: { items: [{ proc_code: 'D2393', tooth: '3' }, { proc_code: 'D9999' }], warnings: ['Not sure about the surfaces on 3.'] } }));
  const t = await startApp({ claude });
  try {
    const id = await makeDraft(t, { who: t.as.doctor });
    let page = await t.request('GET', `/draft/${id}`, t.as.doctor);
    assert.match(page.text, /Needs surfaces/);
    assert.match(page.text, /D9999 is not in the office&#39;s code list/);
    assert.match(page.text, /Not sure about the surfaces on 3/);
    assert.match(page.text, /id="confirm-btn" disabled/);
    await t.request('POST', `/draft/${id}`, { ...t.as.doctor, body: editForm(page.text, { action: 'confirm' }) });
    assert.equal(t.gateway.writes().length, 0);
    // Fix: add surfaces, remove the bad line.
    page = await t.request('GET', `/draft/${id}`, t.as.doctor);
    const { ids } = formState(page.text);
    let f = editForm(page.text, { action: `remove:${ids[1].id}` });
    await t.request('POST', `/draft/${id}`, { ...t.as.doctor, body: f });
    page = await t.request('GET', `/draft/${id}`, t.as.doctor);
    f = editForm(page.text, { action: 'confirm' });
    f.set('l0.surfaces', 'MOD');
    const r = await t.request('POST', `/draft/${id}`, { ...t.as.doctor, body: f });
    assert.match(r.location, /done/);
    assert.equal(t.gateway.procs.filter((p) => p.PatNum === 8133 && p.ProcStatus === 'TP').length, 1);
  } finally { await t.close(); }
});

test('someone else changed the draft: no write, newest version shown', async () => {
  const t = await startApp();
  try {
    const id = await makeDraft(t, { who: t.as.doctor });
    const page = await t.request('GET', `/draft/${id}`, t.as.doctor);
    await t.request('POST', `/draft/${id}`, { ...t.as.hygienist, body: editForm(page.text, { action: 'save' }) });
    await t.request('POST', `/draft/${id}`, { ...t.as.doctor, body: editForm(page.text, { action: 'confirm' }) });
    assert.equal(t.gateway.writes().length, 0);
    assert.match((await t.request('GET', `/draft/${id}`, t.as.doctor)).text, /Someone else changed this draft/);
  } finally { await t.close(); }
});

test('note: group note on today\'s completed procedures, unsigned, read back', async () => {
  const claude = fakeClaude(() => ({ draft: { note_text: 'Tooth 30: O composite. 2 carpules lidocaine 2% with epi 1:100k. Patient tolerated well.', warnings: [] } }));
  const t = await startApp({ claude });
  try {
    const id = await makeDraft(t, { who: t.as.hygienist, kind: 'note', dictation: 'two carp lido with epi, O composite on thirty, tolerated well' });
    const page = await t.request('GET', `/draft/${id}`, t.as.hygienist);
    assert.match(page.text, /Group note on today(&#39;|')s completed procedures/);
    assert.match(page.text, /name="proc" value="902" checked/);
    const { version } = formState(page.text);
    const f = new URLSearchParams({ version, noteText: 'Tooth 30: O composite. 2 carpules lidocaine 2% with epi 1:100k. Patient tolerated well.', noteType: 'group', proc: '902', action: 'confirm' });
    const r = await t.request('POST', `/draft/${id}`, { ...t.as.hygienist, body: f });
    assert.match(r.location || '', /done/, r.text);
    const note = t.gateway.notes.find((n) => n.PatNum === 8133);
    assert.match(note.Note, /lidocaine/);
    assert.equal(note.isSigned, 'false');
    const done = await t.request('GET', r.location.replace('/m/voice', ''), t.as.hygienist);
    assert.match(done.text, /Group note covering 1 procedure/);
    assert.match(done.text, /Unsigned/);
    // The note text is not kept in history.
    assert.ok(!fs.readFileSync(path.join(t.dir, 'history.json'), 'utf8').includes('lidocaine'));
  } finally { await t.close(); }
});

test('note addendum appends to an earlier procedure note', async () => {
  const claude = fakeClaude(() => ({ draft: { note_text: 'Addendum: patient called, no sensitivity.', warnings: [] } }));
  const t = await startApp({ claude });
  try {
    const id = await makeDraft(t, { who: t.as.doctor, kind: 'note', dictation: 'addendum patient called no sensitivity' });
    const page = await t.request('GET', `/draft/${id}`, t.as.doctor);
    const { version } = formState(page.text);
    const f = new URLSearchParams({ version, noteText: 'Addendum: patient called, no sensitivity.', noteType: 'addendum', addendumProc: '902', action: 'confirm' });
    const r = await t.request('POST', `/draft/${id}`, { ...t.as.doctor, body: f });
    assert.match(r.location, /done/);
    assert.ok(t.gateway.notes.some((n) => n.ProcNum === 902 && /no sensitivity/.test(n.Note)));
  } finally { await t.close(); }
});

test('the dictation is never stored or logged; discarded drafts are deleted', async () => {
  const t = await startApp();
  try {
    const id = await makeDraft(t, { who: t.as.doctor, dictation: 'Crown on thirty UNIQUE-DICTATION-WORDS' });
    const files = fs.readdirSync(t.dir).map((f) => fs.readFileSync(path.join(t.dir, f), 'utf8')).join('\n');
    assert.ok(!files.includes('UNIQUE-DICTATION-WORDS'), 'not in data files');
    assert.ok(!t.logs.join('\n').includes('UNIQUE-DICTATION-WORDS'), 'not in logs');
    const page = await t.request('GET', `/draft/${id}`, t.as.doctor);
    const r = await t.request('POST', `/draft/${id}`, { ...t.as.doctor, body: editForm(page.text, { action: 'discard' }) });
    assert.match(r.location, /discarded=1/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, 'drafts.json'), 'utf8'))[id], undefined);
    assert.equal(t.gateway.writes().length, 0);
  } finally { await t.close(); }
});

test('if Claude fails, the dictation stays in the box', async () => {
  const claude = { requests: [], fetch: async () => new Response('{"error":{"type":"overloaded_error"}}', { status: 529 }) };
  const t = await startApp({ claude });
  try {
    const r = await t.request('POST', '/draft', { ...t.as.doctor, body: { pat: '8133', kind: 'plan', dictation: 'Crown on thirty' } });
    assert.equal(r.status, 422);
    assert.match(r.text, /Claude is busy/);
    assert.match(r.text, />Crown on thirty<\/textarea>/);
  } finally { await t.close(); }
});

test('assistants only see their own drafts; confirmers see all', async () => {
  const t = await startApp({ claude: fakeClaude(() => PLAN_ANSWER) });
  try {
    const mine = await makeDraft(t, { who: t.as.assistant });
    const docs = await makeDraft(t, { who: t.as.doctor });
    assert.equal((await t.request('GET', `/draft/${docs}`, t.as.assistant)).status, 404);
    assert.equal((await t.request('GET', `/draft/${mine}`, t.as.hygienist)).status, 200);
    const tile = (await t.request('GET', '/tiles/drafts', t.as.doctor)).json();
    assert.equal(tile.items[0].text, '1 from others to confirm');
  } finally { await t.close(); }
});
