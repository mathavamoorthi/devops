const express = require('express');
const pool = require('./db');
const runMigrations = require('./migrate');
const webhookRouter = require('./webhook');
const logsSseRouter = require('./logs-sse');

const app = express();

// request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

app.use(express.static('public'));

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'control-plane', db: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'unavailable' });
  }
});

// --- Projects CRUD ---

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

app.post('/projects', async (req, res) => {
  const { name, repo_url, subdomain } = req.body;
  if (!name || !repo_url || !subdomain) {
    return res.status(400).json({ error: 'name, repo_url, subdomain are required' });
  }
  if (!SUBDOMAIN_RE.test(subdomain)) {
    return res.status(400).json({ error: 'subdomain must be lowercase alphanumeric with hyphens (max 63 chars)' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO projects (name, repo_url, subdomain)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, repo_url, subdomain]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'name or subdomain already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/projects', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects ORDER BY id DESC');
  res.json(rows);
});

app.get('/projects/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

app.delete('/projects/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).send();
});

// --- Deployments (read-only for now) ---

app.get('/deployments', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.*, p.name AS project_name
     FROM deployments d
     JOIN projects p ON p.id = d.project_id
     ORDER BY d.id DESC
     LIMIT 50`
  );
  res.json(rows);
});

app.get('/projects/:id/deployments', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM deployments WHERE project_id = $1 ORDER BY id DESC',
    [req.params.id]
  );
  res.json(rows);
});

// --- Webhooks ---

app.use('/webhooks', webhookRouter);

// --- Test helper: skip-HMAC fake push (dev only) ---

app.post('/test/fake-push', async (req, res) => {
  const { repo_url, branch = 'main' } = req.body;
  if (!repo_url) return res.status(400).json({ error: 'repo_url required' });
  const { rows: projects } = await pool.query(
    'SELECT * FROM projects WHERE repo_url = $1',
    [repo_url]
  );
  if (projects.length === 0) {
    return res.status(404).json({ error: 'no project for that repo_url' });
  }
  const { rows } = await pool.query(
    `INSERT INTO deployments (project_id, commit_sha, commit_msg, branch, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING *`,
    [projects[0].id, 'dev-push-' + Date.now().toString(36), 'dashboard-triggered', branch]
  );
  res.status(202).json({ deployment: rows[0] });
});

// --- SSE log streaming ---

app.use('/deployments', logsSseRouter);

app.get('/version', (req, res) => {
  res.json({ version: '0.3.0-azure', host: process.env.HOSTNAME || 'unknown' });
});

// 404 catch-all for unmatched routes
app.use((req, res) => {
  res.status(404).json({ error: 'not found', path: req.path });
});

// --- Startup ---

const PORT = process.env.PORT || 3000;

async function start() {
  await runMigrations();
  app.listen(PORT, () => {
    console.log(`control-plane listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
