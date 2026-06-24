# FOFUS Quote — instant 3D printing quotes

Customer-facing quote portal at **https://qoute.custom.fofus.in** (subdomain of fofus.in).

Monorepo:
- `frontend/` — static HTML/CSS/JS → **Vercel**
- `backend/`  — Node + Express + SQLite + OrcaSlicer → **Railway**

## Architecture
```
┌──────────────┐     POST /api/print-jobs    ┌──────────────────┐
│  Vercel      │ ──────────────────────────▶ │  Railway         │
│  (frontend)  │   { file_base64, settings }  │  (backend)       │
│  qoute.custom│                              │  Express         │
│  .fofus.in   │   GET  /api/print-jobs/:id   │  + SQLite queue  │
│              │ ◀──────────────────────────  │  + OrcaSlicer    │
└──────────────┘                              │    CLI           │
                                              └──────────────────┘
                                                       │
                                                       │ spawns
                                                       ▼
                                              ┌──────────────────┐
                                              │  /usr/local/bin/ │
                                              │  orca-slicer     │
                                              │  (Linux AppImage)│
                                              └──────────────────┘
```

## Frontend (Vercel)
- `frontend/index.html` — single-page quote UI
- `frontend/style.css` — visual system (mirrors fofus.in: dark + gold + Cormorant Garamond)
- `frontend/app.js`   — STL parser, quote math, PDF export, backend POST
- No build step. Deploy as static. Set `FOFUS_API` (optional) to point at backend.

## Backend (Railway)
- `backend/src/server.js` — Express app, routes
- `backend/src/db.js`     — SQLite job queue (better-sqlite3, single file)
- `backend/src/slicer.js` — OrcaSlicer CLI wrapper
- `backend/src/quote.js`  — Final quote from sliced G-code footer
- `backend/Dockerfile`    — Node 20 + OrcaSlicer AppImage (FUSE extracted)

## Endpoints
- `GET  /api/health`            — liveness
- `GET  /api/slicer/check`      — verify orca-slicer CLI callable
- `POST /api/print-jobs`        — JSON body, base64 STL → returns job_id
- `POST /api/print-jobs/upload` — multipart/form-data STL upload
- `POST /api/print-jobs/:id/slice` — kick off OrcaSlicer (async)
- `GET  /api/print-jobs/:id`    — fetch status + final quote + gcode path
- `GET  /api/print-jobs`        — list (gated by `ADMIN_TOKEN`)
- `GET  /api/print-jobs/:id/file?kind=gcode|original` — download

## Deploy
See `DEPLOY.md` for step-by-step Vercel + Railway + custom domain instructions.
