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

    // Create totes table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS totes (
        id VARCHAR(255) PRIMARY KEY,
        water_weight INT UNSIGNED NOT NULL DEFAULT 0,
        ice_weight INT UNSIGNED NOT NULL DEFAULT 0,
        tote_weight INT UNSIGNED NOT NULL DEFAULT 0,
        raw_weight INT UNSIGNED NOT NULL DEFAULT 0,
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
