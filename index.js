const express = require('express');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON
app.use(express.json());

// POST endpoint to add a tote
app.post('/api/totes', async (req, res) => {
  try {
    const { id, water_weight, ice_weight, tote_weight, raw_weight } = req.body;

    // Validate required fields
    if (!id) {
      return res.status(400).json({ error: 'ID is required' });
    }

    // Insert tote into database
    const [result] = await db.query(
      'INSERT INTO totes (id, water_weight, ice_weight, tote_weight, raw_weight) VALUES (?, ?, ?, ?, ?)',
      [id, water_weight || 0, ice_weight || 0, tote_weight || 0, raw_weight || 0]
    );

    res.status(201).json({
      message: 'Tote added successfully',
      tote: {
        id,
        water_weight: water_weight || 0,
        ice_weight: ice_weight || 0,
        tote_weight: tote_weight || 0,
        raw_weight: raw_weight || 0
      }
    });
  } catch (error) {
    console.error('Error adding tote:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Tote with this ID already exists' });
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
