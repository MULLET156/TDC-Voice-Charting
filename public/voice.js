/* Voice Charting page script. No inline scripts (CONTRACT §6).
 *
 * Text gets into the dictation box by typing, or by Wispr Flow, which types into
 * whichever box has focus. There is deliberately NO browser speech recognition
 * here (Chrome's Web Speech API sends audio to Google). A later built-in mic with
 * local Whisper would be one more "text source" that fills the same box; see
 * TEXT_SOURCES below.
 *
 * The dictation stays in this page only: it is not saved on the device and it is
 * cleared when you tap Discard or leave and come back.
 */
(function () {
  'use strict';

  // Ways text can get into the box. Version 1: the keyboard and Wispr Flow (both just type).
  var TEXT_SOURCES = ['keyboard-or-wispr-flow'];
  window.TDCVoice = { textSources: TEXT_SOURCES };

  var box = document.getElementById('dictation');
  var form = document.getElementById('dictate-form');

  // ---- Plan / Note switch
  var seg = document.getElementById('kind-seg');
  var kindInput = document.getElementById('kind-input');
  var hint = document.getElementById('dictation-hint');
  if (seg && kindInput) {
    seg.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        kindInput.value = b.getAttribute('data-kind');
        seg.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        if (hint) hint.textContent = hint.getAttribute('data-hint-' + kindInput.value) || '';
        if (box) box.focus();
      });
    });
  }

  if (box) {
    // Focus the box so Wispr Flow types straight into it (autofocus can be skipped on some tablets).
    if (document.activeElement !== box) box.focus();
    // Coming back with the Back button: don't bring old dictation back.
    window.addEventListener('pageshow', function (e) { if (e.persisted && !box.hasAttribute('data-keep')) box.value = ''; });
    if (box.value) box.setAttribute('data-keep', '1'); // shown again after an error: keep it
  }

  var clearBtn = document.getElementById('clear-btn');
  if (clearBtn && box) {
    clearBtn.addEventListener('click', function () {
      var old = box.value;
      box.value = '';
      box.focus();
      if (old && window.TDC && window.TDC.toast) {
        window.TDC.toast('Dictation cleared', { action: 'Undo', onAction: function () { box.value = old; old = ''; box.focus(); } });
        setTimeout(function () { old = ''; }, 8000);
      }
    });
  }

  if (form) {
    form.addEventListener('submit', function (e) {
      if (!box.value.trim()) { e.preventDefault(); box.focus(); setStatus('draft-status', 'The dictation box is empty.'); return; }
      var btn = document.getElementById('draft-btn');
      if (btn.disabled) { e.preventDefault(); return; }
      btn.disabled = true;
      setStatus('draft-status', 'Claude is drafting… about 10–30 seconds.');
    });
  }

  // ---- Draft page
  function setStatus(id, text) { var el = document.getElementById(id); if (el) el.textContent = text; }

  var draftForm = document.getElementById('draft-form');
  if (draftForm) {
    var confirmBtn = document.getElementById('confirm-btn');
    var submitting = false;
    draftForm.addEventListener('submit', function (e) {
      var by = e.submitter;
      if (submitting) { e.preventDefault(); return; }
      if (by && by.id === 'discard-btn') {
        e.preventDefault();
        openDiscard();
        return;
      }
      submitting = true;
      if (by && by.value === 'confirm') { by.disabled = true; setStatus('confirm-status', 'Writing to Open Dental and reading it back…'); addHidden('confirm'); }
    });
    // A disabled submit button isn't sent; keep the chosen action.
    function addHidden(v) { var i = document.createElement('input'); i.type = 'hidden'; i.name = 'action'; i.value = v; draftForm.appendChild(i); }

    // Editing a line after a red problem: let the person save to re-check.
    if (confirmBtn && confirmBtn.disabled) {
      draftForm.addEventListener('input', function () { setStatus('confirm-status', 'Tap Save changes to check the lines again.'); });
    }

    // "New plan name" only when "A new named plan" is chosen.
    var target = document.getElementById('target-select');
    var heading = document.getElementById('heading-field');
    function syncTarget() { if (target && heading) heading.hidden = target.value !== 'new'; }
    if (target) { target.addEventListener('change', syncTarget); syncTarget(); }

    // Note: show the group list or the addendum choice.
    var types = draftForm.querySelectorAll('input[name="noteType"]');
    function syncType() {
      var v = 'group';
      types.forEach(function (r) { if (r.checked) v = r.value; });
      draftForm.querySelectorAll('[data-show-for]').forEach(function (el) { el.hidden = el.getAttribute('data-show-for') !== v; });
    }
    types.forEach(function (r) { r.addEventListener('change', syncType); });
    if (types.length) syncType();

    // Discard asks first (DESIGN.md §11 dialog).
    var dlg = document.getElementById('discard-dialog');
    function openDiscard() { if (!dlg) return; dlg.hidden = false; document.getElementById('discard-no').focus(); }
    function closeDiscard() { dlg.hidden = true; document.getElementById('discard-btn').focus(); }
    if (dlg) {
      document.getElementById('discard-no').addEventListener('click', closeDiscard);
      dlg.addEventListener('click', function (e) { if (e.target === dlg) closeDiscard(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !dlg.hidden) closeDiscard(); });
      document.getElementById('discard-yes').addEventListener('click', function () { submitting = true; addHidden('discard'); draftForm.submit(); });
    }
  }
})();
