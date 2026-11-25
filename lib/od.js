'use strict';
// Open Dental, only through the gateway with this module's own key, using the
// shared core/ code (CONTRACT §7). No Open Dental calls are written here: this
// file only picks which core tools the module may use, and trims what comes back
// to what the pages need. Nothing from Open Dental is written to disk.
const { createGatewayClient, checkStage } = require('../vendor/opendental-core/gateway-client');
const { buildTools } = require('../vendor/opendental-core/tools');
const { buildClinicalTools } = require('../vendor/opendental-core/clinical-tools');

// Reading tools. Some of these are also offered to Claude (see drafting.js).
const READ_TOOLS = new Set([
  'od_search_patients', 'od_get_patient', 'od_get_procedures', 'od_get_treatment_plans',
  'od_lookup_procedure_code', 'od_list_treatment_priorities', 'od_get_procedure_notes',
]);
// Writing tools. Only writer.js uses these, and only after Confirm. Never given to Claude.
const WRITE_TOOLS = new Set([
  'od_plan_procedure', 'od_create_treatment_plan', 'od_add_to_treatment_plan',
  'od_set_treatment_plan_priorities', 'od_add_group_note', 'od_append_procedure_note',
]);

const byName = (list) => new Map(list.map((t) => [t.name, t]));

function patientSummary(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    PatNum: Number(p.PatNum),
    LName: p.LName || '',
    FName: p.FName || '',
    Preferred: p.Preferred || '',
    Birthdate: String(p.Birthdate || '').slice(0, 10),
    PatStatus: p.PatStatus || '',
  };
}

function shortName(p) {
  if (!p) return '';
  return `${p.LName}, ${(p.Preferred || p.FName || '').charAt(0)}.`.replace(/, \.$/, '');
}

function createOd({ url, key, fetch, now = () => Date.now() }) {
  const client = createGatewayClient({ url, key, fetch, timeoutMs: 45000 });
  // One set of tools for the life of the process, so their small caches
  // (procedure codes, priority names) are shared. Memory only.
  const reads = byName([...buildTools(client), ...buildClinicalTools(client, { allowChartChanges: false })]);
  const writes = byName(buildClinicalTools(client, { allowChartChanges: true }));

  async function read(name, args = {}) {
    if (!READ_TOOLS.has(name)) throw new Error(`Not a reading tool: ${name}`);
    return reads.get(name).run(args);
  }
  async function write(name, args) {
    if (!WRITE_TOOLS.has(name)) throw new Error(`Not a writing tool: ${name}`);
    return writes.get(name).run(args);
  }

  // Short memory-only cache for patient names (tiles and history must answer fast).
  const names = new Map();
  const NAME_TTL = 15 * 60 * 1000;
  function remember(p) { if (p && p.PatNum) names.set(Number(p.PatNum), { name: shortName(p), at: now() }); }
  function cachedName(patNum) {
    const hit = names.get(Number(patNum));
    if (!hit || now() - hit.at > NAME_TTL) { names.delete(Number(patNum)); return null; }
    return hit.name;
  }

  async function getPatient(patNum) {
    const r = await read('od_get_patient', { pat_num: Number(patNum) });
    const p = patientSummary(r.results);
    remember(p);
    return p;
  }

  async function searchPatients(q) {
    q = String(q || '').trim();
    if (!q) return [];
    if (/^\d{1,9}$/.test(q)) {
      try { const p = await getPatient(Number(q)); return p ? [p] : []; } catch (e) { if (e.status === 404 || e.code === 'not_found') return []; throw e; }
    }
    let last; let first;
    if (q.includes(',')) [last, first] = q.split(',').map((s) => s.trim());
    else {
      const parts = q.split(/\s+/);
      if (parts.length > 1) { first = parts[0]; last = parts.slice(1).join(' '); } else last = q;
    }
    const args = { max_rows: 25 };
    if (last) args.last_name = last;
    if (first) args.first_name = first;
    const r = await read('od_search_patients', args);
    const rows = (Array.isArray(r.results) ? r.results : []).map(patientSummary).filter(Boolean);
    rows.forEach(remember);
    return rows;
  }

  let pri = null;
  async function priorities() {
    if (!pri || now() - pri.at > 10 * 60 * 1000) {
      const r = await read('od_list_treatment_priorities', {});
      pri = { at: now(), list: (r.results?.priorities || []).map((d) => ({ name: String(d.name), defNum: Number(d.DefNum) })) };
    }
    return pri.list;
  }

  /** Exact procedure code lookup: { ProcCode, Descript, TreatArea } or null. */
  async function lookupCode(code) {
    const c = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9.\-]{1,15}$/.test(c)) return null;
    const r = await read('od_lookup_procedure_code', { query: c, max_rows: 5 });
    const hit = (r.results || []).find((x) => String(x.ProcCode).toUpperCase() === c);
    return hit ? { ProcCode: hit.ProcCode, Descript: hit.Descript || hit.AbbrDesc || '', TreatArea: String(hit.TreatArea || '') } : null;
  }

  async function report(name, params, opts) { return client.runReport(name, params, opts); }

  return { client, read, write, getPatient, searchPatients, priorities, lookupCode, report, cachedName, remember, health: () => client.health(), checkStage: (stage) => checkStage(client, stage) };
}

module.exports = { createOd, READ_TOOLS, WRITE_TOOLS, patientSummary, shortName };
