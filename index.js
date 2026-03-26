const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const WebSocket = require('ws');
const path = require('path');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 3001;

// Trust proxy for nginx
app.set('trust proxy', 1);

// Middleware to parse JSON
app.use(express.json());

// Rate limiting configuration
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to all routes
app.use(limiter);

// ========== Shared WebSocket state (used by REST endpoints too) ==========
const esp32Clients = new Set();
const browserClients = new Set();

function broadcastToBrowsers(payload) {
  const msg = JSON.stringify(payload);
  browserClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// API routes first
// POST endpoint to add a tote
app.post('/api/totes', async (req, res) => {
  try {
    const { 
      tote_id, 
      tote_kg, 
      water_kg, 
      ice_kg, 
      fish_kg, 
      raw_kg, 
      ice_out_kg, 
      water_out_kg, 
      temp_out 
    } = req.body;

    // Validate required fields
    if (!tote_id) {
      return res.status(400).json({ error: 'tote_id is required' });
    }

    // Validate and convert weight values to unsigned integers
    const validateWeight = (value, name, allowNull = false) => {
      if (allowNull && (value === undefined || value === null)) return null;
      if (value === undefined || value === null) return 0;
      const num = parseInt(value, 10);
      if (isNaN(num) || num < 0) {
        throw new Error(`${name} must be a non-negative integer`);
      }
      return num;
    };

    // Validate temperature (can be decimal)
    const validateTemp = (value, name, allowNull = false) => {
      if (allowNull && (value === undefined || value === null)) return null;
      if (value === undefined || value === null) return 0;
      const num = parseFloat(value);
      if (isNaN(num)) {
        throw new Error(`${name} must be a valid number`);
      }
      return num;
    };

    const validatedData = {
      tote_kg: validateWeight(tote_kg, 'tote_kg'),
      water_kg: validateWeight(water_kg, 'water_kg'),
      ice_kg: validateWeight(ice_kg, 'ice_kg'),
      fish_kg: validateWeight(fish_kg, 'fish_kg', true),
      raw_kg: validateWeight(raw_kg, 'raw_kg'),
      ice_out_kg: validateWeight(ice_out_kg, 'ice_out_kg', true),
      water_out_kg: validateWeight(water_out_kg, 'water_out_kg'),
      temp_out: validateTemp(temp_out, 'temp_out', true)
    };

    // Insert tote into database
    const [result] = await db.query(
      'INSERT INTO totes (tote_id, tote_kg, water_kg, ice_kg, fish_kg, raw_kg, ice_out_kg, water_out_kg, temp_out, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        tote_id, 
        validatedData.tote_kg, 
        validatedData.water_kg, 
        validatedData.ice_kg, 
        validatedData.fish_kg,
        validatedData.raw_kg, 
        validatedData.ice_out_kg, 
        validatedData.water_out_kg, 
        validatedData.temp_out,
        'inbound-ready'
      ]
    );

    // Notify all browser clients so history panels update immediately
    broadcastToBrowsers({
      type: 'tote_created',
      station: 'inbound',
      toteId: tote_id,
      tote_kg: validatedData.tote_kg,
      ice_kg: validatedData.ice_kg,
      water_kg: validatedData.water_kg
    });

    res.status(201).json({
      message: 'Tote added successfully',
      tote: {
        id: result.insertId,
        tote_id,
        ...validatedData
      }
    });
  } catch (error) {
    console.error('Error adding tote:', error);
    if (error.message && (error.message.includes('must be a non-negative integer') || error.message.includes('must be a valid number'))) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET endpoint to retrieve all totes
app.get('/api/totes', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        t.*,
        GROUP_CONCAT(
          CONCAT(l.line_id, '|', l.product, '|', l.type) 
          SEPARATOR ';;'
        ) as linked_lines
      FROM totes t
      LEFT JOIN tote_line tl ON t.id = tl.tote_record_id
      LEFT JOIN \`lines\` l ON tl.line_id = l.line_id
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `);
    
    // Parse linked_lines string into array
    const totes = rows.map(tote => ({
      ...tote,
      linked_lines: tote.linked_lines 
        ? tote.linked_lines.split(';;').map(line => {
            const [line_id, product, type] = line.split('|');
            return { line_id, product, type };
          })
        : []
    }));
    
    res.json({ totes });
  } catch (error) {
    console.error('Error retrieving totes:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET endpoint to export totes to Excel
// Query params: from (ISO date), to (ISO date), status
app.get('/api/totes/export', async (req, res) => {
  try {
    const { from, to, status } = req.query;

    let whereClause = '1=1';
    const params = [];

    if (from) {
      whereClause += ' AND t.created_at >= ?';
      params.push(new Date(from));
    }
    if (to) {
      whereClause += ' AND t.created_at <= ?';
      // Set to end of the selected day
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      params.push(toDate);
    }
    if (status) {
      whereClause += ' AND t.status = ?';
      params.push(status);
    }

    const [rows] = await db.query(`
      SELECT
        t.tote_id,
        t.status,
        t.tote_kg,
        t.ice_kg,
        t.water_kg,
        t.fish_kg,
        t.raw_kg,
        t.ice_out_kg,
        t.water_out_kg,
        t.temp_out,
        GROUP_CONCAT(
          CONCAT(l.line_id, ' | ', l.product, ' | ', l.type)
          SEPARATOR ', '
        ) as linked_lines,
        t.created_at,
        t.updated_at
      FROM totes t
      LEFT JOIN tote_line tl ON t.id = tl.tote_record_id
      LEFT JOIN \`lines\` l ON tl.line_id = l.line_id
      WHERE ${whereClause}
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `, params);

    // Build Excel workbook
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Tote System';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Totes', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });

    sheet.columns = [
      { header: 'Tote ID',           key: 'tote_id',       width: 20 },
      { header: 'Status',            key: 'status',        width: 22 },
      { header: 'Tote (kg)',         key: 'tote_kg',       width: 12 },
      { header: 'Ice In (kg)',       key: 'ice_kg',        width: 12 },
      { header: 'Water In (kg)',     key: 'water_kg',      width: 14 },
      { header: 'Fish (kg)',         key: 'fish_kg',       width: 12 },
      { header: 'Raw (kg)',          key: 'raw_kg',        width: 12 },
      { header: 'Ice Out (kg)',      key: 'ice_out_kg',    width: 13 },
      { header: 'Water Out (kg)',    key: 'water_out_kg',  width: 15 },
      { header: 'Temp Out (°C)',     key: 'temp_out',      width: 14 },
      { header: 'Linked Lines',      key: 'linked_lines',  width: 40 },
      { header: 'Created At',        key: 'created_at',    width: 22 },
      { header: 'Updated At',        key: 'updated_at',    width: 22 },
    ];

    // Style header row
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 20;

    // Add data rows
    rows.forEach((tote, i) => {
      const row = sheet.addRow({
        tote_id:      tote.tote_id,
        status:       tote.status,
        tote_kg:      tote.tote_kg,
        ice_kg:       tote.ice_kg,
        water_kg:     tote.water_kg,
        fish_kg:      tote.fish_kg,
        raw_kg:       tote.raw_kg,
        ice_out_kg:   tote.ice_out_kg,
        water_out_kg: tote.water_out_kg,
        temp_out:     tote.temp_out,
        linked_lines: tote.linked_lines || '',
        created_at:   tote.created_at ? new Date(tote.created_at).toLocaleString('en-GB') : '',
        updated_at:   tote.updated_at ? new Date(tote.updated_at).toLocaleString('en-GB') : '',
      });
      // Alternate row background
      if (i % 2 === 1) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
      }
    });

    // Auto-filter on header
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheet.columns.length }
    };

    // Build filename with date range
    const now = new Date();
    const dateSuffix = now.toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `totes_export_${dateSuffix}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error exporting totes to Excel:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET endpoint to retrieve a specific tote by ID
app.get('/api/totes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Search for the most recent active tote with this tote_id, including linked line info
    const [rows] = await db.query(
      `SELECT t.*, 
              GROUP_CONCAT(CONCAT(l.line_id, '|', l.product, '|', l.type, '|', IFNULL(l.destination, ''), '|', IFNULL(l.comments, '')) SEPARATOR ';;') as linked_lines
       FROM totes t
       LEFT JOIN tote_line tl ON t.id = tl.tote_record_id
       LEFT JOIN \`lines\` l ON tl.line_id = l.line_id
       WHERE t.tote_id = ? AND t.status != 'offloaded-to-clean'
       GROUP BY t.id
       ORDER BY t.created_at DESC 
       LIMIT 1`, 
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Active tote not found' });
    }
    
    const tote = rows[0];
    
    // Parse linked lines
    tote.linked_lines = tote.linked_lines 
      ? tote.linked_lines.split(';;').map(line => {
          const [line_id, product, type, destination, comments] = line.split('|');
          return { line_id, product, type, destination, comments };
        })
      : [];
    
    res.json({ tote });
  } catch (error) {
    console.error('Error retrieving tote:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT endpoint to update a tote
app.put('/api/totes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { fish_kg, ice_out_kg, water_out_kg, temp_out } = req.body;

    // Check if current tote exists with this tote_id
    const [existing] = await db.query(
      "SELECT * FROM totes WHERE tote_id = ? AND status != 'offloaded-to-clean' ORDER BY created_at DESC LIMIT 1", 
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Active tote not found' });
    }

    const recordId = existing[0].id;

    // Validate fields (all optional)
    const validateWeight = (value, name) => {
      if (value === undefined || value === null) return undefined;
      const num = parseInt(value, 10);
      if (isNaN(num) || num < 0) {
        throw new Error(`${name} must be a non-negative integer`);
      }
      return num;
    };

    const validateTemp = (value, name) => {
      if (value === undefined || value === null) return undefined;
      const num = parseFloat(value);
      if (isNaN(num)) {
        throw new Error(`${name} must be a valid number`);
      }
      return num;
    };

    const updates = {};
    const validatedFishKg = validateWeight(fish_kg, 'fish_kg');
    const validatedIceOutKg = validateWeight(ice_out_kg, 'ice_out_kg');
    const validatedWaterOutKg = validateWeight(water_out_kg, 'water_out_kg');
    const validatedTempOut = validateTemp(temp_out, 'temp_out');

    if (validatedFishKg !== undefined) updates.fish_kg = validatedFishKg;
    if (validatedIceOutKg !== undefined) updates.ice_out_kg = validatedIceOutKg;
    if (validatedWaterOutKg !== undefined) updates.water_out_kg = validatedWaterOutKg;
    if (validatedTempOut !== undefined) updates.temp_out = validatedTempOut;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // If outbound fields are being set, advance status to outbound-ready
    const currentStatus = existing[0].status;
    const outboundFields = ['fish_kg', 'ice_out_kg', 'water_out_kg', 'temp_out'];
    const isOutboundUpdate = outboundFields.some(f => updates[f] !== undefined);
    const inProgressStatuses = ['inbound-ready', 'product-linked'];
    if (isOutboundUpdate && inProgressStatuses.includes(currentStatus)) {
      updates.status = 'outbound-ready';
    }

    // Build dynamic UPDATE query
    const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = [...Object.values(updates), recordId];

    await db.query(
      `UPDATE totes SET ${setClause} WHERE id = ?`,
      values
    );

    // Get updated tote
    const [updated] = await db.query('SELECT * FROM totes WHERE id = ?', [recordId]);

    // Notify all browser clients so outbound history updates immediately
    broadcastToBrowsers({
      type: 'tote_completed',
      station: 'outbound',
      toteId: id,
      fish_kg: updated[0].fish_kg,
      ice_out_kg: updated[0].ice_out_kg,
      water_out_kg: updated[0].water_out_kg,
      temp_out: updated[0].temp_out
    });

    res.json({
      message: 'Tote updated successfully',
      tote: updated[0]
    });
  } catch (error) {
    console.error('Error updating tote:', error);
    if (error.message && (error.message.includes('must be a non-negative integer') || error.message.includes('must be a valid number'))) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST endpoint to mark a tote as offloaded-to-clean (emptied and ready to be reused)
app.post('/api/totes/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Find current in-use tote with this tote_id
    const [existing] = await db.query(
      "SELECT * FROM totes WHERE tote_id = ? AND status != 'offloaded-to-clean' ORDER BY created_at DESC LIMIT 1",
      [id]
    );
    
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Active tote not found' });
    }
    
    // Mark as offloaded-to-clean
    await db.query(
      "UPDATE totes SET status = 'offloaded-to-clean' WHERE id = ?",
      [existing[0].id]
    );
    
    res.json({
      message: 'Tote marked as offloaded-to-clean',
      tote_id: id,
      record_id: existing[0].id
    });
  } catch (error) {
    console.error('Error completing tote:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH endpoint to manually transition a tote's status
const VALID_TOTE_STATUSES = [
  'empty',
  'inbound-ready',
  'product-linked',
  'outbound-ready',
  'in-transit',
  'received-for-packing',
  'offloaded-to-clean'
];

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

    if (!status) {
      return res.status(400).json({ error: 'status is required' });
    }
    if (!VALID_TOTE_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${VALID_TOTE_STATUSES.join(', ')}`
      });
    }

    // Find the most recent tote record for this tote_id
    const [existing] = await db.query(
      'SELECT * FROM totes WHERE tote_id = ? ORDER BY created_at DESC LIMIT 1',
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Tote not found' });
    }

    const currentStatus = existing[0].status;

    // Validate transition unless force=true
    if (!force) {
      const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
      if (!allowed.includes(status)) {
        return res.status(400).json({
          error: `Invalid transition: '${currentStatus}' → '${status}'`,
          current_status: currentStatus,
          allowed_next: allowed
        });
      }
    }

    await db.query(
      'UPDATE totes SET status = ? WHERE id = ?',
      [status, existing[0].id]
    );

    const [updated] = await db.query('SELECT * FROM totes WHERE id = ?', [existing[0].id]);

    res.json({
      message: `Tote status updated: '${currentStatus}' → '${status}'`,
      tote: updated[0]
    });
  } catch (error) {
    console.error('Error updating tote status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== LINE ENDPOINTS ==========

// POST endpoint to create a line
app.post('/api/lines', async (req, res) => {
  try {
    const { line_id, product, type, size, destination, comments } = req.body;

    if (!line_id || !product || !type) {
      return res.status(400).json({ error: 'line_id, product, and type are required' });
    }

    await db.query(
      'INSERT INTO `lines` (line_id, product, type, size, destination, comments) VALUES (?, ?, ?, ?, ?, ?)',
      [line_id, product, type, size || null, destination || null, comments || null]
    );

    res.status(201).json({
      message: 'Line created successfully',
      line: { line_id, product, type, size, destination, comments }
    });
  } catch (error) {
    console.error('Error creating line:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Line with this ID already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET endpoint to retrieve all lines
app.get('/api/lines', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM `lines` ORDER BY created_at DESC');
    res.json({ lines: rows });
  } catch (error) {
    console.error('Error retrieving lines:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET endpoint to retrieve a specific line by ID
app.get('/api/lines/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query('SELECT * FROM `lines` WHERE line_id = ?', [id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Line not found' });
    }
    
    res.json({ line: rows[0] });
  } catch (error) {
    console.error('Error retrieving line:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE endpoint to remove a line
app.delete('/api/lines/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if line exists
    const [existing] = await db.query('SELECT * FROM `lines` WHERE line_id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Line not found' });
    }

    // Check if line is linked to any totes
    const [linkedTotes] = await db.query('SELECT COUNT(*) as count FROM tote_line WHERE line_id = ?', [id]);
    if (linkedTotes[0].count > 0) {
      return res.status(409).json({ 
        error: 'Cannot delete line: it is linked to one or more totes',
        linked_totes: linkedTotes[0].count
      });
    }

    // Delete the line
    await db.query('DELETE FROM `lines` WHERE line_id = ?', [id]);
    
    res.json({ 
      message: 'Line deleted successfully',
      line_id: id
    });
  } catch (error) {
    console.error('Error deleting line:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== TOTE-LINE LINK ENDPOINTS ==========

// POST endpoint to link a tote with a line
app.post('/api/tote-line/link', async (req, res) => {
  try {
    const { tote_id, line_id } = req.body;

    if (!tote_id || !line_id) {
      return res.status(400).json({ error: 'tote_id and line_id are required' });
    }

    // Verify current tote exists and get its record id
    const [totes] = await db.query(
      "SELECT id, status FROM totes WHERE tote_id = ? AND status != 'offloaded-to-clean' ORDER BY created_at DESC LIMIT 1", 
      [tote_id]
    );
    if (totes.length === 0) {
      return res.status(404).json({ error: 'Active tote not found' });
    }
    const toteRecordId = totes[0].id;

    // Verify line exists
    const [lines] = await db.query('SELECT line_id FROM `lines` WHERE line_id = ?', [line_id]);
    if (lines.length === 0) {
      return res.status(404).json({ error: 'Line not found' });
    }

    // Create link using record id
    await db.query(
      'INSERT INTO tote_line (tote_record_id, line_id) VALUES (?, ?)',
      [toteRecordId, line_id]
    );

    // Advance status to product-linked if still at inbound-ready
    if (totes[0].status === 'inbound-ready') {
      await db.query(
        "UPDATE totes SET status = 'product-linked' WHERE id = ?",
        [toteRecordId]
      );
    }

    res.status(201).json({
      message: 'Tote linked to line successfully',
      link: { tote_id, line_id, tote_record_id: toteRecordId }
    });
  } catch (error) {
    console.error('Error linking tote to line:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'This tote is already linked to this line' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET endpoint to retrieve lines for a specific tote
app.get('/api/totes/:id/lines', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get current tote record id
    const [totes] = await db.query(
      "SELECT id FROM totes WHERE tote_id = ? AND status != 'offloaded-to-clean' ORDER BY created_at DESC LIMIT 1",
      [id]
    );
    if (totes.length === 0) {
      return res.status(404).json({ error: 'Active tote not found' });
    }
    
    const [rows] = await db.query(`
      SELECT l.*, tl.linked_at
      FROM \`lines\` l
      INNER JOIN tote_line tl ON l.line_id = tl.line_id
      WHERE tl.tote_record_id = ?
      ORDER BY tl.linked_at DESC
    `, [totes[0].id]);
    
    res.json({ lines: rows });
  } catch (error) {
    console.error('Error retrieving lines for tote:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET endpoint to retrieve totes for a specific line
app.get('/api/lines/:id/totes', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [rows] = await db.query(`
      SELECT t.*, tl.linked_at
      FROM totes t
      INNER JOIN tote_line tl ON t.id = tl.tote_record_id
      WHERE tl.line_id = ?
      ORDER BY tl.linked_at DESC
    `, [id]);
    
    res.json({ totes: rows });
  } catch (error) {
    console.error('Error retrieving totes for line:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve Vue.js app static files
app.use('/app', express.static(path.join(__dirname, 'public', 'app')));

// Serve other static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all route for Vue.js SPA - must handle any /app/... route
app.get(/^\/app(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app', 'index.html'));
});

// ========== WebSocket Server ==========
const wss = new WebSocket.Server({ port: WS_PORT });

let lastKnownData = {
  weight: 0,
  toteId: null,
  state: 'IDLE',
  timestamp: Date.now()
};

wss.on('connection', (ws, req) => {
  const clientType = req.url.includes('esp32') ? 'esp32' : 'browser';
  
  console.log(`[WebSocket] ${clientType} connected from ${req.socket.remoteAddress}`);
  
  if (clientType === 'esp32') {
    esp32Clients.add(ws);
    
    ws.isAlive = true;
    ws.station = null;  // Will be set from first message with station field
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    
  } else {
    browserClients.add(ws);
    
    const initialState = {
      type: 'initial_state',
      data: lastKnownData,
      esp32Connected: esp32Clients.size > 0
    };
    
    console.log('[WebSocket] Sending initial state to browser:', JSON.stringify(initialState));
    ws.send(JSON.stringify(initialState));
  }
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // DEBUG: Log ESP32 messages
      if (clientType === 'esp32') {
        console.log(`[WebSocket] ESP32 message:`, JSON.stringify(data));
        
        // Remember station for this ESP32 connection
        if (data.station) {
          ws.station = data.station;
        }
      }
      
      lastKnownData = {
        ...lastKnownData,
        ...data,
        timestamp: Date.now()
      };
      
      if (clientType === 'esp32') {
        // Use remembered station or from current message
        const station = data.station || ws.station || 'unknown';
        
        const payload = JSON.stringify({
          type: 'update',
          data: data,
          station: station,  // Propagate station identifier
          esp32Connected: true
        });
        
        console.log(`[WebSocket] Broadcasting to ${browserClients.size} browser(s):`, payload);
        
        browserClients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
          }
        });
      }
      
      if (clientType === 'browser' && data.type === 'command') {
        esp32Clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
          }
        });
      }
      
      // Reenviar mensajes de QR escaneado del browser al ESP32 correspondiente
      if (clientType === 'browser' && data.type === 'qr_scanned') {
        const qrMessage = JSON.stringify(data);
        const targetStation = data.station || 'all';
        console.log(`[WebSocket] Forwarding QR scanned to station "${targetStation}":`, qrMessage);
        console.log(`[WebSocket] Total ESP32 clients connected: ${esp32Clients.size}`);
        
        let sent = 0;
        esp32Clients.forEach(client => {
          console.log(`[WebSocket] Checking ESP32 - readyState: ${client.readyState}, station: ${client.station || 'none'}`);
          if (client.readyState === WebSocket.OPEN) {
            // Only send to ESP32 with matching station, or all if no station specified
            if (targetStation === 'all' || !client.station || client.station === targetStation) {
              client.send(qrMessage);
              sent++;
              console.log(`[WebSocket] ✓ QR sent to ESP32 station: ${client.station || 'unknown'}`);
            } else {
              console.log(`[WebSocket] ✗ Skipped ESP32 station: ${client.station} (target: ${targetStation})`);
            }
          }
        });
        console.log(`[WebSocket] QR message sent to ${sent} ESP32 client(s)`);
      }
      
    } catch (err) {
      console.error('[WebSocket] Error parsing message:', err);
    }
  });
  
  ws.on('close', () => {
    console.log(`[WebSocket] ${clientType} disconnected`);
    
    if (clientType === 'esp32') {
      esp32Clients.delete(ws);
      
      const payload = JSON.stringify({
        type: 'esp32_disconnected',
        esp32Connected: false
      });
      
      browserClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      });
    } else {
      browserClients.delete(ws);
    }
  });
  
  ws.on('error', (error) => {
    console.error(`[WebSocket] ${clientType} error:`, error);
  });
});

const heartbeatInterval = setInterval(() => {
  esp32Clients.forEach(ws => {
    if (!ws.isAlive) {
      console.log('[WebSocket] ESP32 heartbeat failed, terminating...');
      return ws.terminate();
    }
    
    ws.isAlive = false;
    ws.ping();
  });
}, 10000);  // Check every 10 seconds

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// Start the server
app.listen(PORT, () => {
  console.log(`HTTP Server running on port ${PORT}`);
  console.log(`WebSocket Server running on port ${WS_PORT}`);
  console.log(`Serving frontend from /public`);
});

module.exports = app;
