// Authentication utilities: password hashing (scrypt) and stateless tokens
// (HMAC-signed, JWT-like). Uses only Node's built-in crypto — no extra deps.

const crypto = require('crypto');
const db = require('./db');

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-tote-secret';
const TOKEN_TTL_SECONDS = parseInt(process.env.TOKEN_TTL || `${60 * 60 * 12}`, 10); // 12h

// ── Password hashing ───────────────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, derived] = stored.split(':');
  const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Tokens (base64url header.payload.signature) ────────────────────────────
function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlJson(obj) { return b64url(JSON.stringify(obj)); }
function sign(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signToken(payload) {
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const body = b64urlJson({ ...payload, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS });
  const data = `${header}.${body}`;
  return `${data}.${sign(data)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = sign(`${header}.${body}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_) { return null; }
}

// ── Express middleware ─────────────────────────────────────────────────────
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function requireAuth(req, res, next) {
  const payload = verifyToken(bearer(req));
  if (!payload) return res.status(401).json({ error: 'Authentication required' });
  req.user = { id: payload.sub, username: payload.username, role: payload.role };
  next();
}

function requireManagement(req, res, next) {
  if (!req.user || req.user.role !== 'management') {
    return res.status(403).json({ error: 'Management role required' });
  }
  next();
}

// ── Default seeding (idempotent) ───────────────────────────────────────────
// Creates the users table (if missing) and seeds one account per role so a
// fresh install is immediately usable. Management can then manage the rest.
async function ensureUsers() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(100) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('management','production') NOT NULL DEFAULT 'production',
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  const [[{ count }]] = await db.query('SELECT COUNT(*) AS count FROM users');
  if (count === 0) {
    const defaults = [
      ['manager', process.env.DEFAULT_MANAGER_PW || 'manager123', 'management'],
      ['operator', process.env.DEFAULT_OPERATOR_PW || 'operator123', 'production'],
    ];
    for (const [username, pw, role] of defaults) {
      await db.query('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
        [username, hashPassword(pw), role]);
    }
    console.log('Seeded default users: manager/manager123 (management), operator/operator123 (production) — change these!');
  }
}

module.exports = {
  hashPassword, verifyPassword, signToken, verifyToken,
  requireAuth, requireManagement, ensureUsers,
};
