'use strict';
// HTML for every page. Shared look only (CONTRACT §6, DESIGN.md): /shared/tdc.css,
// /shared/shell.js, data-module="voice" (magenta accent), .tdc-* classes.
// No inline scripts; every value is escaped.

const TZ = 'America/Los_Angeles';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const rowDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ }) : '');
const rowTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ }) : '');
const ymdDate = (ymd) => (ymd ? new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');
const money = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '' : `$${Number(n).toFixed(2)}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function patientName(p) {
  if (!p) return '';
  const first = p.Preferred && p.Preferred !== p.FName ? `${p.FName} “${p.Preferred}”` : p.FName;
  return `${p.LName}, ${first}`;
}

function actions(who, current, { canSettings }) {
  const b = esc(who.base);
  const btn = (kind, icon, label, href) => `<a class="tdc-hbtn" data-kind="${kind}" data-icon="${icon}" href="${b}${href}"${current === href ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="tdc-actions" aria-label="Page actions">
${btn('new', 'plus', 'New dictation', '/')}
${btn('log', 'history', 'History', '/history')}
${canSettings ? btn('setup', 'settings', 'Settings', '/settings') : ''}
</nav>`;
}

function layout(who, { title, current = '', canSettings = false }, inner) {
  const b = esc(who.base);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(title)} · Voice Charting</title>
<link rel="stylesheet" href="/shared/tdc.css">
<link rel="stylesheet" href="${b}/static/voice.css">
<script src="/shared/shell.js" defer></script>
<script src="${b}/static/voice.js" defer></script>
</head>
<body data-module="voice">
<main class="tdc-main">
${actions(who, current, { canSettings })}
${inner}
</main>
</body></html>`;
}

function pagehead({ icon, title, count = '', help = '', status = '' }) {
  return `<header class="tdc-pagehead"${status ? ` data-status="${status}"` : ''}>
  <h2><span data-icon="${icon}"></span>${esc(title)}</h2>
  ${count ? `<span class="tdc-count">${esc(count)}</span>` : ''}
  ${help ? `<p class="tdc-help">${esc(help)}</p>` : ''}
</header>`;
}

function callout(status, title, body = '') {
  const icon = status === 'ok' ? 'check' : status === 'info' ? 'pending' : 'alert';
  return `<div class="tdc-callout" data-status="${status}" role="${status === 'alert' ? 'alert' : 'status'}"><span data-icon="${icon}"></span><div><strong>${esc(title)}</strong>${body}</div></div>`;
}

function pausedPage(who, opts, reason) {
  return layout(who, { title: 'Paused', ...opts }, `${pagehead({ icon: 'alert', title: 'Voice Charting is paused', status: 'alert' })}
${callout('alert', 'Not showing patient information right now', `${esc(reason)} It checks again every few minutes.`)}`);
}

// ---------------------------------------------------------------- home: dictate
function patientRow(p, { href, action }) {
  return `<div class="tdc-row" data-status="accent">
  <div class="tdc-row-main">
    <p class="tdc-row-title">${esc(patientName(p))} <span class="tdc-id">#${esc(p.PatNum)}</span></p>
    <div class="tdc-row-chips">${p.Birthdate && p.Birthdate !== '0001-01-01' ? `<span class="tdc-chip tdc-mono">Born ${esc(p.Birthdate)}</span>` : ''}${p.PatStatus && p.PatStatus !== 'Patient' ? `<span class="tdc-chip" data-status="warn">${esc(p.PatStatus)}</span>` : ''}</div>
  </div>
  <div class="tdc-row-act"><a class="tdc-btn${action === 'Choose' ? ' tdc-btn-primary' : ''}" href="${esc(href)}">${esc(action)}</a></div>
</div>`;
}

function waitingRows(who, drafts, nameOf, canConfirm) {
  if (!drafts.length) return '<div class="tdc-empty"><p>Nothing waiting</p>Drafts show up here until someone confirms or discards them.</div>';
  return drafts.map((d) => {
    const mine = d.dictatedBy.user === who.user;
    const lines = d.kind === 'plan' ? plural(d.plan.items.length, 'line') : 'Note';
    const problems = d.kind === 'plan' ? d.plan.items.filter((l) => !l.written && l.problems.length).length : 0;
    return `<div class="tdc-row" data-status="${problems ? 'warn' : 'new'}">
  <div class="tdc-row-main">
    <p class="tdc-row-title">${esc(nameOf(d.patNum))} <span class="tdc-id">#${esc(d.patNum)}</span></p>
    <div class="tdc-row-chips"><span class="tdc-chip">${d.kind === 'plan' ? 'Treatment plan' : 'Note'}</span><span class="tdc-chip">${esc(lines)}</span>${problems ? `<span class="tdc-chip" data-status="warn">${plural(problems, 'line')} to fix</span>` : ''}${mine ? '<span class="tdc-chip" data-status="info">Mine</span>' : ''}</div>
    <div class="tdc-row-sub">Dictated by <strong>${esc(d.dictatedBy.name)}</strong></div>
  </div>
  <div class="tdc-row-side"><div>${esc(rowDate(d.createdAt))}</div><div>${esc(rowTime(d.createdAt))}</div></div>
  <div class="tdc-row-act"><a class="tdc-btn${canConfirm ? ' tdc-btn-primary' : ''}" href="${esc(who.base)}/draft/${esc(d.id)}">${canConfirm ? 'Review' : 'Open'}</a></div>
</div>`;
  }).join('\n');
}

function homePage(who, opts, { patient, search, results, kind, dictation, error, notice, drafts, nameOf, canConfirm }) {
  const b = esc(who.base);
  let step1;
  if (patient) {
    step1 = `<section class="tdc-list" aria-label="Patient">
<h3 class="tdc-gh" data-nofold><span>Patient</span></h3>
${patientRow(patient, { href: `${who.base}/`, action: 'Change' })}
</section>`;
  } else {
    const list = results === null ? '' : results.length
      ? `<section class="tdc-list" aria-label="Matching patients"><h3 class="tdc-gh" data-nofold><span>Matching patients</span><span class="tdc-gcount">${results.length}</span></h3>${results.map((p) => patientRow(p, { href: `${who.base}/?pat=${p.PatNum}`, action: 'Choose' })).join('\n')}</section>`
      : `<div class="tdc-empty"><p>No patients match “${esc(search)}”</p>Try the last name only, “Last, First”, or the patient number. <a href="${b}/">Clear search</a></div>`;
    step1 = `<form class="tdc-find" method="get" action="${b}/" role="search" autocomplete="off">
  <input type="search" name="q" value="${esc(search || '')}" placeholder="Find the patient: last name, “Last, First” or patient #" aria-label="Find the patient" autofocus>
  <button class="tdc-btn tdc-btn-primary" type="submit">Find</button>
</form>
${list}`;
  }

  const form = patient ? `<form class="tdc-dictate" method="post" action="${b}/draft" autocomplete="off" id="dictate-form">
  <input type="hidden" name="pat" value="${esc(patient.PatNum)}">
  <input type="hidden" name="kind" value="${esc(kind)}" id="kind-input">
  <div class="tdc-groupby">
    <span class="tdc-seg-label">Make a</span>
    <div class="tdc-seg" role="group" aria-label="What to draft" id="kind-seg">
      <button type="button" data-kind="plan" aria-pressed="${kind === 'plan'}">Treatment plan</button>
      <button type="button" data-kind="note" aria-pressed="${kind === 'note'}">Note</button>
    </div>
  </div>
  <label class="tdc-dictate-label" for="dictation">Dictation</label>
  <textarea id="dictation" name="dictation" class="tdc-dictation" rows="9" maxlength="8000" autofocus spellcheck="false" autocorrect="off" autocomplete="off"
    placeholder="Tap here and dictate with Wispr Flow, or type" aria-describedby="dictation-hint">${esc(dictation || '')}</textarea>
  <p class="tdc-muted tdc-dictate-hint" id="dictation-hint" data-hint-plan="For example: “Crown on thirty, MOD composite on three, phase two. Bitewings next visit.”" data-hint-note="For example: “Two carpules lido with epi, MOD composite on three, A2, patient tolerated well.”">${kind === 'note' ? 'For example: “Two carpules lido with epi, MOD composite on three, A2, patient tolerated well.”' : 'For example: “Crown on thirty, MOD composite on three, phase two. Bitewings next visit.”'}</p>
  <div class="tdc-btn-row">
    <button class="tdc-btn tdc-btn-primary tdc-btn-big" type="submit" id="draft-btn"><span data-icon="edit"></span> Draft</button>
    <button class="tdc-btn" type="button" id="clear-btn">Discard</button>
    <span class="tdc-muted" id="draft-status" role="status" aria-live="polite"></span>
  </div>
</form>` : '';

  return layout(who, { title: 'New dictation', current: '/', ...opts }, `${pagehead({ icon: 'mic', title: 'New dictation', count: patient ? `#${patient.PatNum}` : '', help: 'Pick the patient, choose Treatment plan or Note, dictate with Wispr Flow (or type), then tap Draft. Claude makes a draft for you to check. Nothing goes into Open Dental until a doctor, hygienist or owner taps Confirm.' })}
${error ? callout('alert', 'Couldn\'t make a draft', `${esc(error)}`) : ''}
${notice ? callout('ok', notice) : ''}
${step1}
${form}
<section class="tdc-list" aria-label="Waiting for Confirm" id="waiting">
<h3 class="tdc-gh" data-status="new"><span>Waiting for Confirm</span><span class="tdc-gcount">${drafts.length}</span></h3>
${waitingRows(who, drafts, nameOf, canConfirm)}
</section>`);
}

// ---------------------------------------------------------------- draft review
function prioritySelect(name, value, priorities) {
  return `<select name="${name}" aria-label="Priority"><option value="0">No priority</option>${priorities.map((d) => `<option value="${d.defNum}"${d.defNum === value ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}</select>`;
}

function planLine(line, i, priorities) {
  if (line.written) {
    return `<div class="tdc-row" data-status="ok">
  <div class="tdc-row-main">
    <p class="tdc-row-title"><span class="tdc-mono">${esc(line.procCode)}</span> ${esc(line.descript)}</p>
    <div class="tdc-row-chips">${line.tooth ? `<span class="tdc-chip">#${esc(line.tooth)}</span>` : ''}${line.surfaces ? `<span class="tdc-chip">${esc(line.surfaces)}</span>` : ''}<span class="tdc-chip" data-status="ok">Written · ProcNum ${esc(line.written.procNum)}</span></div>
  </div>
  <input type="hidden" name="l${i}.id" value="${esc(line.id)}">
</div>`;
  }
  const bad = line.problems.length > 0;
  return `<div class="tdc-row tdc-line" data-status="${bad ? 'alert' : 'accent'}">
  <div class="tdc-row-main">
    <input type="hidden" name="l${i}.id" value="${esc(line.id)}">
    <p class="tdc-row-title">${line.descript ? esc(line.descript) : '<span class="tdc-muted">Unknown code</span>'}</p>
    <div class="tdc-line-fields">
      <label>Code<input name="l${i}.procCode" value="${esc(line.procCode)}" class="tdc-mono" maxlength="15" required autocapitalize="characters"></label>
      <label>Tooth<input name="l${i}.tooth" value="${esc(line.tooth)}" class="tdc-mono" maxlength="4" inputmode="text" autocapitalize="characters"></label>
      <label>Surfaces<input name="l${i}.surfaces" value="${esc(line.surfaces)}" class="tdc-mono" maxlength="8" autocapitalize="characters"></label>
      ${line.toothRange || line.treatArea.toLowerCase() === 'toothrange' ? `<label class="tdc-line-range">Teeth (range)<input name="l${i}.toothRange" value="${esc(line.toothRange)}" class="tdc-mono" maxlength="120" aria-describedby="range-hint-${i}"><span class="tdc-muted" id="range-hint-${i}">e.g. 3,4,5</span></label>` : `<input type="hidden" name="l${i}.toothRange" value="">`}
      <label class="tdc-line-pri">Priority${prioritySelect(`l${i}.priorityDefNum`, line.priorityDefNum, priorities)}</label>
      <label class="tdc-line-note">Note<input name="l${i}.note" value="${esc(line.note)}" maxlength="2000"></label>
    </div>
    ${bad ? `<ul class="tdc-problems">${line.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
  </div>
  <div class="tdc-row-act"><button class="tdc-btn tdc-compact" type="submit" name="action" value="remove:${esc(line.id)}" aria-label="Remove this line" formnovalidate>Remove</button></div>
</div>`;
}

function draftPage(who, opts, { draft, patient, priorities, plans, todayProcs, recentProcs, canConfirm, error, writeNote }) {
  const b = esc(who.base);
  const d = draft;
  const isPlan = d.kind === 'plan';
  const toWrite = isPlan ? d.plan.items.filter((l) => !l.written) : [];
  const problems = toWrite.filter((l) => l.problems.length).length;
  const partly = isPlan && d.plan.items.some((l) => l.written);
  let body;
  if (isPlan) {
    const t = d.plan.target || { type: 'none' };
    const planOptions = plans.filter((p) => p.TPStatus !== 'Saved');
    body = `<section class="tdc-list" aria-label="Plan lines">
<h3 class="tdc-gh" data-nofold><span>Procedures</span><span class="tdc-gcount">${d.plan.items.length}</span></h3>
${d.plan.items.length ? d.plan.items.map((l, i) => planLine(l, i, priorities)).join('\n') : '<div class="tdc-empty"><p>No lines yet</p>Tap “Add a line” to type one in.</div>'}
</section>
<div class="tdc-btn-row"><button class="tdc-btn" type="submit" name="action" value="add" formnovalidate><span data-icon="plus"></span> Add a line</button></div>
<div class="tdc-card tdc-form">
  <label>Put these on
    <select name="target" id="target-select">
      <option value="none"${t.type === 'none' ? ' selected' : ''}>The patient's Active plan (no named plan)</option>
      <option value="new"${t.type === 'new' ? ' selected' : ''}>A new named plan…</option>
      ${planOptions.map((p) => `<option value="plan:${esc(p.TreatPlanNum)}"${t.type === 'existing' && Number(t.treatPlanNum) === Number(p.TreatPlanNum) ? ' selected' : ''}>${esc(p.Heading || 'Untitled plan')} (${esc(p.TPStatus)})</option>`).join('')}
    </select>
  </label>
  <label id="heading-field"${t.type === 'new' ? '' : ' data-hidden-unless="new"'}>New plan name<input name="heading" value="${esc(t.type === 'new' ? t.heading : '')}" maxlength="200" placeholder="Phase 1 – Urgent"></label>
  ${d.plan.writtenPlanNum ? `<p class="tdc-muted">The new plan was already made (TreatPlanNum ${esc(d.plan.writtenPlanNum)}).</p>` : ''}
</div>`;
  } else {
    const n = d.note;
    const chosen = Array.isArray(n.procNums) ? new Set(n.procNums.map(Number)) : null;
    body = `<div class="tdc-card tdc-form">
  <label for="note-text">Note text</label>
  <textarea id="note-text" name="noteText" class="tdc-dictation" rows="12" maxlength="20000" spellcheck="false">${esc(n.text)}</textarea>
</div>
<fieldset class="tdc-card tdc-form tdc-notetype">
  <legend>Where it goes</legend>
  <label class="tdc-check"><input type="radio" name="noteType" value="group"${n.type !== 'addendum' ? ' checked' : ''}> Group note on today's completed procedures</label>
  <div data-show-for="group">
  ${todayProcs.length ? todayProcs.map((p) => `<label class="tdc-check"><input type="checkbox" name="proc" value="${esc(p.ProcNum)}"${!chosen || chosen.has(Number(p.ProcNum)) ? ' checked' : ''}> <span class="tdc-mono">${esc(p.procCode || p.ProcCode)}</span> ${p.ToothNum ? `#${esc(p.ToothNum)} ` : ''}${p.Surf ? `${esc(p.Surf)} ` : ''}<span class="tdc-muted">${esc(p.descript || '')}</span></label>`).join('')
    : '<p class="tdc-muted">No completed procedures today yet. Set today\'s work complete in Open Dental, then come back and Confirm (or save the draft for later).</p>'}
  </div>
  <label class="tdc-check"><input type="radio" name="noteType" value="addendum"${n.type === 'addendum' ? ' checked' : ''}> Addendum to an earlier procedure's note</label>
  <div data-show-for="addendum">
    <select name="addendumProc" aria-label="Procedure for the addendum"><option value="">Choose a procedure…</option>${recentProcs.map((p) => `<option value="${esc(p.ProcNum)}"${Number(n.procNum) === Number(p.ProcNum) ? ' selected' : ''}>${esc(ymdDate(String(p.ProcDate).slice(0, 10)))} · ${esc(p.procCode || p.ProcCode)}${p.ToothNum ? ` #${esc(p.ToothNum)}` : ''}${p.Surf ? ` ${esc(p.Surf)}` : ''}</option>`).join('')}</select>
  </div>
</fieldset>`;
  }

  const count = isPlan ? plural(d.plan.items.length, 'line') : `${(d.note.text || '').length} characters`;
  const confirmBlock = canConfirm
    ? `<button class="tdc-btn tdc-btn-primary tdc-btn-big" type="submit" name="action" value="confirm" id="confirm-btn"${problems ? ' disabled' : ''}><span data-icon="check"></span> Confirm and write to Open Dental</button>`
    : '';
  return layout(who, { title: 'Review draft', ...opts }, `${pagehead({ icon: 'edit', title: isPlan ? 'Treatment plan draft' : 'Note draft', count, help: 'Check every line against what was said. Edit anything, then Confirm to write it to Open Dental. Nothing is signed: sign in Open Dental as usual. Discard throws the draft away.' })}
${error ? callout('alert', 'Not written', `${esc(error)}`) : ''}
${partly ? callout('warn', 'Partly written', 'The green lines are already in Open Dental. Confirm again to write the rest; the green lines won\'t be written twice.') : ''}
${writeNote ? callout('info', 'Design stage', `${esc(writeNote)}`) : ''}
${!canConfirm ? callout('info', 'Waiting for Confirm', 'A doctor, hygienist or owner reviews and confirms this draft. You can still edit it.') : ''}
<section class="tdc-list" aria-label="Patient">
<h3 class="tdc-gh" data-nofold><span>Patient</span></h3>
<div class="tdc-row" data-status="accent">
  <div class="tdc-row-main">
    <p class="tdc-row-title">${esc(patient ? patientName(patient) : `Patient #${d.patNum}`)} <span class="tdc-id">#${esc(d.patNum)}</span></p>
    <div class="tdc-row-sub">Dictated by <strong>${esc(d.dictatedBy.name)}</strong> · ${esc(rowDate(d.createdAt))} ${esc(rowTime(d.createdAt))}${d.editedBy ? ` · last edited by <strong>${esc(d.editedBy.name)}</strong>` : ''}</div>
  </div>
</div>
</section>
${d.warnings && d.warnings.length ? callout('warn', 'Please check', `<ul>${d.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`) : ''}
<form method="post" action="${b}/draft/${esc(d.id)}" id="draft-form" autocomplete="off">
<input type="hidden" name="version" value="${esc(d.version)}">
${body}
<div class="tdc-btn-row tdc-draft-actions">
  ${confirmBlock}
  <button class="tdc-btn" type="submit" name="action" value="save">Save changes</button>
  <button class="tdc-btn tdc-btn-danger" type="submit" name="action" value="discard" id="discard-btn" formnovalidate>Discard draft</button>
  <span class="tdc-muted" id="confirm-status" role="status" aria-live="polite">${problems ? `Fix ${plural(problems, 'line')} in red to Confirm.` : ''}</span>
</div>
</form>
<div class="tdc-scrim" id="discard-dialog" hidden>
  <div class="tdc-dialog" role="dialog" aria-modal="true" aria-labelledby="discard-title">
    <h2 id="discard-title">Discard this draft?</h2>
    <p>The draft is deleted. Nothing was written to Open Dental${partly ? ' except the green lines, which stay' : ''}.</p>
    <div class="tdc-btn-row"><button class="tdc-btn tdc-btn-danger" type="button" id="discard-yes">Discard</button><button class="tdc-btn" type="button" id="discard-no">Keep it</button></div>
  </div>
</div>`);
}

// ---------------------------------------------------------------- done (read-back)
function donePage(who, opts, { result, patient, patNum }) {
  const b = esc(who.base);
  const r = result;
  let rows;
  if (r.kind === 'plan') {
    rows = `<section class="tdc-list" aria-label="Written">
<h3 class="tdc-gh" data-status="${r.allOk ? 'ok' : 'alert'}" data-nofold><span>${r.planNum ? `Plan ${esc(r.planHeading || `#${r.planNum}`)}` : 'Active plan'}</span><span class="tdc-gcount">${r.lines.length}</span></h3>
${r.lines.map((l) => `<div class="tdc-row" data-status="${l.ok ? 'ok' : 'alert'}">
  <div class="tdc-row-main">
    <p class="tdc-row-title"><span class="tdc-mono">${esc(l.procCode)}</span> ${esc(l.descript)}</p>
    <div class="tdc-row-chips">${l.tooth ? `<span class="tdc-chip">#${esc(l.tooth)}</span>` : ''}${l.surfaces ? `<span class="tdc-chip">${esc(l.surfaces)}</span>` : ''}${l.toothRange ? `<span class="tdc-chip">#${esc(l.toothRange)}</span>` : ''}${l.priority ? `<span class="tdc-chip" data-status="info">Priority ${esc(l.priority)}</span>` : ''}<span class="tdc-chip">ProcNum ${esc(l.procNum)}</span>${l.ok ? '<span class="tdc-chip" data-status="ok">Read back</span>' : '<span class="tdc-chip" data-status="alert">Check in Open Dental</span>'}</div>
  </div>
  <div class="tdc-row-side"><div>${esc(money(l.fee))}</div><div class="tdc-muted">fee</div></div>
</div>`).join('\n')}
</section>`;
  } else {
    rows = `<section class="tdc-list" aria-label="Written">
<h3 class="tdc-gh" data-status="${r.allOk ? 'ok' : 'alert'}" data-nofold><span>${r.noteType === 'addendum' ? 'Addendum' : 'Group note'}</span></h3>
<div class="tdc-row" data-status="${r.ok ? 'ok' : 'alert'}">
  <div class="tdc-row-main">
    <p class="tdc-row-title">${r.noteType === 'addendum' ? `Added to the note on ProcNum ${esc(r.procNum)}` : `Group note covering ${plural(r.covered.length, 'procedure')}`}</p>
    <div class="tdc-row-chips"><span class="tdc-chip">ProcNum ${esc(r.procNum)}</span>${r.ok ? '<span class="tdc-chip" data-status="ok">Read back</span>' : '<span class="tdc-chip" data-status="alert">Check in Open Dental</span>'}<span class="tdc-chip" data-status="warn">Unsigned</span></div>
  </div>
</div>
</section>`;
  }
  const head = r.allOk ? 'Written to Open Dental' : 'Written. Please check it in Open Dental';
  return layout(who, { title: 'Written', ...opts }, `${pagehead({ icon: r.allOk ? 'check' : 'alert', title: head, status: r.allOk ? 'ok' : 'warn', count: patient ? patientName(patient) : `#${patNum}`, help: 'What Open Dental has now, read back right after writing. Nothing was signed: sign the notes and plan in Open Dental as usual.' })}
${r.readBackError ? callout('warn', 'Read-back failed', `${esc(r.readBackError)}`) : ''}
${callout('info', 'Not signed', 'Sign it in Open Dental as usual.')}
${rows}
<div class="tdc-btn-row">
  <a class="tdc-btn tdc-btn-primary" href="${b}/?pat=${esc(patNum)}">New dictation for this patient</a>
  <a class="tdc-btn" href="${b}/">New dictation</a>
</div>`);
}

// ---------------------------------------------------------------- history
function historyPage(who, opts, { entries, nameOf, all }) {
  const b = esc(who.base);
  const groups = new Map();
  for (const e of entries) {
    const k = rowDate(e.time);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const list = entries.length
    ? [...groups].map(([day, es]) => `<h3 class="tdc-gh"><span>${esc(day)}</span><span class="tdc-gcount">${es.length}</span></h3>
${es.map((e) => `<div class="tdc-row" data-status="${e.result === 'written' ? 'ok' : e.result === 'discarded' ? 'new' : 'alert'}">
  <div class="tdc-row-main">
    <p class="tdc-row-title">${esc(nameOf(e.patNum))} <span class="tdc-id">#${esc(e.patNum)}</span></p>
    <div class="tdc-row-chips"><span class="tdc-chip">${e.kind === 'plan' ? 'Treatment plan' : 'Note'}</span>${(e.lines || []).slice(0, 8).map((l) => `<span class="tdc-chip tdc-mono">${esc(l.procCode)}${l.tooth ? ` #${esc(l.tooth)}` : ''}${l.surfaces ? ` ${esc(l.surfaces)}` : ''}</span>`).join('')}${e.result === 'written' ? '<span class="tdc-chip" data-status="ok">Written</span>' : e.result === 'discarded' ? '<span class="tdc-chip" data-status="new">Discarded</span>' : '<span class="tdc-chip" data-status="alert">Partly written</span>'}</div>
    <div class="tdc-row-sub">Dictated by <strong>${esc(e.dictatedBy?.name || '')}</strong>${e.confirmedBy ? ` · confirmed by <strong>${esc(e.confirmedBy.name)}</strong>` : ''}${e.discardedBy ? ` · discarded by <strong>${esc(e.discardedBy.name)}</strong>` : ''}</div>
  </div>
  <div class="tdc-row-side"><div>${esc(rowTime(e.time))}</div></div>
</div>`).join('\n')}`).join('\n')
    : '<div class="tdc-empty"><p>No history yet</p>Confirmed and discarded drafts show up here.</div>';
  const seg = who.roles.includes('owner')
    ? `<div class="tdc-groupby"><span class="tdc-seg-label">Show</span><div class="tdc-seg" role="group" aria-label="Show"><a class="tdc-btn" href="${b}/history" aria-pressed="${!all}">Mine</a><a class="tdc-btn" href="${b}/history?all=1" aria-pressed="${!!all}">Everyone</a></div></div>`
    : '';
  return layout(who, { title: 'History', current: '/history', ...opts }, `${pagehead({ icon: 'history', title: 'History', count: plural(entries.length, 'entry', 'entries'), help: 'What was written to Open Dental from Voice Charting: who dictated, who confirmed, and the codes and teeth. Note text is not kept here; it is in the chart.' })}
${seg}
<section class="tdc-list" aria-label="History">${list}</section>`);
}

// ---------------------------------------------------------------- settings
function settingsPage(who, opts, { settings, defaultModel, stage, gatewayFake, writePatNums, saved, words }) {
  const b = esc(who.base);
  return layout(who, { title: 'Settings', current: '/settings', ...opts }, `${pagehead({ icon: 'settings', title: 'Settings', help: 'Which Claude model drafts, and office words that help Claude understand dictation.' })}
${saved ? callout('ok', 'Saved') : ''}
<form class="tdc-card tdc-form" method="post" action="${b}/settings">
  <label>Claude model<input name="model" value="${esc(settings.model)}" placeholder="${esc(defaultModel)}" maxlength="80" class="tdc-mono"></label>
  <p class="tdc-muted">Leave empty for the default (${esc(defaultModel)}).</p>
  <label>Office words<textarea name="words" rows="10" maxlength="3000" placeholder="One per line, e.g. &#10;Blue Sky Bio = implant brand&#10;KATANA = zirconia block">${esc(settings.words)}</textarea></label>
  <p class="tdc-muted">Claude reads these with every dictation. Add brand names, shorthand and anything it keeps getting wrong.</p>
  <div class="tdc-btn-row"><button class="tdc-btn tdc-btn-primary" type="submit">Save</button></div>
</form>
<div class="tdc-card">
  <h3>Safety</h3>
  <table class="tdc-table"><tbody>
    <tr><th>Stage</th><td><span class="tdc-badge-${stage === 'live' ? 'alert' : 'ok'}">${esc(stage)}</span>${gatewayFake ? ' <span class="tdc-badge">demo gateway, fake data</span>' : ''}</td></tr>
    <tr><th>Writes allowed to</th><td class="tdc-mono">${stage === 'live' ? 'Any patient (after Confirm)' : gatewayFake ? 'Made-up patients (fake data)' : `PatNum ${esc(writePatNums.join(', '))} only`}</td></tr>
    <tr><th>Who can Confirm</th><td>Doctor, hygienist, owner</td></tr>
    <tr><th>Signing</th><td>Never. Notes and plans are signed in Open Dental.</td></tr>
  </tbody></table>
</div>
<div class="tdc-card"><h3>Words for Wispr Flow's dictionary</h3><p class="tdc-muted">Add these in Wispr Flow → Dictionary so it spells them right:</p><p class="tdc-mono">${esc(words.join(' · '))}</p></div>`);
}

function messagePage(who, opts, { title, status = 'alert', text }) {
  return layout(who, { title, ...opts }, `${pagehead({ icon: status === 'ok' ? 'check' : 'alert', title, status })}
${callout(status, title, `${esc(text)}`)}
<div class="tdc-btn-row"><a class="tdc-btn" href="${esc(who.base)}/">New dictation</a></div>`);
}

module.exports = { layout, homePage, draftPage, donePage, historyPage, settingsPage, pausedPage, messagePage, patientName, esc, rowDate, TZ };
