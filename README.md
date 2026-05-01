# Vercel-clone — DevOps capstone

A self-hosted Vercel-like CI/CD platform: connect a GitHub repo, get a live URL on every push.

```
git push  →  GitHub webhook  →  Control plane  →  Builder  →  Caddy proxy  →  <subdomain>.localhost
```

## What it does

- **Register a project** by pointing at a GitHub repo and assigning a subdomain
- **Auto-deploy on push** via a GitHub webhook (HMAC-signed)
- **Build static or Node-based sites** by detecting `package.json` / `npm run build`
- **Route subdomain traffic** automatically (`mysite.localhost:8080`)
- **Stream build logs live** via Server-Sent Events
- **Dashboard UI** to manage projects and watch builds

## Architecture

```
┌────────────┐   webhook    ┌──────────────────┐   pending deployment   ┌─────────┐
│   GitHub   │ ───────────► │  Control Plane   │ ─── postgres ────────► │ Builder │
└────────────┘              │  (Node/Express)  │                        │ (Node)  │
                            │                  │ ◄─── live log SSE ──── │         │
                            └────────┬─────────┘                        └────┬────┘
                                     │                                       │
                                     │ serves /                              │ writes
                                     │ dashboard UI                          │ static files
                                     ▼                                       ▼
                            ┌──────────────────┐                        ┌─────────┐
                            │   Browser (you)  │ ◄──── HTTP / files ─── │  Caddy  │
                            │                  │   (subdomain routing)  │  proxy  │
                            └──────────────────┘                        └─────────┘
```

| Service | Role | Stack |
|---|---|---|
| `control-plane` | API: webhook receiver, projects/deployments CRUD, SSE log streaming, dashboard | Node 20 + Express + pg |
| `builder` | Worker: polls DB for pending deployments, clones repo, runs build, publishes to a shared volume | Node 20 + git |
| `caddy`  | Reverse proxy: routes `<subdomain>.localhost:8080` → files in `/srv/sites/<subdomain>/` | Caddy 2 |
| `postgres` | Stores projects, deployments, build logs, applied schema migrations | Postgres 16 |

## Run it locally

```bash
docker compose up --build -d
```

Then visit:
- **Dashboard:** http://localhost:3000
- **A deployed site:** http://spoonknife.localhost:8080 (after first deploy)
- **Health:** http://localhost:3000/health
- **DB shell:** `docker compose exec postgres psql -U app -d platform`

## End-to-end demo

```bash
# 1. Register a project
curl -X POST http://localhost:3000/projects \
  -H 'Content-Type: application/json' \
  -d '{"name":"spoon-knife","repo_url":"https://github.com/octocat/Spoon-Knife","subdomain":"spoonknife"}'

# 2. Trigger a build (skip-HMAC dev helper)
curl -X POST http://localhost:3000/test/fake-push \
  -H 'Content-Type: application/json' \
  -d '{"repo_url":"https://github.com/octocat/Spoon-Knife"}'

# 3. Wait a few seconds, then visit:
curl -H "Host: spoonknife.localhost" http://localhost:8080/
```

For real GitHub webhooks, configure your repo to POST to `http://YOUR_HOST/webhooks/github`
with the secret `dev-secret` (or override via `GITHUB_WEBHOOK_SECRET` env var).

## CI/CD for this project itself

This project demonstrates **two layers of CI/CD**:

- **Layer 1 (the platform-of-the-platform):** `.github/workflows/ci.yml` runs on every PR — boots
  the whole stack and runs smoke tests. `.github/workflows/deploy.yml` builds container images,
  pushes them to GHCR, and deploys to a VM over SSH on every merge to `main`.
- **Layer 2 (this is what you're building):** the platform itself is a CI/CD system, deploying
  end-user apps on every `git push` to a registered repo.

GitHub Actions deploys *the platform*; the platform deploys *user apps*.

## Layout

```
devops/
├── docker-compose.yml          # 4 services + 5 volumes
├── README.md
├── .github/workflows/
│   ├── ci.yml                  # PR/merge smoke tests
│   └── deploy.yml              # build & push images, SSH-deploy to VM
├── caddy/
│   └── Caddyfile               # subdomain routing
├── control-plane/
│   ├── Dockerfile
│   ├── package.json
│   ├── public/
│   │   └── index.html          # dashboard UI (vanilla JS)
│   ├── migrations/
│   │   ├── 001_init.sql                  # projects table
│   │   ├── 002_deployments.sql           # deployments table + indexes
│   │   └── 003_deployment_logs.sql       # log fields
│   └── src/
│       ├── index.js            # routes
│       ├── db.js               # pg pool
│       ├── migrate.js          # migration runner (schema_migrations tracking)
│       ├── webhook.js          # HMAC-verified GitHub webhook receiver
│       └── logs-sse.js         # SSE log streaming
└── builder/
    ├── Dockerfile
    ├── package.json
    └── src/
        └── index.js            # poll loop using FOR UPDATE SKIP LOCKED
```

## Key design decisions

| Decision | Why |
|---|---|
| Postgres `FOR UPDATE SKIP LOCKED` for job claim | Atomic, multi-worker-safe job queue without Redis |
| HMAC-SHA256 webhook signature + timing-safe compare | Prevents forged webhooks; resists timing attacks |
| Raw SQL + `pg` (no ORM) | Lower learning surface; SQL skills transfer everywhere |
| `node --watch` for dev hot-reload | Built-in to Node 20 — no nodemon dependency |
| `schema_migrations` table tracks applied SQL files | Standard pattern; safe to restart |
| Shared `sites` volume between builder and caddy | Builder writes, Caddy reads; no inter-service network call |
| SSE for log streaming (not WebSocket) | Simpler — one-way is all we need, and HTTP-1.1 works fine |
| Caddy on port 8080 | Avoids root requirement for port 80 binding |

## What's out of scope (MVP)

- Preview deployments per PR
- Rollback to a previous deployment
- Multi-language buildpacks (only Node + plain static for now)
- Build sandbox isolation (builder currently runs `npm install` on untrusted code in its own container — for a production system, builds should run in throwaway sandboxes)
- Automatic HTTPS (requires a real domain — Caddy handles this on its own once `auto_https` is enabled)
- Multi-VM / orchestration (single-VM target by design)
