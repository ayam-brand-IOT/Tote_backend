const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON
app.use(express.json());

// Rate limiting configuration
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

// Apply rate limiting to all routes
app.use(limiter);

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
      'INSERT INTO totes (tote_id, tote_kg, water_kg, ice_kg, fish_kg, raw_kg, ice_out_kg, water_out_kg, temp_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        tote_id, 
        validatedData.tote_kg, 
        validatedData.water_kg, 
        validatedData.ice_kg, 
        validatedData.fish_kg,
        validatedData.raw_kg, 
        validatedData.ice_out_kg, 
        validatedData.water_out_kg, 
        validatedData.temp_out
      ]
    );

    res.status(201).json({
      message: 'Tote added successfully',
      tote: {
        tote_id,
        ...validatedData
      }
    });
  } catch (error) {
    console.error('Error adding tote:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Tote with this ID already exists' });
    }
    if (error.message && (error.message.includes('must be a non-negative integer') || error.message.includes('must be a valid number'))) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET endpoint to retrieve all totes
app.get('/api/totes', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM totes');
    res.json({ totes: rows });
  } catch (error) {
    console.error('Error retrieving totes:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET endpoint to retrieve a specific tote by ID
app.get('/api/totes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query('SELECT * FROM totes WHERE tote_id = ?', [id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Tote not found' });
    }
    
    res.json({ tote: rows[0] });
  } catch (error) {
    console.error('Error retrieving tote:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT endpoint to update a tote
app.put('/api/totes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { fish_kg, ice_out_kg, temp_out } = req.body;

    // Check if tote exists
    const [existing] = await db.query('SELECT * FROM totes WHERE tote_id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Tote not found' });
    }

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
    const validatedTempOut = validateTemp(temp_out, 'temp_out');

    if (validatedFishKg !== undefined) updates.fish_kg = validatedFishKg;
    if (validatedIceOutKg !== undefined) updates.ice_out_kg = validatedIceOutKg;
    if (validatedTempOut !== undefined) updates.temp_out = validatedTempOut;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Build dynamic UPDATE query
    const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = [...Object.values(updates), id];

    await db.query(
      `UPDATE totes SET ${setClause} WHERE tote_id = ?`,
      values
    );

    // Get updated tote
    const [updated] = await db.query('SELECT * FROM totes WHERE tote_id = ?', [id]);

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

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

module.exports = app;
