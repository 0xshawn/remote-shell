'use strict';

const crypto = require('crypto');

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// --- Minimal HMAC-signed token (a tiny JWT-like format), no external dependency. ---
function signPayload(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyPayload(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

// Constant-time string comparison that tolerates length differences.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba); // burn similar time, still return false
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function extractToken(req) {
  const header = req.headers['authorization'];
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  if (req.query && req.query.token) return String(req.query.token);
  return null;
}

function createAuth(authConfig) {
  const { enabled, username, password, tokenSecret } = authConfig;

  function checkCredentials(user, pass) {
    if (!enabled) return true;
    return safeEqual(user || '', username) && safeEqual(pass || '', password);
  }

  function issueToken(user) {
    return signPayload({ user, exp: Date.now() + TOKEN_TTL_MS }, tokenSecret);
  }

  function verifyToken(token) {
    if (!enabled) return { user: 'anonymous' };
    return verifyPayload(token, tokenSecret);
  }

  // Express middleware: protect an endpoint via Bearer token or ?token=.
  function requireAuth(req, res, next) {
    if (!enabled) {
      req.user = 'anonymous';
      return next();
    }
    const payload = verifyPayload(extractToken(req), tokenSecret);
    if (!payload) return res.status(401).json({ error: 'unauthorized' });
    req.user = payload.user;
    next();
  }

  return { enabled, checkCredentials, issueToken, verifyToken, requireAuth };
}

module.exports = { createAuth, extractToken };
