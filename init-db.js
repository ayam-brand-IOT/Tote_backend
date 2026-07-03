const mysql = require('mysql2/promise');

async function initializeDatabase() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || ''
  });

  try {
    await connection.query('CREATE DATABASE IF NOT EXISTS tote_db');
    await connection.query('USE tote_db');

    // Drop in reverse FK order so we can recreate cleanly
    await connection.query('DROP TABLE IF EXISTS tote_line');
    await connection.query('DROP TABLE IF EXISTS line_product');
    await connection.query('DROP TABLE IF EXISTS `lines`');
    await connection.query('DROP TABLE IF EXISTS products');
    await connection.query('DROP TABLE IF EXISTS totes');

    await connection.query(`
      CREATE TABLE totes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tote_id VARCHAR(255) NOT NULL,
        tote_kg INT UNSIGNED NOT NULL DEFAULT 0,
        water_kg INT UNSIGNED NOT NULL DEFAULT 0,
        ice_kg INT UNSIGNED NOT NULL DEFAULT 0,
        fish_kg INT UNSIGNED NULL,
        raw_kg INT UNSIGNED NOT NULL DEFAULT 0,
        ice_out_kg INT UNSIGNED NULL,
        water_out_kg INT UNSIGNED NOT NULL DEFAULT 0,
        temp_out DECIMAL(5,2) NULL,
        status ENUM(
          'empty',
          'inbound-ready',
          'product-linked',
          'outbound-ready',
          'in-transit',
          'received-for-packing',
          'offloaded-to-clean'
        ) NOT NULL DEFAULT 'empty',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_tote_id (tote_id),
        INDEX idx_status (status),
        INDEX idx_tote_status (tote_id, status)
      )
    `);
    console.log('totes table created');

    await connection.query(`
      CREATE TABLE products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product VARCHAR(255) NOT NULL,
        type VARCHAR(255) NOT NULL,
        size VARCHAR(255),
        origin VARCHAR(255),
        comments TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('products table created');

    // lines: pure identity of the physical production line, no product reference
    await connection.query(`
      CREATE TABLE \`lines\` (
        line_id VARCHAR(255) PRIMARY KEY,
        comments TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('lines table created');

    // Seed the default production lines (mirrors DEFAULT_LINES in the frontend constants)
    const defaultLines = ['Hybrid', 'Taichong', 'Mexican'];
    for (const lineId of defaultLines) {
      await connection.query('INSERT INTO `lines` (line_id) VALUES (?)', [lineId]);
    }
    console.log(`default lines seeded: ${defaultLines.join(', ')}`);

    // line_product: temporal assignment of a product to a line
    // ended_at NULL means this is the currently active assignment
    await connection.query(`
      CREATE TABLE line_product (
        id INT AUTO_INCREMENT PRIMARY KEY,
        line_id VARCHAR(255) NOT NULL,
        product_id INT NOT NULL,
        destination VARCHAR(255),
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP NULL DEFAULT NULL,
        comments TEXT,
        FOREIGN KEY (line_id) REFERENCES \`lines\`(line_id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
        INDEX idx_line_id (line_id),
        INDEX idx_product_id (product_id),
        INDEX idx_active (line_id, ended_at)
      )
    `);
    console.log('line_product table created');

    // tote_line: links a tote to the exact line_product context at processing time
    await connection.query(`
      CREATE TABLE tote_line (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tote_record_id INT NOT NULL,
        line_product_id INT NOT NULL,
        destination VARCHAR(255),
        linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tote_record_id) REFERENCES totes(id) ON DELETE CASCADE,
        FOREIGN KEY (line_product_id) REFERENCES line_product(id) ON DELETE CASCADE,
        UNIQUE KEY unique_tote_line_product (tote_record_id, line_product_id)
      )
    `);
    console.log('tote_line table created');

  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  } finally {
    await connection.end();
  }
}

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
