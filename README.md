# FOFUS Quote — instant 3D printing quotes

Customer-facing quote portal at **https://quote.business.fofus.in**.

Monorepo, single-origin deployment on Railway:
- `frontend/` — static HTML/CSS/JS, served by the Express backend from `/`
- `backend/`  — Node + Express + SQLite + OrcaSlicer → **Railway**

The domain is routed to Railway (DNS CNAME → `wj7vscgg.up.railway.app`). Vercel is no longer used for this service.

## Architecture
```
┌──────────────────────────────────────────┐
│  quote.business.fofus.in                 │
│  Railway                                 │
│  Express                                 │
│  ├── serves frontend static files        │
│  └── API routes under /api/*             │
│       │                                  │
│       │ spawns OrcaSlicer CLI           │
│       ▼                                  │
│  /usr/local/bin/orca-slicer-xvfb         │
│  (xvfb-run + Ubuntu 24.04 AppImage)     │
└──────────────────────────────────────────┘
```

## Frontend
- `frontend/index.html` — single-page quote UI
- `frontend/style.css` — visual system (mirrors fofus.in: dark + gold + Cormorant Garamond)
- `frontend/app.js`   — STL parser, quote math, PDF export, backend POST
- No build step. Served from `/` by Express.

## Backend
- `backend/src/server.js` — Express app, routes
- `backend/src/db.js`     — SQLite job queue (better-sqlite3, single file)
- `backend/src/slicer.js` — OrcaSlicer CLI wrapper
- `backend/src/quote.js`  — Final quote from sliced G-code footer
- `Dockerfile`            — repo-root multi-stage build (Node 20 + OrcaSlicer AppImage on Ubuntu 24.04)
- `railway.json`          — tells Railway to build from `Dockerfile`

## Endpoints
- `GET  /api/health`            — liveness
- `GET  /api/slicer/check`      — verify slicer binary + profiles present
- `POST /api/print-jobs`        — JSON body, base64 STL → returns job_id
- `POST /api/print-jobs/upload` — multipart/form-data STL upload
- `POST /api/print-jobs/:id/slice` — kick off OrcaSlicer (async)
- `GET  /api/print-jobs/:id`    — fetch status + final quote + gcode path
- `GET  /api/print-jobs`        — list (gated by `ADMIN_TOKEN`)
- `GET  /api/print-jobs/:id/file?kind=gcode|original` — download

## Deploy
See `DEPLOY.md`. TL;DR:

```bash
git add . && git commit -m "..." && git push
# Railway auto-deploys from the repo-root Dockerfile.
```
