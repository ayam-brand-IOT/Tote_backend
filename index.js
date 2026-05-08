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
      SELECT t.tote_id, t.status, t.tote_kg, t.ice_kg, t.water_kg, t.fish_kg, t.raw_kg,
        t.ice_out_kg, t.water_out_kg, t.temp_out,
        GROUP_CONCAT(CONCAT(l.line_id, ' | ', p.product, ' | ', p.type) SEPARATOR ', ') as linked_lines,
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
      { header: 'Tote ID',        key: 'tote_id',       width: 20 },
      { header: 'Status',         key: 'status',        width: 22 },
      { header: 'Tote (kg)',      key: 'tote_kg',       width: 12 },
      { header: 'Ice In (kg)',    key: 'ice_kg',        width: 12 },
      { header: 'Water In (kg)', key: 'water_kg',      width: 14 },
      { header: 'Fish (kg)',      key: 'fish_kg',       width: 12 },
      { header: 'Raw (kg)',       key: 'raw_kg',        width: 12 },
      { header: 'Ice Out (kg)',   key: 'ice_out_kg',    width: 13 },
      { header: 'Water Out (kg)',key: 'water_out_kg',  width: 15 },
      { header: 'Temp Out (°C)', key: 'temp_out',      width: 14 },
      { header: 'Linked Lines',  key: 'linked_lines',  width: 40 },
      { header: 'Created At',    key: 'created_at',    width: 22 },
      { header: 'Updated At',    key: 'updated_at',    width: 22 },
    ];
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 20;
    rows.forEach((tote, i) => {
      const row = sheet.addRow({
        tote_id: tote.tote_id, status: tote.status, tote_kg: tote.tote_kg, ice_kg: tote.ice_kg,
        water_kg: tote.water_kg, fish_kg: tote.fish_kg, raw_kg: tote.raw_kg, ice_out_kg: tote.ice_out_kg,
        water_out_kg: tote.water_out_kg, temp_out: tote.temp_out, linked_lines: tote.linked_lines || '',
        created_at: tote.created_at ? new Date(tote.created_at).toLocaleString('en-GB') : '',
        updated_at: tote.updated_at ? new Date(tote.updated_at).toLocaleString('en-GB') : '',
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
    const { product, type, size, comments } = req.body;
    if (!product || !type) return res.status(400).json({ error: 'product and type are required' });
    const [result] = await db.query(
      'INSERT INTO products (product, type, size, comments) VALUES (?, ?, ?, ?)',
      [product, type, size || null, comments || null]
    );
    res.status(201).json({ message: 'Product created successfully', product: { id: result.insertId, product, type, size, comments } });
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
    const { product, type, size, comments } = req.body;
    const [existing] = await db.query('SELECT * FROM products WHERE id = ?', [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Product not found' });
    const row = existing[0];
    await db.query(
      'UPDATE products SET product=?, type=?, size=?, comments=? WHERE id=?',
      [product ?? row.product, type ?? row.type, size ?? row.size, comments ?? row.comments, id]
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

app.post('/api/lines', async (req, res) => {
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

app.put('/api/lines/:id', async (req, res) => {
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

app.delete('/api/lines/:id', async (req, res) => {
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
    const { product_id, comments } = req.body;
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
      'INSERT INTO line_product (line_id, product_id, comments) VALUES (?, ?, ?)',
      [id, product_id, comments || null]
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
      SELECT lp.id, lp.product_id, lp.started_at, lp.ended_at, lp.comments as assignment_comments,
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

    await db.query(
      'INSERT INTO tote_line (tote_record_id, line_product_id, destination) VALUES (?, ?, ?)',
      [toteRecordId, activeAssignment.id, destination || null]
    );

    if (totes[0].status === 'inbound-ready') {
      await db.query("UPDATE totes SET status = 'product-linked' WHERE id = ?", [toteRecordId]);
    }

    res.status(201).json({
      message: 'Tote linked to line successfully',
      link: {
        tote_id,
        line_id,
        destination: destination || null,
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

app.listen(PORT, () => {
  console.log(`HTTP Server running on port ${PORT}`);
  console.log(`WebSocket Server running on port ${WS_PORT}`);
});

module.exports = app;
