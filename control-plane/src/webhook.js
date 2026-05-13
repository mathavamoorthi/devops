const crypto = require('crypto');
const express = require('express');
const pool = require('./db');

const router = express.Router();

// Verify GitHub's HMAC-SHA256 signature on the raw request body.
// GitHub sends X-Hub-Signature-256: sha256=<hex> computed over the raw body
// using the shared webhook secret. timingSafeEqual prevents leaking bytes via
// comparison timing.
function verifySignature(req, secret) {
  const sig = req.header('X-Hub-Signature-256');
  if (!sig) return false;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(req.rawBody);
  const expected = 'sha256=' + hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

router.post('/github', async (req, res) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET || 'dev-secret';

  if (!verifySignature(req, secret)) {
    return res.status(401).json({ error: 'invalid signature' });
  }

  const event = req.header('X-GitHub-Event');
  if (event !== 'push') {
    return res.status(200).json({ status: 'ignored', reason: `event '${event}' not handled` });
  }

  const { repository, ref, head_commit } = req.body;
  if (!repository || !ref || !head_commit) {
    return res.status(400).json({ error: 'malformed payload' });
  }

  const repoUrl = repository.clone_url;
  const branch = ref.replace('refs/heads/', '');
  const commitSha = head_commit.id;
  const commitMsg = head_commit.message;

  const { rows: projects } = await pool.query(
    'SELECT * FROM projects WHERE repo_url = $1',
    [repoUrl]
  );
  if (projects.length === 0) {
    return res.status(404).json({ error: 'no project registered for this repo', repo_url: repoUrl });
  }
  const project = projects[0];

  const { rows } = await pool.query(
    `INSERT INTO deployments (project_id, commit_sha, commit_msg, branch, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING *`,
    [project.id, commitSha, commitMsg, branch]
  );

  console.log(`[webhook] queued deployment ${rows[0].id} for project ${project.name}`);
  console.log(`[webhook]   commit ${commitSha.slice(0, 8)} on ${branch}: ${commitMsg.split('\n')[0].slice(0, 60)}`);
  res.status(202).json({ deployment: rows[0] });
});

module.exports = router;
