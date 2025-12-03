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
    const { id, water_weight, ice_weight, tote_weight, raw_weight } = req.body;

    // Validate required fields
    if (!id) {
      return res.status(400).json({ error: 'ID is required' });
    }

    // Validate and convert weight values to unsigned integers
    const validateWeight = (value, name) => {
      if (value === undefined || value === null) return 0;
      const num = parseInt(value, 10);
      if (isNaN(num) || num < 0) {
        throw new Error(`${name} must be a non-negative integer`);
      }
      return num;
    };

    const validatedWeights = {
      water_weight: validateWeight(water_weight, 'water_weight'),
      ice_weight: validateWeight(ice_weight, 'ice_weight'),
      tote_weight: validateWeight(tote_weight, 'tote_weight'),
      raw_weight: validateWeight(raw_weight, 'raw_weight')
    };

    // Insert tote into database
    const [result] = await db.query(
      'INSERT INTO totes (id, water_weight, ice_weight, tote_weight, raw_weight) VALUES (?, ?, ?, ?, ?)',
      [id, validatedWeights.water_weight, validatedWeights.ice_weight, validatedWeights.tote_weight, validatedWeights.raw_weight]
    );

    res.status(201).json({
      message: 'Tote added successfully',
      tote: {
        id,
        water_weight: validatedWeights.water_weight,
        ice_weight: validatedWeights.ice_weight,
        tote_weight: validatedWeights.tote_weight,
        raw_weight: validatedWeights.raw_weight
      }
    });
  } catch (error) {
    console.error('Error adding tote:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Tote with this ID already exists' });
    }
    if (error.message && error.message.includes('must be a non-negative integer')) {
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
    const [rows] = await db.query('SELECT * FROM totes WHERE id = ?', [id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Tote not found' });
    }
    
    res.json({ tote: rows[0] });
  } catch (error) {
    console.error('Error retrieving tote:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

module.exports = app;
