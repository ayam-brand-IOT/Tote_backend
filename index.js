require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const WebSocket = require('ws');
const path = require('path');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 3001;

app.set('trust proxy', 1);
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// ========== AUTH & ACCESS CONTROL ==========
const { requireAuth, requireManagement, verifyPassword, signToken, hashPassword, ensureUsers } = require('./auth');

const CONFIG_CATEGORIES = ['destination', 'fish_type', 'fish_size'];

// Public: login (must be declared BEFORE the /api auth gate below).
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
    const [rows] = await db.query('SELECT * FROM users WHERE username = ? LIMIT 1', [username]);
    const user = rows[0];
    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = signToken({ sub: user.id, username: user.username, role: user.role });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Everything else under /api requires a valid token. The web portal is the only
// REST consumer (ESP32 hardware uses the WebSocket, which is left open).
app.use('/api', requireAuth);

app.get('/api/auth/me', (req, res) => res.json({ user: req.user }));

// ========== USER MANAGEMENT (management only) ==========
app.get('/api/users', requireManagement, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, username, role, active, created_at, updated_at FROM users ORDER BY created_at ASC');
    res.json({ users: rows });
  } catch (error) {
    console.error('Error listing users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/users', requireManagement, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
    if (!['management', 'production'].includes(role)) return res.status(400).json({ error: 'role must be management or production' });
    if (String(password).length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
    await db.query('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      [username, hashPassword(password), role]);
    res.status(201).json({ message: 'User created', user: { username, role } });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username already exists' });
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/users/:id', requireManagement, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { role, active, password } = req.body;
    const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const target = rows[0];

    // Guard against locking out the last active management account.
    const demoting = role && role !== 'management' && target.role === 'management';
    const deactivating = active === 0 || active === false;
    if ((demoting || deactivating) && target.role === 'management' && target.active) {
      const [[{ count }]] = await db.query("SELECT COUNT(*) AS count FROM users WHERE role = 'management' AND active = 1");
      if (count <= 1) return res.status(409).json({ error: 'Cannot demote or deactivate the last active management user' });
    }

    const updates = {};
    if (role !== undefined) {
      if (!['management', 'production'].includes(role)) return res.status(400).json({ error: 'invalid role' });
      updates.role = role;
    }
    if (active !== undefined) updates.active = active ? 1 : 0;
    if (password) {
      if (String(password).length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
      updates.password_hash = hashPassword(password);
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });

    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await db.query(`UPDATE users SET ${setClause} WHERE id = ?`, [...Object.values(updates), id]);
    res.json({ message: 'User updated' });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/users/:id', requireManagement, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.user.id) return res.status(409).json({ error: 'You cannot delete your own account' });
    const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    if (rows[0].role === 'management' && rows[0].active) {
      const [[{ count }]] = await db.query("SELECT COUNT(*) AS count FROM users WHERE role = 'management' AND active = 1");
      if (count <= 1) return res.status(409).json({ error: 'Cannot delete the last active management user' });
    }
    await db.query('DELETE FROM users WHERE id = ?', [id]);
    res.json({ message: 'User deleted' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== CONFIG OPTIONS (controlled vocabularies) ==========
// Reads available to any authed user (feed dropdowns); writes management only.
app.get('/api/config/options', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, category, value, sort_order, active FROM config_options ORDER BY category, sort_order, value'
    );
    const grouped = { destination: [], fish_type: [], fish_size: [] };
    for (const r of rows) { if (grouped[r.category]) grouped[r.category].push(r); }
    res.json({ options: grouped });
  } catch (error) {
    console.error('Error listing config options:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/config/options', requireManagement, async (req, res) => {
  try {
    const { category, value } = req.body;
    if (!CONFIG_CATEGORIES.includes(category)) return res.status(400).json({ error: `category must be one of: ${CONFIG_CATEGORIES.join(', ')}` });
    if (!value || !String(value).trim()) return res.status(400).json({ error: 'value is required' });
    const [[{ maxOrder }]] = await db.query('SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM config_options WHERE category = ?', [category]);
    await db.query('INSERT INTO config_options (category, value, sort_order) VALUES (?, ?, ?)',
      [category, String(value).trim(), maxOrder + 1]);
    res.status(201).json({ message: 'Option added' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That value already exists in this category' });
    console.error('Error adding config option:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/config/options/:id', requireManagement, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { value, active, sort_order } = req.body;
    const [rows] = await db.query('SELECT * FROM config_options WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Option not found' });
    const updates = {};
    if (value !== undefined && String(value).trim()) updates.value = String(value).trim();
    if (active !== undefined) updates.active = active ? 1 : 0;
    if (sort_order !== undefined) updates.sort_order = parseInt(sort_order, 10) || 0;
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });
    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await db.query(`UPDATE config_options SET ${setClause} WHERE id = ?`, [...Object.values(updates), id]);
    res.json({ message: 'Option updated' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That value already exists in this category' });
    console.error('Error updating config option:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/config/options/:id', requireManagement, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [result] = await db.query('DELETE FROM config_options WHERE id = ?', [id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Option not found' });
    res.json({ message: 'Option deleted' });
  } catch (error) {
    console.error('Error deleting config option:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== Shared WebSocket state ==========
const esp32Clients = new Set();
const browserClients = new Set();

function broadcastToBrowsers(payload) {
  const msg = JSON.stringify(payload);
  browserClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// Helper: resolve active line_product for a line_id
async function getActiveLineProduct(lineId) {
  const [rows] = await db.query(
    'SELECT lp.*, p.product, p.type, p.size, p.comments as product_comments FROM line_product lp INNER JOIN products p ON lp.product_id = p.id WHERE lp.line_id = ? AND lp.ended_at IS NULL ORDER BY lp.started_at DESC LIMIT 1',
    [lineId]
  );
  return rows[0] || null;
}

// ========== TOTE ENDPOINTS ==========

app.post('/api/totes', async (req, res) => {
  try {
    const { tote_id, tote_kg, water_kg, ice_kg, fish_kg, raw_kg, ice_out_kg, water_out_kg, temp_out } = req.body;
    if (!tote_id) return res.status(400).json({ error: 'tote_id is required' });

    const validateWeight = (value, name, allowNull = false) => {
      if (allowNull && (value === undefined || value === null)) return null;
      if (value === undefined || value === null) return 0;
      const num = parseInt(value, 10);
      if (isNaN(num) || num < 0) throw new Error(`${name} must be a non-negative integer`);
      return num;
    };
    const validateTemp = (value, name, allowNull = false) => {
      if (allowNull && (value === undefined || value === null)) return null;
      if (value === undefined || value === null) return 0;
      const num = parseFloat(value);
      if (isNaN(num)) throw new Error(`${name} must be a valid number`);
      return num;
    };

    const v = {
      tote_kg:      validateWeight(tote_kg, 'tote_kg'),
      water_kg:     validateWeight(water_kg, 'water_kg'),
      ice_kg:       validateWeight(ice_kg, 'ice_kg'),
      fish_kg:      validateWeight(fish_kg, 'fish_kg', true),
      raw_kg:       validateWeight(raw_kg, 'raw_kg'),
      ice_out_kg:   validateWeight(ice_out_kg, 'ice_out_kg', true),
      water_out_kg: validateWeight(water_out_kg, 'water_out_kg'),
      temp_out:     validateTemp(temp_out, 'temp_out', true)
    };

    const [result] = await db.query(
      'INSERT INTO totes (tote_id, tote_kg, water_kg, ice_kg, fish_kg, raw_kg, ice_out_kg, water_out_kg, temp_out, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [tote_id, v.tote_kg, v.water_kg, v.ice_kg, v.fish_kg, v.raw_kg, v.ice_out_kg, v.water_out_kg, v.temp_out, 'inbound-ready']
    );

    broadcastToBrowsers({ type: 'tote_created', station: 'inbound', toteId: tote_id,
      tote_kg: v.tote_kg, ice_kg: v.ice_kg, water_kg: v.water_kg });

    res.status(201).json({ message: 'Tote added successfully', tote: { id: result.insertId, tote_id, ...v } });
  } catch (error) {
    console.error('Error adding tote:', error);
    if (error.message && (error.message.includes('must be a non-negative integer') || error.message.includes('must be a valid number')))
      return res.status(400).json({ error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Shared JOIN fragment for tote queries
const TOTE_LINES_JOIN = `
  LEFT JOIN tote_line tl ON t.id = tl.tote_record_id
  LEFT JOIN line_product lp ON tl.line_product_id = lp.id
  LEFT JOIN \`lines\` l ON lp.line_id = l.line_id
  LEFT JOIN products p ON lp.product_id = p.id
`;

app.get('/api/totes', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT t.*,
        GROUP_CONCAT(CONCAT(l.line_id, '|', p.product, '|', p.type, '|', IFNULL(tl.destination, '')) SEPARATOR ';;') as linked_lines
      FROM totes t ${TOTE_LINES_JOIN}
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `);
    const totes = rows.map(tote => ({
      ...tote,
      linked_lines: tote.linked_lines
        ? tote.linked_lines.split(';;').map(s => { const [line_id, product, type, destination] = s.split('|'); return { line_id, product, type, destination: destination || null }; })
        : []
    }));
    res.json({ totes });
  } catch (error) {
    console.error('Error retrieving totes:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/totes/export', async (req, res) => {
  try {
    const { from, to, status } = req.query;
    let whereClause = '1=1';
    const params = [];
    if (from) { whereClause += ' AND t.created_at >= ?'; params.push(new Date(from)); }
    if (to) {
      whereClause += ' AND t.created_at <= ?';
      const toDate = new Date(to); toDate.setHours(23, 59, 59, 999); params.push(toDate);
    }
    if (status) { whereClause += ' AND t.status = ?'; params.push(status); }

    const [rows] = await db.query(`
      SELECT t.id as trip_no, t.tote_id, t.status, t.tote_kg, t.ice_kg, t.water_kg, t.fish_kg, t.raw_kg,
        t.ice_out_kg, t.water_out_kg, t.temp_out,
        GROUP_CONCAT(DISTINCT l.line_id SEPARATOR ', ') as line_ids,
        GROUP_CONCAT(DISTINCT p.type SEPARATOR ', ') as fish_types,
        GROUP_CONCAT(DISTINCT p.size SEPARATOR ', ') as fish_sizes,
        GROUP_CONCAT(DISTINCT p.origin SEPARATOR ', ') as fish_origins,
        GROUP_CONCAT(DISTINCT tl.destination SEPARATOR ', ') as destinations,
        t.created_at, t.updated_at
      FROM totes t ${TOTE_LINES_JOIN}
      WHERE ${whereClause}
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `, params);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Tote System'; workbook.created = new Date();
    const sheet = workbook.addWorksheet('Totes', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'Prod Date',                     key: 'prod_date',      width: 14 },
      { header: 'Tote No.',                      key: 'tote_id',        width: 20 },
      { header: 'Fish Size',                     key: 'fish_sizes',     width: 16 },
      { header: 'Trip No.',                      key: 'trip_no',        width: 12 },
      { header: 'Fish Origin',                   key: 'fish_origins',   width: 18 },
      { header: 'Order No.',                     key: 'order_no',       width: 14 },
      { header: 'From CFPP Line',                key: 'line_ids',       width: 20 },
      { header: 'CF Time Tote Sent',             key: 'time_sent',      width: 20 },
      { header: 'Fish Type',                     key: 'fish_types',     width: 16 },
      { header: 'Transfer to Factory',           key: 'destinations',   width: 22 },
      { header: 'Weight Tote Ice Water (IN)',    key: 'weight_in',      width: 24 },
      { header: 'Total Weight (OUT)',            key: 'weight_out',     width: 18 },
      { header: 'Total Fish Weight(OUT)',        key: 'fish_out',       width: 20 },
    ];
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 20;
    const num = (v) => (v === null || v === undefined ? 0 : Number(v));
    rows.forEach((tote, i) => {
      // Weight Tote Ice Water (IN): empty tote + ice + water loaded at inbound (no fish)
      const weightIn = num(tote.tote_kg) + num(tote.ice_kg) + num(tote.water_kg);
      // Total Weight (OUT): gross weight leaving = tote + fish + residual ice/water measured at outbound
      const weightOut = num(tote.tote_kg) + num(tote.fish_kg) + num(tote.ice_out_kg) + num(tote.water_out_kg);
      const row = sheet.addRow({
        prod_date: tote.created_at ? new Date(tote.created_at).toLocaleDateString('en-GB') : '',
        tote_id: tote.tote_id,
        fish_sizes: tote.fish_sizes || '',
        trip_no: tote.trip_no,
        fish_origins: tote.fish_origins || '',
        order_no: '',
        line_ids: tote.line_ids || '',
        time_sent: tote.updated_at ? new Date(tote.updated_at).toLocaleString('en-GB') : '',
        fish_types: tote.fish_types || '',
        destinations: tote.destinations || '',
        weight_in: weightIn,
        weight_out: weightOut,
        fish_out: num(tote.fish_kg),
      });
      if (i % 2 === 1) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
    });
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };

    const filename = `totes_export_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error exporting totes to Excel:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/totes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query(`
      SELECT t.*,
        GROUP_CONCAT(
          CONCAT(l.line_id, '|', p.product, '|', p.type, '|', IFNULL(tl.destination, ''), '|', IFNULL(l.comments, ''))
          SEPARATOR ';;'
        ) as linked_lines
      FROM totes t ${TOTE_LINES_JOIN}
      WHERE t.tote_id = ? AND t.status != 'offloaded-to-clean'
      GROUP BY t.id
      ORDER BY t.created_at DESC
      LIMIT 1
    `, [id]);

    if (rows.length === 0) return res.status(404).json({ error: 'Active tote not found' });
    const tote = rows[0];
    tote.linked_lines = tote.linked_lines
      ? tote.linked_lines.split(';;').map(s => {
          const [line_id, product, type, destination, comments] = s.split('|');
          return { line_id, product, type, destination, comments };
        })
      : [];
    res.json({ tote });
  } catch (error) {
    console.error('Error retrieving tote:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/totes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { fish_kg, raw_kg, ice_out_kg, water_out_kg, temp_out, tote_kg, ice_kg, water_kg } = req.body;

    const [existing] = await db.query(
      "SELECT * FROM totes WHERE tote_id = ? AND status != 'offloaded-to-clean' ORDER BY created_at DESC LIMIT 1", [id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Active tote not found' });
    const recordId = existing[0].id;

    const validateWeight = (value, name) => {
      if (value === undefined || value === null) return undefined;
      const num = parseInt(value, 10);
      if (isNaN(num) || num < 0) throw new Error(`${name} must be a non-negative integer`);
      return num;
    };
    const validateTemp = (value, name) => {
      if (value === undefined || value === null) return undefined;
      const num = parseFloat(value);
      if (isNaN(num)) throw new Error(`${name} must be a valid number`);
      return num;
    };

    const updates = {};
    const vFishKg     = validateWeight(fish_kg, 'fish_kg');
    const vRawKg      = validateWeight(raw_kg, 'raw_kg', true);
    const vIceOutKg   = validateWeight(ice_out_kg, 'ice_out_kg');
    const vWaterOutKg = validateWeight(water_out_kg, 'water_out_kg');
    const vTempOut    = validateTemp(temp_out, 'temp_out');

    if (vRawKg !== null && vRawKg !== undefined) {
      updates.raw_kg = vRawKg;
      updates.fish_kg = Math.max(0, Math.round(vRawKg - (existing[0].tote_kg || 0) - (existing[0].ice_kg || 0) - (existing[0].water_kg || 0)));
    } else if (vFishKg !== undefined) {
      updates.fish_kg = vFishKg;
    }
    if (vIceOutKg   !== undefined) updates.ice_out_kg   = vIceOutKg;
    if (vWaterOutKg !== undefined) updates.water_out_kg = vWaterOutKg;
    if (vTempOut    !== undefined) updates.temp_out     = vTempOut;

    const vToteKg  = validateWeight(tote_kg, 'tote_kg');
    const vIceKg   = validateWeight(ice_kg, 'ice_kg');
    const vWaterKg = validateWeight(water_kg, 'water_kg');
    if (vToteKg  !== undefined) updates.tote_kg  = vToteKg;
    if (vIceKg   !== undefined) updates.ice_kg   = vIceKg;
    if (vWaterKg !== undefined) updates.water_kg = vWaterKg;

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    const outboundFields = ['fish_kg', 'ice_out_kg', 'water_out_kg', 'temp_out'];
    if (outboundFields.some(f => updates[f] !== undefined) && ['inbound-ready', 'product-linked'].includes(existing[0].status)) {
      updates.status = 'outbound-ready';
    }

    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await db.query(`UPDATE totes SET ${setClause} WHERE id = ?`, [...Object.values(updates), recordId]);

    const [updated] = await db.query('SELECT * FROM totes WHERE id = ?', [recordId]);
    broadcastToBrowsers({ type: 'tote_completed', station: 'outbound', toteId: id,
      fish_kg: updated[0].fish_kg, raw_kg: updated[0].raw_kg,
      ice_out_kg: updated[0].ice_out_kg, water_out_kg: updated[0].water_out_kg, temp_out: updated[0].temp_out });

    res.json({ message: 'Tote updated successfully', tote: updated[0] });
  } catch (error) {
    console.error('Error updating tote:', error);
    if (error.message && (error.message.includes('must be a non-negative integer') || error.message.includes('must be a valid number')))
      return res.status(400).json({ error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/totes/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const [existing] = await db.query(
      "SELECT * FROM totes WHERE tote_id = ? AND status != 'offloaded-to-clean' ORDER BY created_at DESC LIMIT 1", [id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Active tote not found' });
    await db.query("UPDATE totes SET status = 'offloaded-to-clean' WHERE id = ?", [existing[0].id]);
    res.json({ message: 'Tote marked as offloaded-to-clean', tote_id: id, record_id: existing[0].id });
  } catch (error) {
    console.error('Error completing tote:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const VALID_TOTE_STATUSES = ['empty','inbound-ready','product-linked','outbound-ready','in-transit','received-for-packing','offloaded-to-clean'];
const ALLOWED_TRANSITIONS = {
  'empty':                ['inbound-ready'],
  'inbound-ready':        ['product-linked', 'outbound-ready'],
  'product-linked':       ['outbound-ready'],
  'outbound-ready':       ['in-transit'],
  'in-transit':           ['received-for-packing'],
  'received-for-packing': ['offloaded-to-clean'],
  'offloaded-to-clean':   []
};

app.patch('/api/totes/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, force } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required' });
    if (!VALID_TOTE_STATUSES.includes(status))
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_TOTE_STATUSES.join(', ')}` });

    const [existing] = await db.query('SELECT * FROM totes WHERE tote_id = ? ORDER BY created_at DESC LIMIT 1', [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Tote not found' });

    const currentStatus = existing[0].status;
    if (!force) {
      const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
      if (!allowed.includes(status))
        return res.status(400).json({ error: `Invalid transition: '${currentStatus}' → '${status}'`, current_status: currentStatus, allowed_next: allowed });
    }

    await db.query('UPDATE totes SET status = ? WHERE id = ?', [status, existing[0].id]);
    const [updated] = await db.query('SELECT * FROM totes WHERE id = ?', [existing[0].id]);
    res.json({ message: `Tote status updated: '${currentStatus}' → '${status}'`, tote: updated[0] });
  } catch (error) {
    console.error('Error updating tote status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== PRODUCT ENDPOINTS ==========

app.post('/api/products', async (req, res) => {
  try {
    const { product, type, size, origin, comments } = req.body;
    if (!product || !type) return res.status(400).json({ error: 'product and type are required' });
    const [result] = await db.query(
      'INSERT INTO products (product, type, size, origin, comments) VALUES (?, ?, ?, ?, ?)',
      [product, type, size || null, origin || null, comments || null]
    );
    res.status(201).json({ message: 'Product created successfully', product: { id: result.insertId, product, type, size, origin, comments } });
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM products ORDER BY created_at DESC');
    res.json({ products: rows });
  } catch (error) {
    console.error('Error retrieving products:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json({ product: rows[0] });
  } catch (error) {
    console.error('Error retrieving product:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { product, type, size, origin, comments } = req.body;
    const [existing] = await db.query('SELECT * FROM products WHERE id = ?', [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Product not found' });
    const row = existing[0];
    await db.query(
      'UPDATE products SET product=?, type=?, size=?, origin=?, comments=? WHERE id=?',
      [product ?? row.product, type ?? row.type, size ?? row.size, origin ?? row.origin, comments ?? row.comments, id]
    );
    const [updated] = await db.query('SELECT * FROM products WHERE id = ?', [id]);
    res.json({ message: 'Product updated successfully', product: updated[0] });
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [existing] = await db.query('SELECT * FROM products WHERE id = ?', [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Product not found' });
    const [used] = await db.query('SELECT COUNT(*) as count FROM line_product WHERE product_id = ?', [id]);
    if (used[0].count > 0)
      return res.status(409).json({ error: 'Cannot delete product: it has been assigned to one or more lines', assignments_count: used[0].count });
    await db.query('DELETE FROM products WHERE id = ?', [id]);
    res.json({ message: 'Product deleted successfully', id });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== LINE ENDPOINTS ==========

app.post('/api/lines', requireManagement, async (req, res) => {
  try {
    const { line_id, comments } = req.body;
    if (!line_id) return res.status(400).json({ error: 'line_id is required' });
    await db.query('INSERT INTO `lines` (line_id, comments) VALUES (?, ?)', [line_id, comments || null]);
    res.status(201).json({ message: 'Line created successfully', line: { line_id, comments } });
  } catch (error) {
    console.error('Error creating line:', error);
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Line with this ID already exists' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET all lines with their current active product (if any)
app.get('/api/lines', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT l.line_id, l.comments, l.created_at, l.updated_at,
             lp.id as line_product_id, lp.product_id, lp.started_at, lp.comments as assignment_comments,
             lp.destination,
             p.product, p.type, p.size
      FROM \`lines\` l
      LEFT JOIN line_product lp ON l.line_id = lp.line_id AND lp.ended_at IS NULL
      LEFT JOIN products p ON lp.product_id = p.id
      ORDER BY l.created_at DESC
    `);
    res.json({ lines: rows });
  } catch (error) {
    console.error('Error retrieving lines:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET single line with active product
app.get('/api/lines/:id', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT l.line_id, l.comments, l.created_at, l.updated_at,
             lp.id as line_product_id, lp.product_id, lp.started_at, lp.comments as assignment_comments,
             lp.destination,
             p.product, p.type, p.size, p.comments as product_comments
      FROM \`lines\` l
      LEFT JOIN line_product lp ON l.line_id = lp.line_id AND lp.ended_at IS NULL
      LEFT JOIN products p ON lp.product_id = p.id
      WHERE l.line_id = ?
    `, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Line not found' });
    res.json({ line: rows[0] });
  } catch (error) {
    console.error('Error retrieving line:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/lines/:id', requireManagement, async (req, res) => {
  try {
    const { id } = req.params;
    const { comments } = req.body;
    const [existing] = await db.query('SELECT * FROM `lines` WHERE line_id = ?', [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Line not found' });
    await db.query('UPDATE `lines` SET comments=? WHERE line_id=?', [
      comments !== undefined ? comments : existing[0].comments,
      id
    ]);
    const [updated] = await db.query('SELECT * FROM `lines` WHERE line_id = ?', [id]);
    res.json({ message: 'Line updated successfully', line: updated[0] });
  } catch (error) {
    console.error('Error updating line:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/lines/:id', requireManagement, async (req, res) => {
  try {
    const { id } = req.params;
    const [existing] = await db.query('SELECT * FROM `lines` WHERE line_id = ?', [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Line not found' });
    // Check for tote_line records via line_product
    const [linkedTotes] = await db.query(
      'SELECT COUNT(*) as count FROM tote_line tl INNER JOIN line_product lp ON tl.line_product_id = lp.id WHERE lp.line_id = ?', [id]
    );
    if (linkedTotes[0].count > 0)
      return res.status(409).json({ error: 'Cannot delete line: it is linked to one or more totes', linked_totes: linkedTotes[0].count });
    await db.query('DELETE FROM `lines` WHERE line_id = ?', [id]);
    res.json({ message: 'Line deleted successfully', line_id: id });
  } catch (error) {
    console.error('Error deleting line:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== LINE-PRODUCT ASSIGNMENT ENDPOINTS ==========

// Assign a product to a line (ends any active assignment first)
app.post('/api/lines/:id/assign', async (req, res) => {
  try {
    const { id } = req.params;
    const { product_id, destination, comments } = req.body;
    if (!product_id) return res.status(400).json({ error: 'product_id is required' });

    const [line] = await db.query('SELECT line_id FROM `lines` WHERE line_id = ?', [id]);
    if (line.length === 0) return res.status(404).json({ error: 'Line not found' });

    const [prod] = await db.query('SELECT id FROM products WHERE id = ?', [product_id]);
    if (prod.length === 0) return res.status(404).json({ error: 'Product not found' });

    // End current active assignment if any
    await db.query(
      'UPDATE line_product SET ended_at = NOW() WHERE line_id = ? AND ended_at IS NULL',
      [id]
    );

    // Create new assignment
    const [result] = await db.query(
      'INSERT INTO line_product (line_id, product_id, destination, comments) VALUES (?, ?, ?, ?)',
      [id, product_id, destination || null, comments || null]
    );

    const [created] = await db.query(`
      SELECT lp.*, p.product, p.type, p.size
      FROM line_product lp INNER JOIN products p ON lp.product_id = p.id
      WHERE lp.id = ?
    `, [result.insertId]);

    res.status(201).json({ message: 'Product assigned to line successfully', assignment: created[0] });
  } catch (error) {
    console.error('Error assigning product to line:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// End the active assignment for a line
app.post('/api/lines/:id/unassign', async (req, res) => {
  try {
    const { id } = req.params;
    const [active] = await db.query('SELECT id FROM line_product WHERE line_id = ? AND ended_at IS NULL', [id]);
    if (active.length === 0) return res.status(404).json({ error: 'No active assignment found for this line' });
    await db.query('UPDATE line_product SET ended_at = NOW() WHERE line_id = ? AND ended_at IS NULL', [id]);
    res.json({ message: 'Assignment ended successfully', line_id: id });
  } catch (error) {
    console.error('Error ending assignment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get full assignment history for a line
app.get('/api/lines/:id/assignments', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT lp.id, lp.product_id, lp.destination, lp.started_at, lp.ended_at, lp.comments as assignment_comments,
             p.product, p.type, p.size
      FROM line_product lp
      INNER JOIN products p ON lp.product_id = p.id
      WHERE lp.line_id = ?
      ORDER BY lp.started_at DESC
    `, [req.params.id]);
    res.json({ assignments: rows });
  } catch (error) {
    console.error('Error retrieving assignments:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== TOTE-LINE LINK ENDPOINTS ==========

// Update destination of an existing tote-line record
app.patch('/api/tote-line/destination', async (req, res) => {
  try {
    const { tote_id, line_id, destination } = req.body;
    if (!tote_id || !line_id) return res.status(400).json({ error: 'tote_id and line_id are required' });

    const [totes] = await db.query(
      "SELECT id FROM totes WHERE tote_id = ? AND status != 'offloaded-to-clean' ORDER BY created_at DESC LIMIT 1",
      [tote_id]
    );
    if (!totes.length) return res.status(404).json({ error: 'Active tote not found' });

    const [rows] = await db.query(`
      SELECT tl.id FROM tote_line tl
      INNER JOIN line_product lp ON tl.line_product_id = lp.id
      WHERE tl.tote_record_id = ? AND lp.line_id = ?
      ORDER BY tl.linked_at DESC LIMIT 1
    `, [totes[0].id, line_id]);

    if (!rows.length) return res.status(404).json({ error: 'No link found between this tote and line' });

    await db.query('UPDATE tote_line SET destination = ? WHERE id = ?', [destination || null, rows[0].id]);
    res.json({ message: 'Destination updated successfully', tote_id, line_id, destination: destination || null });
  } catch (error) {
    console.error('Error updating tote-line destination:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Link tote to a line — resolves the active line_product automatically
app.post('/api/tote-line/link', async (req, res) => {
  try {
    const { tote_id, line_id, destination } = req.body;
    if (!tote_id || !line_id) return res.status(400).json({ error: 'tote_id and line_id are required' });

    const [totes] = await db.query(
      "SELECT id, status FROM totes WHERE tote_id = ? AND status != 'offloaded-to-clean' ORDER BY created_at DESC LIMIT 1",
      [tote_id]
    );
    if (totes.length === 0) return res.status(404).json({ error: 'Active tote not found' });
    const toteRecordId = totes[0].id;

    const activeAssignment = await getActiveLineProduct(line_id);
    if (!activeAssignment) {
      return res.status(409).json({ error: 'Line has no active product assignment. Assign a product first.' });
    }

    const resolvedDestination = destination || activeAssignment.destination || null;

    await db.query(
      'INSERT INTO tote_line (tote_record_id, line_product_id, destination) VALUES (?, ?, ?)',
      [toteRecordId, activeAssignment.id, resolvedDestination]
    );

    if (totes[0].status === 'inbound-ready') {
      await db.query("UPDATE totes SET status = 'product-linked' WHERE id = ?", [toteRecordId]);
    }

    res.status(201).json({
      message: 'Tote linked to line successfully',
      link: {
        tote_id,
        line_id,
        destination: resolvedDestination,
        line_product_id: activeAssignment.id,
        product: activeAssignment.product,
        tote_record_id: toteRecordId
      }
    });
  } catch (error) {
    console.error('Error linking tote to line:', error);
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This tote is already linked to this line assignment' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/totes/:id/lines', async (req, res) => {
  try {
    const { id } = req.params;
    const [totes] = await db.query(
      "SELECT id FROM totes WHERE tote_id = ? AND status != 'offloaded-to-clean' ORDER BY created_at DESC LIMIT 1", [id]
    );
    if (totes.length === 0) return res.status(404).json({ error: 'Active tote not found' });

    const [rows] = await db.query(`
      SELECT l.line_id, l.comments,
             lp.id as line_product_id, lp.product_id, lp.started_at, lp.ended_at,
             lp.comments as assignment_comments, tl.linked_at, tl.destination,
             p.product, p.type, p.size
      FROM tote_line tl
      INNER JOIN line_product lp ON tl.line_product_id = lp.id
      INNER JOIN \`lines\` l ON lp.line_id = l.line_id
      INNER JOIN products p ON lp.product_id = p.id
      WHERE tl.tote_record_id = ?
      ORDER BY tl.linked_at DESC
    `, [totes[0].id]);
    res.json({ lines: rows });
  } catch (error) {
    console.error('Error retrieving lines for tote:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/lines/:id/totes', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT t.*, tl.linked_at, tl.destination, lp.id as line_product_id, lp.started_at as assignment_started_at
      FROM totes t
      INNER JOIN tote_line tl ON t.id = tl.tote_record_id
      INNER JOIN line_product lp ON tl.line_product_id = lp.id
      WHERE lp.line_id = ?
      ORDER BY tl.linked_at DESC
    `, [req.params.id]);
    res.json({ totes: rows });
  } catch (error) {
    console.error('Error retrieving totes for line:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== ANALYTICS / DASHBOARD ==========

// Resolve a range key into a [from, to) window plus bucketing strategy.
function resolveRange(rangeKey) {
  const now = new Date();
  const to = now;
  let from, bucket, format, prevFrom;

  if (rangeKey === '7d') {
    from = new Date(now); from.setDate(from.getDate() - 6); from.setHours(0, 0, 0, 0);
    prevFrom = new Date(from); prevFrom.setDate(prevFrom.getDate() - 7);
    bucket = 'day'; format = '%Y-%m-%d';
  } else if (rangeKey === '30d') {
    from = new Date(now); from.setDate(from.getDate() - 29); from.setHours(0, 0, 0, 0);
    prevFrom = new Date(from); prevFrom.setDate(prevFrom.getDate() - 30);
    bucket = 'day'; format = '%Y-%m-%d';
  } else { // 'today' (default)
    rangeKey = 'today';
    from = new Date(now); from.setHours(0, 0, 0, 0);
    prevFrom = new Date(from); prevFrom.setDate(prevFrom.getDate() - 1);
    bucket = 'hour'; format = '%Y-%m-%d %H:00';
  }
  return { rangeKey, from, to, prevFrom, prevTo: from, bucket, format };
}

// Build the ordered list of bucket keys spanning [from, to] so the timeseries
// includes empty buckets (a line that produced nothing this hour reads as 0).
function buildBuckets(from, to, bucket) {
  const keys = [];
  const cur = new Date(from);
  const p = (n) => String(n).padStart(2, '0');
  if (bucket === 'hour') {
    cur.setMinutes(0, 0, 0);
    while (cur <= to) {
      keys.push(`${cur.getFullYear()}-${p(cur.getMonth() + 1)}-${p(cur.getDate())} ${p(cur.getHours())}:00`);
      cur.setHours(cur.getHours() + 1);
    }
  } else {
    cur.setHours(0, 0, 0, 0);
    while (cur <= to) {
      keys.push(`${cur.getFullYear()}-${p(cur.getMonth() + 1)}-${p(cur.getDate())}`);
      cur.setDate(cur.getDate() + 1);
    }
  }
  return keys;
}

app.get('/api/analytics/dashboard', async (req, res) => {
  try {
    const { rangeKey, from, to, prevFrom, prevTo, bucket, format } = resolveRange(req.query.range);
    const fromStr = from, toStr = to;

    // Lines with their currently-active product assignment.
    const [lineRows] = await db.query(`
      SELECT l.line_id, l.comments,
             lp.id AS active_lp_id, lp.started_at AS active_since, lp.destination,
             p.product, p.type, p.size, p.origin
      FROM \`lines\` l
      LEFT JOIN line_product lp ON lp.line_id = l.line_id AND lp.ended_at IS NULL
      LEFT JOIN products p ON p.id = lp.product_id
      ORDER BY l.line_id
    `);

    // Per-line production metrics inside the window.
    const [metricRows] = await db.query(`
      SELECT lp.line_id,
             COUNT(DISTINCT t.id)        AS tote_count,
             COALESCE(SUM(t.fish_kg), 0) AS fish_kg,
             AVG(t.temp_out)            AS avg_temp,
             MAX(t.created_at)          AS last_activity
      FROM tote_line tl
      JOIN line_product lp ON lp.id = tl.line_product_id
      JOIN totes t ON t.id = tl.tote_record_id
      WHERE t.created_at >= ? AND t.created_at <= ?
      GROUP BY lp.line_id
    `, [fromStr, toStr]);
    const metricByLine = Object.fromEntries(metricRows.map(r => [r.line_id, r]));

    // Merge into per-line dashboard rows.
    const nowMs = Date.now();
    const lines = lineRows.map(l => {
      const m = metricByLine[l.line_id] || {};
      const lastMs = m.last_activity ? new Date(m.last_activity).getTime() : null;
      return {
        line_id: l.line_id,
        product: l.product || null,
        type: l.type || null,
        size: l.size || null,
        origin: l.origin || null,
        destination: l.destination || null,
        active_since: l.active_since || null,
        state: l.active_lp_id ? 'running' : 'idle',
        live: lastMs !== null && (nowMs - lastMs) < 2 * 3.6e6, // active in last 2h
        fish_kg: Number(m.fish_kg || 0),
        tote_count: Number(m.tote_count || 0),
        avg_temp: m.avg_temp != null ? +Number(m.avg_temp).toFixed(1) : null,
        last_activity: m.last_activity || null,
      };
    });

    // Timeseries: kg per line per bucket, pivoted with zero-filled buckets.
    const [tsRows] = await db.query(`
      SELECT lp.line_id,
             DATE_FORMAT(t.created_at, ?) AS bucket,
             COALESCE(SUM(t.fish_kg), 0)  AS fish_kg
      FROM tote_line tl
      JOIN line_product lp ON lp.id = tl.line_product_id
      JOIN totes t ON t.id = tl.tote_record_id
      WHERE t.created_at >= ? AND t.created_at <= ?
      GROUP BY lp.line_id, bucket
      ORDER BY bucket
    `, [format, fromStr, toStr]);

    const bucketKeys = buildBuckets(from, to, bucket);
    const bucketIndex = Object.fromEntries(bucketKeys.map((k, i) => [k, i]));
    const seriesByLine = {};
    for (const l of lineRows) seriesByLine[l.line_id] = new Array(bucketKeys.length).fill(0);
    for (const r of tsRows) {
      const idx = bucketIndex[r.bucket];
      if (idx !== undefined && seriesByLine[r.line_id]) seriesByLine[r.line_id][idx] = Number(r.fish_kg);
    }
    const timeseries = {
      bucket,
      categories: bucketKeys,
      series: Object.entries(seriesByLine).map(([name, data]) => ({ name, data })),
    };

    // Tote status distribution inside the window.
    const [statusRows] = await db.query(`
      SELECT t.status, COUNT(*) AS count
      FROM totes t
      WHERE t.created_at >= ? AND t.created_at <= ?
      GROUP BY t.status
      ORDER BY count DESC
    `, [fromStr, toStr]);
    const status_breakdown = statusRows.map(r => ({ status: r.status, count: Number(r.count) }));

    // Top products by processed weight.
    const [productRows] = await db.query(`
      SELECT p.product, p.type,
             COALESCE(SUM(t.fish_kg), 0) AS fish_kg,
             COUNT(DISTINCT t.id)        AS tote_count
      FROM tote_line tl
      JOIN line_product lp ON lp.id = tl.line_product_id
      JOIN products p ON p.id = lp.product_id
      JOIN totes t ON t.id = tl.tote_record_id
      WHERE t.created_at >= ? AND t.created_at <= ?
      GROUP BY p.id
      ORDER BY fish_kg DESC
      LIMIT 6
    `, [fromStr, toStr]);
    const top_products = productRows.map(r => ({
      product: r.product, type: r.type, fish_kg: Number(r.fish_kg), tote_count: Number(r.tote_count),
    }));

    // Summary + previous-period comparison for KPI deltas.
    const summaryQuery = `
      SELECT COUNT(DISTINCT t.id) AS total_totes,
             COALESCE(SUM(t.fish_kg), 0) AS total_fish_kg,
             AVG(t.temp_out) AS avg_temp
      FROM totes t
      WHERE t.created_at >= ? AND t.created_at <= ?
    `;
    const [[cur]] = await db.query(summaryQuery, [fromStr, toStr]);
    const [[prev]] = await db.query(summaryQuery, [prevFrom, prevTo]);

    const pctDelta = (a, b) => (b > 0 ? +(((a - b) / b) * 100).toFixed(1) : (a > 0 ? 100 : 0));
    const activeLines = lines.filter(l => l.state === 'running').length;

    const summary = {
      total_fish_kg: Number(cur.total_fish_kg || 0),
      total_totes: Number(cur.total_totes || 0),
      avg_temp: cur.avg_temp != null ? +Number(cur.avg_temp).toFixed(1) : null,
      active_lines: activeLines,
      total_lines: lines.length,
      fish_kg_delta_pct: pctDelta(Number(cur.total_fish_kg || 0), Number(prev.total_fish_kg || 0)),
      totes_delta_pct: pctDelta(Number(cur.total_totes || 0), Number(prev.total_totes || 0)),
    };

    res.json({
      range: rangeKey,
      from: from.toISOString(),
      to: to.toISOString(),
      generated_at: new Date().toISOString(),
      summary,
      lines,
      timeseries,
      status_breakdown,
      top_products,
    });
  } catch (error) {
    console.error('Error building dashboard analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== Static / SPA ==========

app.use('/app', express.static(path.join(__dirname, 'public', 'app')));
app.use(express.static(path.join(__dirname, 'public')));
app.get(/^\/app(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app', 'index.html'));
});

// ========== WebSocket Server ==========
const wss = new WebSocket.Server({ port: WS_PORT });
let lastKnownData = { weight: 0, toteId: null, state: 'IDLE', timestamp: Date.now() };

wss.on('connection', (ws, req) => {
  const clientType = req.url.includes('esp32') ? 'esp32' : 'browser';
  console.log(`[WebSocket] ${clientType} connected from ${req.socket.remoteAddress}`);

  if (clientType === 'esp32') {
    esp32Clients.add(ws);
    ws.isAlive = true; ws.station = null;
    ws.on('pong', () => { ws.isAlive = true; });
  } else {
    browserClients.add(ws);
    ws.send(JSON.stringify({ type: 'initial_state', data: lastKnownData, esp32Connected: esp32Clients.size > 0 }));
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (clientType === 'esp32') { console.log(`[WebSocket] ESP32 message:`, JSON.stringify(data)); if (data.station) ws.station = data.station; }
      lastKnownData = { ...lastKnownData, ...data, timestamp: Date.now() };

      if (clientType === 'esp32') {
        const station = data.station || ws.station || 'unknown';
        const payload = JSON.stringify({ type: 'update', data, station, esp32Connected: true });
        browserClients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(payload); });
      }
      if (clientType === 'browser' && data.type === 'command')
        esp32Clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data)); });

      if (clientType === 'browser' && data.type === 'qr_scanned') {
        const targetStation = data.station || 'all';
        esp32Clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && (targetStation === 'all' || !client.station || client.station === targetStation))
            client.send(JSON.stringify(data));
        });
      }
      if (clientType === 'browser' && (data.type === 'update_settings' || data.type === 'get_settings')) {
        const targetStation = data.station || 'all';
        esp32Clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && (targetStation === 'all' || !client.station || client.station === targetStation))
            client.send(JSON.stringify(data));
        });
      }
      if (clientType === 'esp32' && data.type === 'settings_current') {
        const payload = JSON.stringify({ type: 'settings_current', station: data.station || ws.station, ice_kg: data.ice_kg, water_kg: data.water_kg, min_w: data.min_w });
        browserClients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(payload); });
      }
    } catch (err) { console.error('[WebSocket] Error parsing message:', err); }
  });

  ws.on('close', () => {
    console.log(`[WebSocket] ${clientType} disconnected`);
    if (clientType === 'esp32') {
      esp32Clients.delete(ws);
      browserClients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'esp32_disconnected', esp32Connected: false })); });
    } else { browserClients.delete(ws); }
  });
  ws.on('error', (error) => { console.error(`[WebSocket] ${clientType} error:`, error); });
});

const heartbeatInterval = setInterval(() => {
  esp32Clients.forEach(ws => {
    if (!ws.isAlive) { console.log('[WebSocket] ESP32 heartbeat failed, terminating...'); return ws.terminate(); }
    ws.isAlive = false; ws.ping();
  });
}, 10000);
wss.on('close', () => clearInterval(heartbeatInterval));

// Idempotent schema migrations for already-initialized databases (init-db.js is destructive).
async function ensureSchema() {
  try {
    const [cols] = await db.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'origin'"
    );
    if (cols.length === 0) {
      await db.query('ALTER TABLE products ADD COLUMN origin VARCHAR(255) AFTER size');
      console.log("Migration: added 'origin' column to products");
    }

    // Auth: users table + default accounts.
    await ensureUsers();

    // Controlled vocabularies (destinations / fish types / sizes) managed in Config.
    await db.query(`
      CREATE TABLE IF NOT EXISTS config_options (
        id INT AUTO_INCREMENT PRIMARY KEY,
        category ENUM('destination','fish_type','fish_size') NOT NULL,
        value VARCHAR(255) NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_category_value (category, value)
      )
    `);
    const [[{ count }]] = await db.query('SELECT COUNT(*) AS count FROM config_options');
    if (count === 0) {
      const seed = {
        destination: ['F1', 'F2A', 'F2C', 'F2B'],
        fish_type: ['1 (HCT)', '2 (H&T)', '3 (WR)'],
        fish_size: ['Jitney', 'Buffet', 'Tower', 'Tall', 'Small Oval', 'Big Oval', 'CC', 'Fried Fish'],
      };
      for (const [category, values] of Object.entries(seed)) {
        for (let i = 0; i < values.length; i++) {
          await db.query('INSERT INTO config_options (category, value, sort_order) VALUES (?, ?, ?)', [category, values[i], i + 1]);
        }
      }
      console.log('Seeded default config options (destinations, fish types, sizes)');
    }
  } catch (error) {
    console.error('Schema migration failed:', error);
  }
}

app.listen(PORT, async () => {
  await ensureSchema();
  console.log(`HTTP Server running on port ${PORT}`);
  console.log(`WebSocket Server running on port ${WS_PORT}`);
});

module.exports = app;
