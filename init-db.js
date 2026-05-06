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
    console.log('Totes table created');

    // Create lines table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`lines\` (
        line_id VARCHAR(255) PRIMARY KEY,
        product VARCHAR(255) NOT NULL,
        type VARCHAR(255) NOT NULL,
        size VARCHAR(255) NOT NULL,
        destination VARCHAR(255) NOT NULL,
        comments TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('Lines table created');

    // Create tote_line relation table (many-to-many)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS tote_line (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tote_record_id INT NOT NULL,
        line_id VARCHAR(255) NOT NULL,
        linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tote_record_id) REFERENCES totes(id) ON DELETE CASCADE,
        FOREIGN KEY (line_id) REFERENCES \`lines\`(line_id) ON DELETE CASCADE,
        UNIQUE KEY unique_tote_line (tote_record_id, line_id)
      )
    `);
    console.log('Tote_line relation table created');

    // // Insert dummy data for lines
    // await connection.query(`
    //   INSERT INTO \`lines\` (line_id, product, type, size, destination, comments) VALUES
    //   ('S001', 'Salmon', 'Fillet', 'Large', 'Japan', 'Premium quality salmon fillets'),
    //   ('S002', 'Tuna', 'Whole', 'Medium', 'USA', 'Fresh tuna for sushi grade'),
    //   ('S003', 'Cod', 'Steak', 'Small', 'Europe', 'Atlantic cod steaks'),
    //   ('S004', 'Halibut', 'Fillet', 'Large', 'Canada', 'Wild-caught halibut')
    // `);
    console.log('Dummy line data inserted');

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
