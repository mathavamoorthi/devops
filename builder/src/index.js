const { Pool } = require('pg');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const WORKSPACE = '/workspace';
const NETWORK = process.env.DOCKER_NETWORK || 'vc-net';
const POLL_INTERVAL_MS = 3000;
const APP_PORT = 3000;
const OUTPUT_DIR_CANDIDATES = ['dist', 'build', 'public', '_site', 'out'];

function run(cmd, opts = {}) {
  const result = spawnSync('sh', ['-c', cmd], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    ...opts,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

async function claimNextJob() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT d.id, d.commit_sha, d.branch, d.project_id, p.subdomain, p.repo_url
      FROM deployments d
      JOIN projects p ON p.id = d.project_id
      WHERE d.status = 'pending'
      ORDER BY d.id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    if (rows.length === 0) {
      await client.query('COMMIT');
      return null;
    }
    const job = rows[0];
    await client.query(
      `UPDATE deployments SET status='building', updated_at=NOW(), build_log='' WHERE id=$1`,
      [job.id]
    );
    await client.query('COMMIT');
    return job;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function appendLog(id, chunk) {
  await pool.query(
    `UPDATE deployments
       SET build_log = COALESCE(build_log, '') || $2, updated_at = NOW()
     WHERE id = $1`,
    [id, chunk]
  );
}

async function markFinished(id, status, fields = {}) {
  await pool.query(
    `UPDATE deployments
       SET status=$2, error_message=$3, image_tag=$4, container_name=$5, app_type=$6,
           finished_at=NOW(), updated_at=NOW()
     WHERE id=$1`,
    [id, status, fields.error || null, fields.image_tag || null, fields.container_name || null, fields.app_type || null]
  );
}

function detectAppType(repoDir) {
  if (fs.existsSync(path.join(repoDir, 'Dockerfile'))) return 'dockerfile';
  const pkgPath = path.join(repoDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (err) {
      console.error('[builder] failed to parse package.json:', err.message);
      return 'static';
    }
    if (pkg.scripts && pkg.scripts.start) return 'node-app';
    if (pkg.scripts && pkg.scripts.build) return 'node-static';
  }
  return 'static';
}

function findOutputDir(repoDir) {
  for (const name of OUTPUT_DIR_CANDIDATES) {
    const c = path.join(repoDir, name);
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
  }
  return repoDir;
}

function writeFile(p, content) {
  fs.writeFileSync(p, content);
}

function prepareDockerfile(repoDir, appType, deploymentId, logger) {
  if (appType === 'dockerfile') {
    logger('Using existing Dockerfile from repo\n');
    return;
  }

  if (appType === 'node-app') {
    logger('Generating Node app Dockerfile\n');
    writeFile(path.join(repoDir, 'Dockerfile.vc'), `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
ENV PORT=${APP_PORT}
EXPOSE ${APP_PORT}
CMD ["npm", "start"]
`);
    return;
  }

  if (appType === 'node-static') {
    logger('Generating two-stage Dockerfile (build then nginx-serve)\n');
    writeFile(path.join(repoDir, 'Dockerfile.vc'), `FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build && \\
    if [ -d dist ]; then cp -r dist /out; \\
    elif [ -d build ]; then cp -r build /out; \\
    elif [ -d public ]; then cp -r public /out; \\
    elif [ -d out ]; then cp -r out /out; \\
    else echo "no output dir found" && exit 1; fi

FROM nginx:alpine
COPY --from=build /out /usr/share/nginx/html
RUN echo 'server { listen ${APP_PORT}; root /usr/share/nginx/html; index index.html; location / { try_files $uri $uri/ /index.html; } }' > /etc/nginx/conf.d/default.conf
EXPOSE ${APP_PORT}
`);
    return;
  }

  // Plain static
  logger('Generating nginx Dockerfile (plain static)\n');
  writeFile(path.join(repoDir, 'Dockerfile.vc'), `FROM nginx:alpine
COPY . /usr/share/nginx/html
RUN echo 'server { listen ${APP_PORT}; root /usr/share/nginx/html; index index.html; location / { try_files $uri $uri/ /index.html; } }' > /etc/nginx/conf.d/default.conf
EXPOSE ${APP_PORT}
`);
}

async function build(job) {
  const id = job.id;
  const workDir = path.join(WORKSPACE, String(id));

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const log = (s) => appendLog(id, s);

  await log(`=== Cloning ${job.repo_url} (branch: ${job.branch}) ===\n`);
  const clone = run(`git -c protocol.file.allow=always clone --depth=1 --branch ${job.branch} ${job.repo_url} ${workDir}`);
  await log(clone.stdout + clone.stderr);
  if (clone.status !== 0) throw new Error('git clone failed');

  const appType = detectAppType(workDir);
  await log(`\n=== Detected app type: ${appType} ===\n`);

  prepareDockerfile(workDir, appType, id, (s) => log(s));

  const imageTag = `vc-app-${job.subdomain}:${job.commit_sha.slice(0, 8) || 'latest'}`;
  const dockerfileArg = appType === 'dockerfile' ? '' : '-f Dockerfile.vc';

  await log(`\n=== Building image ${imageTag} ===\n`);
  // NOTE: builder mounts /workspace, but docker build runs on the host's daemon.
  // The host doesn't see /workspace/<id>, but the workspace volume is named.
  // Solution: tar the directory and pipe to `docker build -`.
  const buildCmd = `tar -C ${workDir} -cf - . | docker build ${dockerfileArg} -t ${imageTag} -`;
  const buildRes = run(buildCmd);
  await log(buildRes.stdout + buildRes.stderr);
  if (buildRes.status !== 0) throw new Error('docker build failed');

  const containerName = `vc-app-${job.subdomain}`;

  await log(`\n=== Stopping previous container if any ===\n`);
  run(`docker rm -f ${containerName}`);

  await log(`=== Starting container ${containerName} ===\n`);
  const runCmd = `docker run -d --name ${containerName} --network ${NETWORK} --restart unless-stopped -e PORT=${APP_PORT} ${imageTag}`;
  const runRes = run(runCmd);
  await log(runRes.stdout + runRes.stderr);
  if (runRes.status !== 0) throw new Error('docker run failed');

  await log(`\n=== Done. Live at http://${job.subdomain}.localhost:8080 ===\n`);
  return { image_tag: imageTag, container_name: containerName, app_type: appType };
}

async function tick() {
  let job;
  try {
    job = await claimNextJob();
  } catch (err) {
    console.error('[builder] claim error:', err.message);
    return;
  }
  if (!job) return;

  console.log(`[builder] starting deployment ${job.id} (${job.subdomain})`);
  try {
    const result = await build(job);
    await markFinished(job.id, 'success', result);
    console.log(`[builder] deployment ${job.id} succeeded`);
  } catch (err) {
    await appendLog(job.id, `\n[FAILED] ${err.message}\n`).catch(() => {});
    await markFinished(job.id, 'failed', { error: err.message });
    console.error(`[builder] deployment ${job.id} failed: ${err.message}`);
  }
}

async function main() {
  console.log('[builder] started, polling every', POLL_INTERVAL_MS, 'ms');
  console.log('[builder] using docker network:', NETWORK);
  console.log('[builder] workspace:', WORKSPACE);
  while (true) {
    await tick();
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error('[builder] fatal:', err);
  process.exit(1);
});
