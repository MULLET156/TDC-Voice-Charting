'use strict';
// Copy this file into your module. It checks that a request really came
// through the TDC Dashboard (CONTRACT §3). Node.js built-ins only.
//
//   const { verifyTdcRequest } = require('./tdc-verify');
//   const who = verifyTdcRequest(process.env.MODULE_SECRET, req);
//   if (!who) { res.writeHead(401); res.end('Unauthorized'); return; }
//   // who = { user, name, roles: [...], base }
const crypto = require('node:crypto');

const MAX_SKEW_MS = 30 * 1000;

// Signature = hex HMAC-SHA256, keyed with the MODULE_SECRET text exactly as
// written in .env, over these six lines joined with "\n":
//   time, METHOD, pathAndQuery (req.url as the module receives it), user, roles, base
function tdcSignature(secret, time, method, pathAndQuery, user, roles, base) {
  const msg = [time, method.toUpperCase(), pathAndQuery, user, roles, base].join('\n');
  return crypto.createHmac('sha256', String(secret)).update(msg, 'utf8').digest('hex');
}

function verifyTdcRequest(secret, req, now = Date.now()) {
  if (!secret) return null;
  const h = req.headers;
  const time = h['x-tdc-time'];
  const sig = h['x-tdc-sig'];
  if (typeof time !== 'string' || !/^\d{1,16}$/.test(time)) return null;
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return null;
  if (Math.abs(now - Number(time)) > MAX_SKEW_MS) return null; // too old or from the future
  const user = h['x-tdc-user'] || '';
  const roles = h['x-tdc-roles'] || '';
  const base = h['x-tdc-base'] || '';
  const expected = tdcSignature(secret, time, req.method, req.url, user, roles, base);
  // Constant-time compare (both are 32 bytes once decoded from hex).
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  let name = h['x-tdc-name'] || user;
  if (name.includes('%')) { try { name = decodeURIComponent(name); } catch { /* keep as is */ } }
  return { user, name, roles: roles ? roles.split(',') : [], base };
}

// True if the user has at least one of the allowed roles.
function hasRole(who, allowed) {
  return !!who && who.roles.some((r) => allowed.includes(r));
}

module.exports = { verifyTdcRequest, tdcSignature, hasRole, MAX_SKEW_MS };
