const express = require('express');
const pool = require('./db');

const router = express.Router();

router.get('/:id/logs', async (req, res) => {
  const { id } = req.params;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let sentChars = 0;
  let closed = false;
  req.on('close', () => { closed = true; });

  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  while (!closed) {
    let row;
    try {
      const { rows } = await pool.query(
        'SELECT status, build_log, error_message FROM deployments WHERE id=$1',
        [id]
      );
      row = rows[0];
    } catch (e) {
      send('error', { message: 'database error' });
      break;
    }

    if (!row) {
      send('error', { message: 'deployment not found' });
      break;
    }

    const log = row.build_log || '';
    if (log.length > sentChars) {
      send('log', { chunk: log.slice(sentChars) });
      sentChars = log.length;
    }

    if (row.status === 'success' || row.status === 'failed') {
      send('status', { status: row.status, error: row.error_message });
      break;
    }

    await new Promise((r) => setTimeout(r, 800));
  }

  res.end();
});

module.exports = router;
