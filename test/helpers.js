'use strict';
// Test helpers: a fake Open Dental gateway and a fake Claude, both as `fetch`
// functions (no network), plus a signed-request client. MADE-UP DATA ONLY.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tdcSignature } = require('../lib/tdc-verify');
const { createApp } = require('../lib/app');
const { createOd } = require('../lib/od');
const { createClaude } = require('../lib/claude');
const { createStore } = require('../lib/store');

const SECRET = 'ab'.repeat(32);
const GW_KEY = 'odg_test_voice_key_0003';
const TODAY = '2026-11-16';

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A made-up dental office behind a fake gateway. */
function fakeGateway({ stage = 'design', fake = true } = {}) {
  const o = {
    health: { ok: true, version: 'test', stage, fake },
    patients: [
      { PatNum: 101, LName: 'Applewood', FName: 'Dana', Preferred: '', Birthdate: '1980-01-02', PatStatus: 'Patient' },
      { PatNum: 102, LName: 'Applegate', FName: 'Sam', Preferred: 'Sammy', Birthdate: '1975-03-04', PatStatus: 'Patient' },
      { PatNum: 8133, LName: 'Testpatient', FName: 'Rae', Preferred: '', Birthdate: '1990-05-06', PatStatus: 'Patient' },
    ],
    codes: [
      { CodeNum: 1, ProcCode: 'D2740', Descript: 'crown - porcelain/ceramic', TreatArea: 'Tooth', Fee: 1200 },
      { CodeNum: 2, ProcCode: 'D2393', Descript: 'resin-based composite - three surfaces, posterior', TreatArea: 'Surf', Fee: 250 },
      { CodeNum: 3, ProcCode: 'D0274', Descript: 'bitewings - four radiographic images', TreatArea: 'Mouth', Fee: 75 },
      { CodeNum: 4, ProcCode: 'D6010', Descript: 'surgical placement of implant body: endosteal implant', TreatArea: 'Tooth', Fee: 2000 },
      { CodeNum: 5, ProcCode: 'D2391', Descript: 'resin-based composite - one surface, posterior', TreatArea: 'Surf', Fee: 150 },
      { CodeNum: 9, ProcCode: '~GRP~', Descript: 'Group Note', TreatArea: 'None', Fee: 0 },
    ],
    defs: [
      { DefNum: 501, Category: 20, ItemName: '1' }, { DefNum: 502, Category: 20, ItemName: '2' },
      { DefNum: 503, Category: 20, ItemName: '3' }, { DefNum: 504, Category: 20, ItemName: 'Urgent' },
    ],
    procs: [
      { ProcNum: 900, PatNum: 101, CodeNum: 5, ProcStatus: 'C', ProcDate: TODAY, ToothNum: '19', Surf: 'O', Priority: 0, ProcFee: 150 },
      { ProcNum: 901, PatNum: 101, CodeNum: 3, ProcStatus: 'C', ProcDate: TODAY, ToothNum: '', Surf: '', Priority: 0, ProcFee: 75 },
      { ProcNum: 902, PatNum: 8133, CodeNum: 5, ProcStatus: 'C', ProcDate: TODAY, ToothNum: '30', Surf: 'O', Priority: 0, ProcFee: 150 },
    ],
    notes: [],
    plans: [{ TreatPlanNum: 1, PatNum: 101, Heading: 'Active Treatment Plan', TPStatus: 'Active' }],
    attaches: [],
    calls: [], // every call: { method, path }
    failPlanAfter: Infinity, // make od_plan_procedure fail after this many POSTs
    planPosts: 0,
    down: false,
  };
  let nextProc = 1000; let nextNote = 1; let nextPlan = 10; let nextAttach = 1;
  const code = (n) => o.codes.find((c) => c.CodeNum === n);
  const procOut = (p) => ({ ...p, procCode: code(p.CodeNum).ProcCode, descript: code(p.CodeNum).Descript, priority: (o.defs.find((d) => d.DefNum === p.Priority) || {}).ItemName || '', ProcFee: String(p.ProcFee) });

  async function fetchImpl(url, init = {}) {
    if (o.down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const u = new URL(url);
    const method = init.method || 'GET';
    const q = Object.fromEntries(u.searchParams);
    const body = init.body ? JSON.parse(init.body) : {};
    o.calls.push({ method, path: u.pathname });
    if (u.pathname === '/health') return jsonResponse(200, o.health);
    if ((init.headers || {}).Authorization !== `Bearer ${GW_KEY}`) return jsonResponse(401, { error: { message: 'bad key' } });
    let m;
    if ((m = u.pathname.match(/^\/v1\/reports\/(\w+)$/))) {
      const p = body.params || {};
      if (m[1] !== 'unsigned_notes') return jsonResponse(403, { error: { message: 'not allowed' } });
      const rows = [{ ProcNum: 900, PatNum: 101, LName: 'Applewood', FName: 'Dana', ProcDate: TODAY, ProcCode: 'D2391', Provider: 'DOC' }];
      return jsonResponse(200, { rows: p.count_only === 'true' ? [{ UnsignedNotes: rows.length }] : rows, truncated: false });
    }
    const p = u.pathname.replace(/^\/v1\/od/, '');
    if (p === '/patients' && method === 'GET') {
      const l = String(q.LName || '').toLowerCase(); const f = String(q.FName || '').toLowerCase();
      return jsonResponse(200, o.patients.filter((x) => (!l || x.LName.toLowerCase().startsWith(l)) && (!f || x.FName.toLowerCase().startsWith(f))));
    }
    if ((m = p.match(/^\/patients\/(\d+)$/))) {
      const x = o.patients.find((r) => r.PatNum === Number(m[1]));
      return x ? jsonResponse(200, { ...x, SSN: '000-00-0000' }) : jsonResponse(404, { error: { message: 'Patient not found' } });
    }
    if (p === '/procedurecodes') return jsonResponse(200, o.codes);
    if (p === '/definitions') return jsonResponse(200, o.defs.filter((d) => !q.Category || String(d.Category) === q.Category));
    if (p === '/procedurelogs' && method === 'GET') {
      return jsonResponse(200, o.procs.filter((x) => (!q.PatNum || String(x.PatNum) === q.PatNum) && (!q.ProcStatus || x.ProcStatus === q.ProcStatus)).map(procOut));
    }
    if (p === '/procedurelogs' && method === 'POST') {
      o.planPosts += 1;
      if (o.planPosts > o.failPlanAfter) return jsonResponse(400, { error: { message: 'Fake failure for the test' } });
      const c = o.codes.find((x) => x.ProcCode === body.procCode);
      if (!c) return jsonResponse(400, { error: { message: 'procCode not found' } });
      const rec = { ProcNum: nextProc++, PatNum: Number(body.PatNum), CodeNum: c.CodeNum, ProcStatus: body.ProcStatus, ProcDate: body.ProcDate, ToothNum: body.ToothNum || '', Surf: body.Surf || '', ToothRange: body.ToothRange || '', Priority: Number(body.Priority) || 0, ProcFee: c.Fee };
      o.procs.push(rec);
      return jsonResponse(201, procOut(rec));
    }
    if (p === '/procedurelogs/GroupNote' && method === 'POST') {
      const rec = { ProcNum: nextProc++, PatNum: Number(body.PatNum), CodeNum: 9, ProcStatus: 'EC', ProcDate: TODAY, ToothNum: '', Surf: '', Priority: 0, ProcFee: 0 };
      o.procs.push(rec);
      o.notes.push({ ProcNoteNum: nextNote++, PatNum: rec.PatNum, ProcNum: rec.ProcNum, Note: body.Note, isSigned: 'false' });
      return jsonResponse(201, { ...procOut(rec), Note: body.Note, isSigned: body.isSigned });
    }
    if ((m = p.match(/^\/procedurelogs\/(\d+)$/))) {
      const x = o.procs.find((r) => r.ProcNum === Number(m[1]));
      if (!x) return jsonResponse(404, { error: { message: 'Procedure not found' } });
      if (method === 'PUT') Object.assign(x, body);
      return jsonResponse(200, procOut(x));
    }
    if (p === '/procnotes' && method === 'GET') return jsonResponse(200, o.notes.filter((n) => (!q.PatNum || String(n.PatNum) === q.PatNum) && (!q.ProcNum || String(n.ProcNum) === q.ProcNum)));
    if (p === '/procnotes' && method === 'POST') {
      const prev = o.notes.filter((n) => n.ProcNum === Number(body.ProcNum)).pop();
      const n = { ProcNoteNum: nextNote++, PatNum: Number(body.PatNum), ProcNum: Number(body.ProcNum), Note: body.doAppendNote === 'true' && prev ? `${prev.Note}\r\n${body.Note}` : body.Note, isSigned: 'false' };
      o.notes.push(n);
      return jsonResponse(201, n);
    }
    if (p === '/treatplans' && method === 'GET') return jsonResponse(200, o.plans.filter((t) => !q.PatNum || String(t.PatNum) === q.PatNum));
    if (p === '/treatplans' && method === 'POST') {
      const t = { TreatPlanNum: nextPlan++, PatNum: Number(body.PatNum), Heading: body.Heading, TPStatus: 'Inactive' };
      o.plans.push(t);
      return jsonResponse(201, t);
    }
    if (p === '/treatplanattaches' && method === 'GET') return jsonResponse(200, o.attaches.filter((a) => !q.TreatPlanNum || String(a.TreatPlanNum) === q.TreatPlanNum));
    if (p === '/treatplanattaches' && method === 'POST') {
      const a = { TreatPlanAttachNum: nextAttach++, TreatPlanNum: Number(body.TreatPlanNum), ProcNum: Number(body.ProcNum), Priority: Number(body.Priority) || 0 };
      o.attaches.push(a);
      return jsonResponse(201, a);
    }
    return jsonResponse(404, { error: { message: `fake gateway has no ${method} ${p}` } });
  }
  o.fetch = fetchImpl;
  o.writes = () => o.calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/v1/reports'));
  return o;
}

/**
 * A fake Claude. `script(kind, request)` returns the list of content blocks for
 * the next answer. Default: look up each code once, then submit `answer`.
 */
function fakeClaude(answerFor) {
  const c = { requests: [] };
  c.fetch = async (url, init) => {
    const req = JSON.parse(init.body);
    c.requests.push({ url, headers: init.headers, body: req });
    const isPlan = req.tools.find((t) => t.name === 'submit_draft').input_schema.properties.items;
    const answer = answerFor(isPlan ? 'plan' : 'note', req);
    const toolResults = req.messages.filter((m) => m.role === 'user' && Array.isArray(m.content));
    if (!toolResults.length && answer.lookup) {
      return jsonResponse(200, { content: [{ type: 'tool_use', id: 'tu1', name: 'lookup_procedure_code', input: { query: answer.lookup } }, { type: 'tool_use', id: 'tu2', name: 'list_priorities', input: {} }] });
    }
    return jsonResponse(200, { content: [{ type: 'tool_use', id: 'tu9', name: 'submit_draft', input: answer.draft }] });
  };
  return c;
}

const PLAN_ANSWER = {
  lookup: 'D2740',
  draft: { items: [{ proc_code: 'D2740', tooth: '30', priority: '2' }, { proc_code: 'd2393', tooth: '3', surfaces: 'm o d', priority: '2' }], warnings: [] },
};

async function startApp({ gateway = fakeGateway(), claude = fakeClaude(() => PLAN_ANSWER), stage = 'design', writePatNums = [8133] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-test-'));
  const logs = [];
  const od = createOd({ url: 'http://127.0.0.1:8787', key: GW_KEY, fetch: gateway.fetch });
  const app = createApp({
    secret: SECRET, stage, od, claude: createClaude({ apiKey: 'sk-test-not-real', fetch: claude.fetch }),
    store: createStore({ dir }), writePatNums, log: (l) => logs.push(l), today: () => TODAY,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  await app.checkStage();
  const port = app.server.address().port;

  async function request(method, pathAndQuery, { user = 'drsmith', name = 'Dr Smith', roles = 'doctor', body, sign = true, time = Date.now(), headers = {} } = {}) {
    const h = { ...headers };
    if (sign) {
      Object.assign(h, { 'X-TDC-User': user, 'X-TDC-Name': name, 'X-TDC-Roles': roles, 'X-TDC-Base': '/m/voice', 'X-TDC-Time': String(time) });
      h['X-TDC-Sig'] = tdcSignature(SECRET, String(time), method, pathAndQuery, user, roles, '/m/voice');
    }
    let payload;
    if (body !== undefined) {
      payload = body instanceof URLSearchParams ? body.toString() : new URLSearchParams(body).toString();
      h['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, { method, headers: h, body: payload, redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, text, location: res.headers.get('location'), json: () => JSON.parse(text) };
  }
  const as = {
    doctor: { user: 'drsmith', name: 'Dr Smith', roles: 'doctor' },
    hygienist: { user: 'hyg1', name: 'Hy Gienist', roles: 'hygienist' },
    assistant: { user: 'asst1', name: 'Ann Assistant', roles: 'assistant' },
    owner: { user: 'owner1', name: 'O Wner', roles: 'owner,doctor' },
    front: { user: 'front1', name: 'Fran Front', roles: 'front' },
    admin: { user: 'admin1', name: 'Ad Min', roles: 'admin' },
  };
  async function close() { app.stop(); await new Promise((r) => app.server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
  return { app, request, as, gateway, claude, logs, dir, close, port };
}

/** Make a draft as `who` for patNum and return its id. */
async function makeDraft(t, { who, patNum = 8133, kind = 'plan', dictation = 'Crown on thirty, MOD composite on three, phase two.' }) {
  const r = await t.request('POST', '/draft', { ...who, body: { pat: String(patNum), kind, dictation } });
  if (r.status !== 303) throw new Error(`draft failed ${r.status}: ${r.text.slice(0, 500)}`);
  return r.location.split('/').pop();
}

/** Read the hidden version and line ids from a draft page. */
function formState(html) {
  const version = (html.match(/name="version" value="(\d+)"/) || [])[1];
  const ids = [...html.matchAll(/name="l(\d+)\.id" value="([^"]+)"/g)].map((m) => ({ i: m[1], id: m[2] }));
  return { version, ids };
}

module.exports = { SECRET, GW_KEY, TODAY, fakeGateway, fakeClaude, PLAN_ANSWER, startApp, makeDraft, formState, jsonResponse };
