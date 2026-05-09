const fs = require('fs');
const path = require('path');
const pool = require('./db');

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows: applied } = await pool.query('SELECT filename FROM schema_migrations');
  const appliedSet = new Set(applied.map((r) => r.filename));

  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  let appliedCount = 0;
  let skippedCount = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`[migrate] skip ${file} (already applied)`);
      skippedCount++;
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`[migrate] applying ${file}`);
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await pool.query('COMMIT');
      appliedCount++;
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  }
  console.log(`[migrate] done — ${appliedCount} applied, ${skippedCount} skipped (${files.length} total)`);
}

module.exports = runMigrations;
