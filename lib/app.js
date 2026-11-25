'use strict';
// All routes for the Voice Charting module (CONTRACT.md v1).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyTdcRequest, hasRole } = require('./tdc-verify');
const pages = require('./pages');
const { makeDraft, normalizeLines, PLAN, NOTE } = require('./drafting');
const { confirmDraft, writeAllowed, todaysCompleted, ConfirmError, CONFIRM_ROLES } = require('./writer');
const { DEFAULT_MODEL } = require('./claude');
const WORDS = require('./words');

const VERSION = require('../package.json').version;
const VIEW_ROLES = ['owner', 'doctor', 'hygienist', 'assistant'];
const SETTINGS_ROLES = ['owner', 'admin'];
const STAGE_EVERY_MS = 5 * 60 * 1000;

const MANIFEST = {
  contract: 1,
  id: 'voice',
  name: 'Voice Charting',
  version: VERSION,
  description: 'Dictate (with Wispr Flow) or type, review a draft treatment plan or note, then Confirm to write it to Open Dental',
  icon: 'mic',
  roles: VIEW_ROLES,
  nav: [
    { label: 'New dictation', path: '/' },
    { label: 'History', path: '/history' },
  ],
  tiles: [
    { id: 'drafts', title: 'My drafts waiting', path: '/tiles/drafts', roles: VIEW_ROLES, refreshSeconds: 60 },
    { id: 'unsigned', title: 'Unsigned notes', path: '/tiles/unsigned', roles: CONFIRM_ROLES, refreshSeconds: 300 },
  ],
};

const STATIC = {
  '/static/voice.js': ['voice.js', 'text/javascript; charset=utf-8'],
  '/static/voice.css': ['voice.css', 'text/css; charset=utf-8'],
};

function officeToday(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: pages.TZ });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'timeout' })), ms).unref())]);
}

/**
 * @param {object} o
 * @param {string} o.secret          MODULE_SECRET
 * @param {string} o.stage           TDC_STAGE (design | live)
 * @param {object} o.od              lib/od.js
 * @param {object} o.claude          lib/claude.js
 * @param {object} o.store           lib/store.js
 * @param {number[]} o.writePatNums  design stage: the only patients Confirm may write to
 */
function createApp({ secret, stage, od, claude, store, writePatNums = [8133], log = (l) => console.log(l), now = () => Date.now(), today = () => officeToday() }) {
  if (!secret || secret.length < 64) throw new Error('MODULE_SECRET must be at least 64 hex characters (32 random bytes).');
  if (stage !== 'design' && stage !== 'live') throw new Error('TDC_STAGE must be "design" or "live".');

  // ------------------------------------------------------------ stage guard (CONTRACT §1)
  const state = { paused: 'Checking the Open Dental gateway…', gatewayFake: null, lastCheck: 0, checking: null };
  async function checkStage() {
    if (state.checking) return state.checking;
    state.checking = (async () => {
      try {
        const h = await od.checkStage(stage);
        state.paused = '';
        state.gatewayFake = h.fake === true;
      } catch (e) {
        state.paused = e.code === 'unreachable'
          ? 'The Open Dental gateway can\'t be reached, so its stage can\'t be checked.'
          : `The Open Dental gateway is not in the "${stage}" stage, so this module won't show or change patient information.`;
        log(JSON.stringify({ time: new Date(now()).toISOString(), event: 'stage-check-failed', code: e.code || 'error' }));
      } finally {
        state.lastCheck = now();
        state.checking = null;
      }
    })();
    return state.checking;
  }
  async function ensureStage() {
    if (state.paused && now() - state.lastCheck > 30 * 1000) await checkStage();
    return !state.paused;
  }
  const policy = () => ({ stage, gatewayFake: state.gatewayFake, writePatNums });

  // ------------------------------------------------------------ memory-only bits
  const flashes = new Map(); // `${user}:${draftId}` -> message (shown once)
  const results = new Map(); // id -> { result, patNum, user, at }  (read-back, 10 minutes)
  const writing = new Set(); // draft ids being written right now
  const tileCache = new Map();
  function sweep() {
    for (const [k, v] of results) if (now() - v.at > 10 * 60 * 1000) results.delete(k);
    for (const [k, v] of tileCache) if (now() - v.at > 10 * 60 * 1000) tileCache.delete(k);
  }

  const nameOf = (patNum) => od.cachedName(patNum) || `Patient #${patNum}`;
  async function warmNames(patNums) {
    const missing = [...new Set(patNums)].filter((n) => !od.cachedName(n)).slice(0, 20);
    await Promise.all(missing.map((n) => od.getPatient(n).catch(() => null)));
  }

  // ------------------------------------------------------------ helpers
  function send(res, status, body, type = 'text/html; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  }
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
  function redirect(res, location) { res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' }); res.end(); }
  const pageOpts = (who) => ({ canSettings: hasRole(who, ['owner']) });
  const canConfirm = (who) => hasRole(who, CONFIRM_ROLES);
  const visibleDrafts = (who) => store.listDrafts().filter((d) => canConfirm(who) || d.dictatedBy.user === who.user);
  function writeNote(patNum) {
    const a = writeAllowed(policy(), patNum);
    return a.ok ? '' : a.why.replace(', so nothing was written', '').replace(' Make a draft for the test patient to try Confirm.', ' Confirm is turned off for this patient.');
  }

  // ------------------------------------------------------------ tiles (CONTRACT §5)
  function draftsTile(who) {
    const all = store.listDrafts();
    const mine = all.filter((d) => d.dictatedBy.user === who.user);
    const others = canConfirm(who) ? all.filter((d) => d.dictatedBy.user !== who.user) : [];
    const items = [];
    if (others.length) items.push({ text: `${others.length} from others to confirm`, href: '/' });
    for (const d of mine) {
      if (items.length >= 8) break;
      items.push({ text: `${nameOf(d.patNum)} — ${d.kind === PLAN ? `plan, ${d.plan.items.length} line${d.plan.items.length === 1 ? '' : 's'}` : 'note'}`, href: `/draft/${d.id}` });
    }
    return {
      title: 'My drafts waiting',
      value: `${mine.length} waiting`,
      status: mine.length || others.length ? 'warn' : 'ok',
      items,
      link: '/',
      updated: new Date(now()).toISOString(),
    };
  }

  async function unsignedTile() {
    const hit = tileCache.get('unsigned');
    if (hit && now() - hit.at < 120 * 1000) return hit.tile;
    if (!(await ensureStage())) return { title: 'Unsigned notes', value: 'Paused', status: 'alert', items: [{ text: 'Voice Charting is paused (gateway stage check).' }], link: '/', updated: new Date(now()).toISOString() };
    try {
      const [count, list] = await withTimeout(Promise.all([
        od.report('unsigned_notes', { days: 90, count_only: 'true' }),
        od.report('unsigned_notes', { days: 90, limit: 8 }),
      ]), 2500);
      const n = Number(count.rows[0]?.UnsignedNotes ?? list.rows.length);
      const tile = {
        title: 'Unsigned notes',
        value: `${n} unsigned`,
        status: n ? 'warn' : 'ok',
        items: list.rows.slice(0, 8).map((r) => ({ text: `${r.LName}, ${String(r.FName || '').charAt(0)}. · ${pages.rowDate(`${String(r.ProcDate).slice(0, 10)}T20:00:00Z`)} · ${r.ProcCode === "~GRP~" ? "Group note" : r.ProcCode}${r.Provider ? ` · ${r.Provider}` : ''}` })),
        link: '/',
        updated: new Date(now()).toISOString(),
      };
      tileCache.set('unsigned', { at: now(), tile });
      return tile;
    } catch (e) {
      if (hit) return hit.tile;
      return { title: 'Unsigned notes', value: '—', status: 'warn', items: [{ text: e.code === 'timeout' ? 'Open Dental is slow to answer; try again shortly.' : 'Couldn\'t read unsigned notes right now.' }], link: '/', updated: new Date(now()).toISOString() };
    }
  }

  // ------------------------------------------------------------ draft form -> draft
  async function applyEdits(draft, form, who) {
    if (draft.kind === PLAN) {
      const byId = new Map(draft.plan.items.map((l) => [l.id, l]));
      const raw = [];
      for (let i = 0; i < 40; i++) {
        const id = form.get(`l${i}.id`);
        if (id === null) continue;
        const prev = byId.get(id);
        if (prev && prev.written) { raw.push(prev); continue; }
        raw.push({ id, procCode: form.get(`l${i}.procCode`) || '', tooth: form.get(`l${i}.tooth`) || '', surfaces: form.get(`l${i}.surfaces`) || '', toothRange: form.get(`l${i}.toothRange`) || '', priorityDefNum: form.get(`l${i}.priorityDefNum`) || 0, note: form.get(`l${i}.note`) || '' });
      }
      // Written lines are never dropped, even if the form lost them.
      for (const l of draft.plan.items) if (l.written && !raw.some((r) => r.id === l.id)) raw.push(l);
      draft.plan.items = await normalizeLines(od, raw, await od.priorities(), store.newId);
      const target = String(form.get('target') || 'none');
      if (!draft.plan.writtenPlanNum) {
        if (target === 'new') draft.plan.target = { type: 'new', heading: String(form.get('heading') || '').trim().slice(0, 200) };
        else if (/^plan:\d+$/.test(target)) draft.plan.target = { type: 'existing', treatPlanNum: Number(target.slice(5)) };
        else draft.plan.target = { type: 'none' };
      }
    } else {
      draft.note.text = String(form.get('noteText') ?? draft.note.text).slice(0, 20000);
      draft.note.type = form.get('noteType') === 'addendum' ? 'addendum' : 'group';
      draft.note.procNums = form.getAll('proc').map(Number).filter((n) => Number.isInteger(n) && n > 0);
      draft.note.procNum = Number(form.get('addendumProc')) || null;
    }
    draft.version += 1;
    draft.updatedAt = new Date(now()).toISOString();
    draft.editedBy = { user: who.user, name: who.name };
    return draft;
  }

  function planProblem(draft) {
    if (draft.kind !== PLAN) return '';
    const t = draft.plan.target;
    if (t.type === 'new' && !t.heading && !draft.plan.writtenPlanNum) return 'Give the new plan a name, or choose the Active plan.';
    return '';
  }

  function historyEntry(draft, result, extra) {
    return {
      time: new Date(now()).toISOString(), draftId: draft.id, kind: draft.kind, patNum: draft.patNum, result,
      dictatedBy: draft.dictatedBy,
      lines: draft.kind === PLAN ? draft.plan.items.filter((l) => l.written).map((l) => ({ procNum: l.written.procNum, procCode: l.procCode, tooth: l.tooth, surfaces: l.surfaces })) : undefined,
      noteProcNum: draft.kind === NOTE && draft.note.written ? draft.note.written.procNum : undefined,
      ...extra,
    };
  }

  // ------------------------------------------------------------ pages
  async function renderDraft(res, who, draft, status = 200) {
    const flashKey = `${who.user}:${draft.id}`;
    const error = flashes.get(flashKey) || '';
    flashes.delete(flashKey);
    const patient = await od.getPatient(draft.patNum).catch(() => null);
    let priorities = []; let plans = []; let todayProcs = []; let recentProcs = [];
    if (draft.kind === PLAN) {
      priorities = await od.priorities();
      plans = (await od.read('od_get_treatment_plans', { pat_num: draft.patNum, include_items: false })).results || [];
    } else {
      todayProcs = await todaysCompleted(od, draft.patNum, today());
      const r = await od.read('od_get_procedures', { pat_num: draft.patNum, status: 'C', max_rows: 200 });
      recentProcs = (r.results || []).filter((p) => String(p.procCode || p.ProcCode) !== '~GRP~').sort((a, b) => String(b.ProcDate).localeCompare(String(a.ProcDate))).slice(0, 30);
    }
    send(res, status, pages.draftPage(who, pageOpts(who), { draft, patient, priorities, plans, todayProcs, recentProcs, canConfirm: canConfirm(who), error, writeNote: writeNote(draft.patNum) }));
  }

  async function homeData(who, url) {
    const drafts = visibleDrafts(who);
    await warmNames(drafts.map((d) => d.patNum)).catch(() => {});
    const kind = url.searchParams.get('kind') === 'note' ? NOTE : PLAN;
    return { drafts, nameOf, canConfirm: canConfirm(who), kind };
  }

  async function handle(req, res, who) {
    const url = new URL(req.url, 'http://module');
    const p = url.pathname;
    const M = req.method;

    if (p === '/manifest.json' && M === 'GET') return json(res, 200, MANIFEST);
    if (STATIC[p] && M === 'GET') {
      const [file, type] = STATIC[p];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=300' });
      return res.end(fs.readFileSync(path.join(__dirname, '..', 'public', file)));
    }

    // Tiles are asked for as the logged-in staff member; check roles like a page.
    if (p === '/tiles/drafts' && M === 'GET') {
      if (!hasRole(who, VIEW_ROLES)) return json(res, 403, { error: 'Not allowed' });
      return json(res, 200, draftsTile(who));
    }
    if (p === '/tiles/unsigned' && M === 'GET') {
      if (!hasRole(who, CONFIRM_ROLES)) return json(res, 403, { error: 'Not allowed' });
      return json(res, 200, await unsignedTile());
    }

    // Settings: owner and admin. No patient data on this page.
    if (p === '/settings') {
      if (!hasRole(who, SETTINGS_ROLES)) return send(res, 403, pages.messagePage(who, pageOpts(who), { title: 'Not allowed', text: 'Only the owner or an admin can change Voice Charting settings.' }));
      let saved = false;
      if (M === 'POST') {
        const form = new URLSearchParams(await readBody(req, 16 * 1024));
        const model = String(form.get('model') || '').trim();
        if (model && !/^[a-z0-9][a-z0-9.\-_]{1,79}$/i.test(model)) return send(res, 400, pages.messagePage(who, pageOpts(who), { title: 'Not saved', text: 'That doesn\'t look like a Claude model name (letters, numbers, dots and dashes).' }));
        store.saveSettings({ model, words: String(form.get('words') || '').slice(0, 3000) });
        saved = true;
      } else if (M !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain');
      return send(res, 200, pages.settingsPage(who, pageOpts(who), { settings: store.getSettings(), defaultModel: DEFAULT_MODEL, stage, gatewayFake: state.gatewayFake, writePatNums, saved, words: WORDS }));
    }

    if (!hasRole(who, VIEW_ROLES)) return send(res, 403, pages.messagePage(who, pageOpts(who), { title: 'Not allowed', text: 'Voice Charting is for doctors, hygienists, assistants and the owner.' }));

    // History: the module's own records (PatNum, codes, who). Names come from Open Dental, in memory.
    if (p === '/history' && M === 'GET') {
      const all = hasRole(who, ['owner']) && url.searchParams.get('all') === '1';
      const entries = store.listHistory({ user: all ? null : who.user, limit: 200 });
      if (await ensureStage()) await warmNames(entries.map((e) => e.patNum)).catch(() => {});
      return send(res, 200, pages.historyPage(who, pageOpts(who), { entries, nameOf, all }));
    }

    // Everything below shows or changes patient information.
    if (!(await ensureStage())) return send(res, 503, pages.pausedPage(who, pageOpts(who), state.paused));

    if (p === '/' && M === 'GET') {
      const data = await homeData(who, url);
      const pat = url.searchParams.get('pat');
      const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
      let patient = null; let results = null;
      if (pat && /^\d{1,9}$/.test(pat)) patient = await od.getPatient(Number(pat)).catch(() => null);
      else if (q) results = await od.searchPatients(q);
      const notice = url.searchParams.get('discarded') ? 'Draft discarded. Nothing was written.' : '';
      return send(res, 200, pages.homePage(who, pageOpts(who), { ...data, patient, search: q, results, dictation: '', error: pat && !patient ? `No patient #${pat}.` : '', notice }));
    }

    if (p === '/draft' && M === 'POST') {
      const form = new URLSearchParams(await readBody(req, 64 * 1024));
      const patNum = Number(form.get('pat'));
      const kind = form.get('kind') === NOTE ? NOTE : PLAN;
      const dictation = String(form.get('dictation') || '');
      const patient = Number.isInteger(patNum) && patNum > 0 ? await od.getPatient(patNum).catch(() => null) : null;
      try {
        if (!patient) throw new Error('Pick the patient first.');
        const draft = await makeDraft({ claude, od, store, kind, patNum, dictation, who, today: today(), settings: store.getSettings() });
        store.saveDraft(draft);
        return redirect(res, `${who.base}/draft/${draft.id}`);
      } catch (e) {
        // Show the page again with the dictation still in the box, so nothing is lost.
        const data = await homeData(who, url);
        return send(res, 422, pages.homePage(who, pageOpts(who), { ...data, kind, patient, search: '', results: null, dictation, error: e.message, notice: '' }));
      }
    }

    let m;
    if ((m = p.match(/^\/draft\/([A-Za-z0-9_-]{6,30})$/))) {
      const draft = store.getDraft(m[1]);
      const visible = draft && (canConfirm(who) || draft.dictatedBy.user === who.user);
      if (!visible) return send(res, 404, pages.messagePage(who, pageOpts(who), { title: 'Draft not found', text: 'It may have been confirmed or discarded already. Check History.' }));
      if (M === 'GET') return renderDraft(res, who, draft);
      if (M !== 'POST') return send(res, 405, 'Method not allowed', 'text/plain');

      const form = new URLSearchParams(await readBody(req, 128 * 1024));
      const action = String(form.get('action') || 'save');
      const flashKey = `${who.user}:${draft.id}`;
      if (writing.has(draft.id)) { flashes.set(flashKey, 'This draft is being written right now. Wait a moment.'); return redirect(res, `${who.base}/draft/${draft.id}`); }
      if (Number(form.get('version')) !== draft.version) {
        flashes.set(flashKey, 'Someone else changed this draft while you had it open. This is the newest version; check it and try again.');
        return redirect(res, `${who.base}/draft/${draft.id}`);
      }

      if (action === 'discard') {
        store.deleteDraft(draft.id);
        store.addHistory(historyEntry(draft, 'discarded', { discardedBy: { user: who.user, name: who.name } }));
        return redirect(res, `${who.base}/?discarded=1`);
      }

      await applyEdits(draft, form, who);
      if (action === 'add' && draft.kind === PLAN) {
        if (draft.plan.items.length < 40) draft.plan.items.push(...(await normalizeLines(od, [{}], await od.priorities(), store.newId)));
      } else if (action.startsWith('remove:') && draft.kind === PLAN) {
        const id = action.slice(7);
        draft.plan.items = draft.plan.items.filter((l) => l.id !== id || l.written);
      }
      store.saveDraft(draft);
      if (action !== 'confirm') return redirect(res, `${who.base}/draft/${draft.id}${action === 'add' ? '#draft-form' : ''}`);

      // ---- Confirm: the only path that writes to Open Dental.
      if (!canConfirm(who)) { flashes.set(flashKey, 'Only a doctor, hygienist or owner can Confirm.'); return redirect(res, `${who.base}/draft/${draft.id}`); }
      const pp = planProblem(draft);
      if (pp) { flashes.set(flashKey, pp); return redirect(res, `${who.base}/draft/${draft.id}`); }
      writing.add(draft.id);
      try {
        const save = async (d) => { store.saveDraft(d); };
        const result = await confirmDraft({ od, draft, who, policy: policy(), save, today: today() });
        store.deleteDraft(draft.id);
        store.addHistory(historyEntry(draft, 'written', { confirmedBy: { user: who.user, name: who.name }, readBackOk: result.allOk }));
        const rid = crypto.randomBytes(9).toString('base64url');
        results.set(rid, { result, patNum: draft.patNum, user: who.user, at: now() });
        sweep();
        return redirect(res, `${who.base}/done/${rid}`);
      } catch (e) {
        store.saveDraft(draft); // keeps any lines already written, so they aren't written twice
        flashes.set(flashKey, e instanceof ConfirmError ? e.message : `Open Dental said: ${e.message}`);
        log(JSON.stringify({ time: new Date(now()).toISOString(), event: 'confirm-failed', user: who.user, code: e.code || e.name }));
        return redirect(res, `${who.base}/draft/${draft.id}`);
      } finally {
        writing.delete(draft.id);
      }
    }

    if ((m = p.match(/^\/done\/([A-Za-z0-9_-]{6,30})$/)) && M === 'GET') {
      const r = results.get(m[1]);
      if (!r || r.user !== who.user) return send(res, 404, pages.messagePage(who, pageOpts(who), { title: 'Already closed', status: 'ok', text: 'This result is no longer shown here. Check History, or the chart in Open Dental.' }));
      const patient = await od.getPatient(r.patNum).catch(() => null);
      return send(res, 200, pages.donePage(who, pageOpts(who), { result: r.result, patient, patNum: r.patNum }));
    }

    return send(res, 404, pages.messagePage(who, pageOpts(who), { title: 'Not found', text: 'There is no page here.' }));
  }

  const server = http.createServer((req, res) => {
    const start = now();
    let user = '-';
    res.on('finish', () => {
      // CONTRACT §8: one line per request; no query string, no bodies, no names.
      log(JSON.stringify({ time: new Date(now()).toISOString(), user, method: req.method, path: req.url.split('?')[0], status: res.statusCode, ms: now() - start }));
    });
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, version: VERSION, contract: 1 });
    const who = verifyTdcRequest(secret, req);
    if (!who) { req.resume(); return send(res, 401, 'Unauthorized', 'text/plain'); }
    user = who.user;
    handle(req, res, who).catch((err) => {
      log(JSON.stringify({ time: new Date(now()).toISOString(), event: 'error', user, path: req.url.split('?')[0], code: err.code || err.name, status: err.status || 500 }));
      if (res.headersSent) return res.destroy();
      if (err.status === 413) return send(res, 413, 'Too large', 'text/plain');
      const text = err.code === 'unreachable' ? 'Open Dental (the gateway) can\'t be reached right now. Try again in a minute.' : `Something went wrong: ${err.message}`;
      return send(res, 502, pages.messagePage(who, pageOpts(who), { title: 'Couldn\'t load this page', text }));
    });
    return undefined;
  });

  let timer = null;
  return {
    server,
    state,
    checkStage,
    start() { timer = setInterval(() => { checkStage(); sweep(); store.prune(); }, STAGE_EVERY_MS); timer.unref(); return checkStage(); },
    stop() { clearInterval(timer); },
  };
}

module.exports = { createApp, MANIFEST, VIEW_ROLES, officeToday };
