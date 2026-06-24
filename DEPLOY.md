# Deploy guide — FOFUS Quote

End-to-end: from this repo to a live site at `qoute.custom.fofus.in`.

Two services, two providers:
- **Vercel** hosts the frontend (`/`)
- **Railway** hosts the backend (Docker)

The frontend calls the backend over CORS. Both get a free tier — should
cost $0/month at low traffic.

---

## 0. Prereqs (one-time)

```bash
# GitHub CLI (auth needed to push code)
gh auth login         # follow prompts, choose HTTPS

# Vercel CLI (optional — Vercel has a great web UI, you may not need this)
npm i -g vercel
vercel login
```

---

## 1. Push to GitHub

```bash
cd C:/Users/Fofus/websites/fofus-quote
git add .
git commit -m "Initial FOFUS Quote — frontend + backend"
gh repo create fofus-quote --public --source=. --remote=origin --push
```

If `gh repo create` complains the repo already exists remotely, do:
```bash
git remote add origin https://github.com/<your-username>/fofus-quote.git
git push -u origin main
```

---

## 2. Deploy backend to Railway (~10 min)

1. Go to https://railway.app/new
2. Click **Deploy from GitHub repo** → pick `fofus-quote`
3. In **Settings**, set **Root Directory** to `backend` (so Railway builds from `backend/Dockerfile`)
4. Railway auto-detects the Dockerfile and starts building. First build takes ~5 min (OrcaSlicer AppImage is ~200 MB).
5. After deploy succeeds, Railway gives you a URL like `https://fofus-quote-backend-production.up.railway.app`.
6. **Settings → Variables**, add:
   - `ADMIN_TOKEN` = anything random (`openssl rand -hex 16`)
   - `PORT` = `3000` (default)
7. **Settings → Networking**, click **Generate Domain** if not already public.

### Test
```bash
curl https://<your-railway-url>/api/health
# {"status":"ok","service":"fofus-quote-backend",...}

curl https://<your-railway-url>/api/slicer/check
# {"ok":true,"bin":"/usr/local/bin/orca-slicer",...}
```

### Wire it to the frontend
Once both are live, set the backend URL in the Vercel frontend env. See step 3.

---

## 3. Deploy frontend to Vercel (~2 min)

### Option A: Vercel web UI (recommended)

1. Go to https://vercel.com/new
2. **Import Git Repository** → pick `fofus-quote`
3. **Root Directory** → click Edit → set to `frontend`
4. **Framework Preset** → "Other" (it's static HTML)
5. **Environment Variables**, add:
   - `FOFUS_API` = `https://<your-railway-url>` (no trailing slash)
6. Click **Deploy**. ~30 seconds.

### Option B: Vercel CLI

```bash
cd frontend
vercel --prod
# follow prompts; it auto-detects static
# when asked "Which scope?", pick your personal account
# when asked "Link to existing project?", No
# when asked "In which directory is your code located?", ./  (current dir is frontend)
```

### Test
Visit `https://fofus-quote-xxx.vercel.app` — should see the dark+gold FOFUS Quote page.
Upload `C:/Users/Fofus/Desktop/fofus.stl` — should compute a quote in <1s.

---

## 4. Custom domain: qoute.custom.fofus.in

This involves DNS for `custom.fofus.in` (which is a subdomain of `fofus.in`).
You'll need access to whoever manages the DNS for `fofus.in`.

In Vercel (where your `fofus-quote` project lives):
1. **Settings → Domains** → add `qoute.custom.fofus.in`
2. Vercel tells you the CNAME target, e.g. `cname.vercel-dns.com`
3. Go to your DNS provider for `custom.fofus.in` (or `fofus.in`) and add:
   - **CNAME** record: host `qoute` → `cname.vercel-dns.com`
   - If your DNS doesn't support CNAME on the apex of a subdomain, use an A record:
     `76.76.21.21` (Vercel's anycast IP)
4. Wait ~5 min for SSL + propagation. Done.

Repeat for the backend if you want a clean URL like `api.qoute.custom.fofus.in`:
- Railway → Settings → Networking → Custom Domain → `api.qoute.custom.fofus.in`
- CNAME `api.qoute.custom.fofus.in` → Railway-provided target (usually `<something>.up.railway.app`)

---

## 5. Update the frontend when backend changes

The frontend reads the backend URL from one place: `window.FOFUS_API` (set at build time by Vercel) or hardcoded fallback.

Edit `frontend/app.js` line ~38:
```js
const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname.includes('vercel.app'))
  ? ''  // same-origin on Vercel preview
  : (window.FOFUS_API || 'https://fofus-quote-api.up.railway.app');
```

Set `FOFUS_API` in Vercel env (recommended) so you don't hardcode URLs.

To deploy a change:
```bash
git add . && git commit -m "tweak" && git push
# Railway auto-deploys backend; Vercel auto-deploys frontend. Done.
```

---

## 6. Smoke test the full pipeline

```bash
# 1. Backend reachable
curl https://fofus-quote-api.up.railway.app/api/health

# 2. Submit a job (uses your real fofus.stl)
node -e "
const fs = require('fs');
const buf = fs.readFileSync('C:/Users/Fofus/Desktop/fofus.stl');
const b64 = buf.toString('base64');
fetch('https://fofus-quote-api.up.railway.app/api/print-jobs', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    file_name: 'fofus.stl',
    file_size: buf.length,
    file_base64: b64,
    printer: 'x1c',
    material: 'pla',
    infill: 20,
    layer_height: 0.28,
    supports: 'auto',
    contact: { name: 'Test', email: 'test@fofus.in', phone: '+91', pincode: '680121' },
    quote: { weight_g: 3.4, minutes: 4, total: 14 },
  }),
}).then(r => r.json()).then(console.log);
"
# → { job_id: '...', status: 'queued' }

# 3. Kick off slicing
JOB_ID="<paste from above>"
curl -X POST https://fofus-quote-api.up.railway.app/api/print-jobs/$JOB_ID/slice

# 4. Poll status
sleep 20
curl https://fofus-quote-api.up.railway.app/api/print-jobs/$JOB_ID | python -m json.tool
```

---

## 7. Where things live

| What                  | Where                                       |
|-----------------------|---------------------------------------------|
| Frontend source       | `C:/Users/Fofus/websites/fofus-quote/frontend/` |
| Backend source        | `C:/Users/Fofus/websites/fofus-quote/backend/`  |
| Backend logs          | Railway dashboard → Logs                   |
| Job database          | Railway volume → `/app/data/jobs.db`        |
| Uploaded STL files    | Railway volume → `/app/data/uploads/`       |
| Sliced gcode          | Railway volume → `/app/data/sliced/`        |

To back up jobs DB, in Railway:
- **Settings → Volumes** → click the volume → connect via Railway CLI:
  `railway run cp /app/data/jobs.db ./jobs-backup.db`

---

## 8. Cost

At low traffic (< 1000 quotes/day):
- Vercel: $0 (free hobby tier covers it)
- Railway: $5/mo minimum (the included $5 covers ~500 hrs of the small container; OrcaSlicer image is heavy so each idle hour matters). For truly free, consider switching to Fly.io free tier — same Dockerfile works.

If you need to bring Railway cost to $0, swap Dockerfile → fly.toml and use Fly.io's free allowance.
