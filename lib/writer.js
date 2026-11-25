'use strict';
// Confirm: the ONLY place this module writes to Open Dental. It runs the
// shared core/ clinical tools (which check the patient, validate every input,
// never sign, and read back what they wrote), then reads the result back again
// for the person who confirmed. Progress is saved after every step so a retry
// never writes the same line twice.
const { normalizeLines, PLAN, NOTE } = require('./drafting');

const CONFIRM_ROLES = ['owner', 'doctor', 'hygienist'];

class ConfirmError extends Error {}

/**
 * Who may be written to right now. In the design stage against Open Dental's
 * demo database, only the test patient(s) in WRITE_PATNUMS (default 8133).
 * Against the fake demo gateway ("fake": true) any made-up patient is fine.
 */
function writeAllowed({ stage, gatewayFake, writePatNums }, patNum) {
  if (stage === 'live') return { ok: true };
  if (gatewayFake === true) return { ok: true };
  if (writePatNums.includes(Number(patNum))) return { ok: true };
  return { ok: false, why: `Design stage: writes go only to the test patient${writePatNums.length > 1 ? 's' : ''} (PatNum ${writePatNums.join(', ')}). This draft is for PatNum ${patNum}, so nothing was written. Make a draft for the test patient to try Confirm.` };
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

async function todaysCompleted(od, patNum, today) {
  const r = await od.read('od_get_procedures', { pat_num: patNum, status: 'C', date: today, max_rows: 100 });
  return (r.results || []).filter((p) => String(p.ProcDate || '').slice(0, 10) === today && String(p.procCode || p.ProcCode || '') !== '~GRP~');
}

async function confirmPlan({ od, draft, save }) {
  const patNum = draft.patNum;
  const priorities = await od.priorities();
  // Check everything again against Open Dental before writing anything.
  draft.plan.items = await normalizeLines(od, draft.plan.items, priorities, () => Math.random().toString(36).slice(2, 10));
  const blocked = draft.plan.items.filter((l) => !l.written && l.problems.length);
  if (blocked.length) throw new ConfirmError(`Fix ${blocked.length === 1 ? 'the line' : `${blocked.length} lines`} marked in red first. Nothing was written.`);
  if (!draft.plan.items.some((l) => !l.written)) throw new ConfirmError('There are no lines left to write.');

  let planNum = null;
  const t = draft.plan.target || { type: 'none' };
  if (t.type === 'existing') {
    planNum = Number(t.treatPlanNum);
  } else if (t.type === 'new') {
    if (draft.plan.writtenPlanNum) planNum = draft.plan.writtenPlanNum;
    else {
      const r = await od.write('od_create_treatment_plan', { pat_num: patNum, heading: t.heading });
      planNum = Number(r.results && r.results.TreatPlanNum);
      if (!planNum) throw new ConfirmError('Open Dental did not return the new treatment plan. Check the chart before trying again.');
      draft.plan.writtenPlanNum = planNum;
      await save(draft);
    }
  }

  for (const line of draft.plan.items) {
    if (line.written) continue;
    const args = { pat_num: patNum, proc_code: line.procCode };
    if (line.tooth) args.tooth = line.tooth;
    if (line.surfaces) args.surfaces = line.surfaces;
    if (line.toothRange) args.tooth_range = line.toothRange;
    if (line.note) args.note = line.note;
    if (planNum) args.treat_plan_num = planNum;
    if (line.priorityDefNum) {
      // The core tool sends Open Dental the priority's definition number (DefNum).
      const d = priorities.find((x) => x.defNum === line.priorityDefNum);
      args.priority = d.name;
    }
    const r = await od.write('od_plan_procedure', args);
    const procNum = Number(r.results && r.results.procedure && r.results.procedure.ProcNum);
    if (!procNum) throw new ConfirmError(`Open Dental did not return the procedure number for ${line.procCode}. Check the chart before trying again.`);
    line.written = { procNum };
    await save(draft);
  }

  // Read back from Open Dental for the person who confirmed.
  let tp = new Map();
  let attached = null;
  let readBackError = '';
  try {
    const r = await od.read('od_get_procedures', { pat_num: patNum, status: 'TP', max_rows: 500 });
    tp = new Map((r.results || []).map((p) => [Number(p.ProcNum), p]));
    if (planNum) {
      const plans = await od.read('od_get_treatment_plans', { pat_num: patNum });
      const plan = (plans.results || []).find((p) => Number(p.TreatPlanNum) === planNum);
      attached = new Set((Array.isArray(plan?.items) ? plan.items : []).map((i) => Number(i.ProcNum)));
    }
  } catch (e) {
    readBackError = `Everything was sent, but reading it back failed (${e.message}). Check the chart in Open Dental.`;
  }
  const readBack = draft.plan.items.map((line) => {
    const p = tp.get(line.written.procNum);
    const pri = priorities.find((d) => d.defNum === Number(p?.Priority));
    const ok = !!p && String(p.procCode || p.ProcCode).toUpperCase() === line.procCode
      && (!line.tooth || String(p.ToothNum).toUpperCase() === line.tooth)
      && (!line.surfaces || String(p.Surf).toUpperCase() === line.surfaces)
      && (!line.priorityDefNum || Number(p.Priority) === line.priorityDefNum)
      && (!attached || attached.has(line.written.procNum));
    return {
      procNum: line.written.procNum, ok, procCode: line.procCode, descript: line.descript,
      tooth: p ? p.ToothNum : line.tooth, surfaces: p ? p.Surf : line.surfaces, toothRange: line.toothRange,
      priority: pri ? pri.name : '', fee: p ? Number(p.ProcFee) : null,
    };
  });
  return { kind: PLAN, planNum, planHeading: t.type === 'new' ? t.heading : '', lines: readBack, readBackError, allOk: !readBackError && readBack.every((l) => l.ok) };
}

async function confirmNote({ od, draft, today, save }) {
  const patNum = draft.patNum;
  const text = String(draft.note.text || '').trim();
  if (!text) throw new ConfirmError('The note is empty.');
  if (text.length > 20000) throw new ConfirmError('The note is too long.');
  let noteProcNum;
  let covered = [];
  if (draft.note.written) {
    // Already written on an earlier try; only read back.
    noteProcNum = draft.note.written.procNum;
    covered = draft.note.written.covered || [];
  } else if (draft.note.type === 'addendum') {
    noteProcNum = Number(draft.note.procNum);
    if (!noteProcNum) throw new ConfirmError('Pick the procedure the addendum goes on.');
    await od.write('od_append_procedure_note', { pat_num: patNum, proc_num: noteProcNum, note: text });
  } else {
    const done = await todaysCompleted(od, patNum, today);
    const available = new Set(done.map((p) => Number(p.ProcNum)));
    const chosen = (Array.isArray(draft.note.procNums) ? draft.note.procNums : [...available]).map(Number).filter((n) => available.has(n));
    if (!chosen.length) throw new ConfirmError("This patient has no completed procedures today, so there is nothing for a group note to cover. Set today's procedures complete in Open Dental first, then Confirm.");
    const r = await od.write('od_add_group_note', { pat_num: patNum, proc_nums: chosen, note: text });
    noteProcNum = Number(r.results && r.results.ProcNum);
    covered = chosen;
  }
  if (!draft.note.written) {
    draft.note.written = { procNum: noteProcNum || null, covered };
    await save(draft);
  }
  // Read back: the newest note on that procedure must contain the text, unsigned.
  let ok = false; let signed = null; let readBackError = '';
  try {
    if (!noteProcNum) throw new Error('Open Dental did not return the note\'s procedure number.');
    const r = await od.read('od_get_procedure_notes', { pat_num: patNum, proc_num: noteProcNum });
    const notes = (Array.isArray(r.results) ? r.results : []).sort((a, b) => Number(b.ProcNoteNum || 0) - Number(a.ProcNoteNum || 0));
    const latest = notes[0];
    ok = !!latest && norm(latest.Note).includes(norm(text));
    signed = latest ? String(latest.isSigned) === 'true' : null;
  } catch (e) {
    readBackError = `The note was sent, but reading it back failed (${e.message}). Check the chart in Open Dental.`;
  }
  return { kind: NOTE, noteType: draft.note.type, procNum: noteProcNum, covered, ok, signed, readBackError, allOk: ok && signed !== true };
}

/** Runs Confirm. `save` persists progress. Returns the read-back. */
async function confirmDraft({ od, draft, who, policy, save, today }) {
  if (!who.roles.some((r) => CONFIRM_ROLES.includes(r))) throw new ConfirmError('Only a doctor, hygienist or owner can Confirm. The draft is waiting for them.');
  const allowed = writeAllowed(policy, draft.patNum);
  if (!allowed.ok) throw new ConfirmError(allowed.why);
  if (draft.kind === PLAN) return confirmPlan({ od, draft, save });
  if (draft.kind === NOTE) return confirmNote({ od, draft, today, save });
  throw new ConfirmError('Unknown draft type.');
}

module.exports = { confirmDraft, writeAllowed, todaysCompleted, ConfirmError, CONFIRM_ROLES };
