'use strict';
// The module's own records (CONTRACT §8): drafts waiting for Confirm, the
// history of what was written (who dictated, who confirmed, PatNum, ProcNums,
// codes; never note text or names), and settings. Nothing copied from Open
// Dental is kept here. Files live in DATA_DIR (default ./data), never committed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_SETTINGS = { model: '', words: '' };
const MAX_HISTORY = 2000;

function createStore({ dir, draftHours = 72, now = () => Date.now() }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = {
    drafts: path.join(dir, 'drafts.json'),
    history: path.join(dir, 'history.json'),
    settings: path.join(dir, 'settings.json'),
  };

  function read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }
  function write(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  let drafts = read(files.drafts, {});
  let history = read(files.history, []);
  let settings = { ...DEFAULT_SETTINGS, ...read(files.settings, {}) };

  // Drafts that nobody confirmed are deleted after draftHours.
  function prune() {
    const cutoff = now() - draftHours * 3600 * 1000;
    let changed = false;
    for (const [id, d] of Object.entries(drafts)) {
      if (Date.parse(d.updatedAt || d.createdAt) < cutoff) { delete drafts[id]; changed = true; }
    }
    if (changed) write(files.drafts, drafts);
  }
  prune();

  const clone = (x) => (x ? JSON.parse(JSON.stringify(x)) : x);

  return {
    newId: () => crypto.randomBytes(9).toString('base64url'),
    listDrafts() { prune(); return Object.values(drafts).map(clone).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))); },
    getDraft(id) { prune(); return typeof id === 'string' && Object.hasOwn(drafts, id) ? clone(drafts[id]) : null; },
    saveDraft(d) { drafts[d.id] = clone(d); write(files.drafts, drafts); return clone(d); },
    deleteDraft(id) { if (Object.hasOwn(drafts, id)) { delete drafts[id]; write(files.drafts, drafts); } },
    addHistory(entry) {
      history.unshift(clone(entry));
      if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
      write(files.history, history);
    },
    listHistory({ user, limit = 100 } = {}) { return history.filter((h) => !user || h.dictatedBy?.user === user || h.confirmedBy?.user === user).slice(0, limit).map(clone); },
    getSettings: () => ({ ...settings }),
    saveSettings(s) { settings = { ...settings, ...s }; write(files.settings, settings); return { ...settings }; },
    prune,
  };
}

module.exports = { createStore };
