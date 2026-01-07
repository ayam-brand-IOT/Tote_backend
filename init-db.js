const mysql = require('mysql2/promise');

async function initializeDatabase() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || ''
  });

  try {
    // Create database if it doesn't exist
    await connection.query('CREATE DATABASE IF NOT EXISTS tote_db');
    console.log('Database created or already exists');

    // Use the database
    await connection.query('USE tote_db');

    // Drop table if exists to ensure fresh schema
    await connection.query('DROP TABLE IF EXISTS totes');

    // Create totes table
    await connection.query(`
      CREATE TABLE totes (
        tote_id VARCHAR(255) PRIMARY KEY,
        tote_kg INT UNSIGNED NOT NULL DEFAULT 0,
        water_kg INT UNSIGNED NOT NULL DEFAULT 0,
        ice_kg INT UNSIGNED NOT NULL DEFAULT 0,
        fish_kg INT UNSIGNED NULL,
        raw_kg INT UNSIGNED NOT NULL DEFAULT 0,
        ice_out_kg INT UNSIGNED NULL,
        water_out_kg INT UNSIGNED NOT NULL DEFAULT 0,
        temp_out DECIMAL(5,2) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Totes table created or already exists');

  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  } finally {
    await connection.end();
  }
}

// Run initialization if this file is executed directly
if (require.main === module) {
  initializeDatabase()
    .then(() => {
      console.log('Database initialization completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Database initialization failed:', error);
      process.exit(1);
    });
}

module.exports = initializeDatabase;
