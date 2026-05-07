const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  application_name: 'control-plane',
});

pool.on('error', (err) => {
  console.error('[db] pool error', err.code || '', err.message);
});

module.exports = pool;
