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
gh auth login         # follow prompts, choose HTTPS, browser auth
```

---

## 1. Push to GitHub

```bash
cd C:/Users/Fofus/websites/fofus-quote
gh repo create fofus-quote --public --source=. --remote=origin --push
```

If `gh repo create` says the repo exists, do:
```bash
git remote add origin https://github.com/<your-username>/fofus-quote.git
git push -u origin main
```

The repo includes ~2000 Bambu Studio system profile JSONs (machine +
process + filament) which the OrcaSlicer CLI needs to slice real parts.
That's expected and required.

---

## 2. Deploy backend to Railway (~10 min)

1. https://railway.app/new → **Deploy from GitHub repo** → pick `fofus-quote`
2. **Settings → Root Directory** = `backend` (so Railway builds `backend/Dockerfile`)
3. Railway auto-builds. First build is ~5 min (OrcaSlicer AppImage is ~200 MB).
4. Railway gives you a URL like `https://fofus-quote-backend-production.up.railway.app`
5. **Variables**: add `ADMIN_TOKEN=***` (any random string)
6. **Networking → Generate Domain** if not auto-public

### Verify
```bash
curl https://<your-url>/api/health
# {"status":"ok",...}

curl https://<your-url>/api/slicer/check
# {"ok":true,"bin":"/usr/local/bin/orca-slicer",...}
```

### End-to-end smoke test against Railway
```bash
node -e "
const fs = require('fs');
const buf = fs.readFileSync('C:/Users/Fofus/Desktop/fofus.stl');
fetch('https://<your-url>/api/print-jobs', {
  method:'POST', headers:{'content-type':'application/json'},
  body: JSON.stringify({
    file_name:'fofus.stl', file_size:buf.length,
    file_base64: buf.toString('base64'),
    printer:'x1c', material:'pla', infill:20, layer_height:0.28, supports:'auto',
    quote:{weight_g:3.4, minutes:4, total:14}
  })
}).then(r=>r.json()).then(j=>{
  console.log('queued:', j.job_id);
  return fetch('https://<your-url>/api/print-jobs/'+j.job_id+'/slice', {method:'POST'});
}).then(r=>r.json()).then(console.log);
"
# Wait ~30s, then:
curl https://<your-url>/api/print-jobs/<JOB_ID>
# Look for status:"sliced", gcode_path set, final_quote.source:"slicer"
```

---

## 3. Deploy frontend to Vercel (~2 min)

1. https://vercel.com/new → **Import Git Repository** → `fofus-quote`
2. **Root Directory** = `frontend`
3. **Framework Preset** = Other
4. **Environment Variables**: `FOFUS_API` = `https://<your-railway-url>` (no trailing slash)
5. **Deploy**

Visit `https://fofus-quote-xxx.vercel.app` — should see the dark+gold FOFUS Quote page.
Upload `C:/Users/Fofus/Desktop/fofus.stl` — instant quote + "Request Printing" → backend POSTs.

---

## 4. Custom domain: qoute.custom.fofus.in

In Vercel → **Settings → Domains** → add `qoute.custom.fofus.in`. Vercel shows the
CNAME target. Add DNS:

- **CNAME** `qoute` → `cname.vercel-dns.com`
  (or A record to `76.76.21.21` if your DNS doesn't support CNAME on subdomains)

For `api.qoute.custom.fofus.in` → Railway:
- Railway → **Networking → Custom Domain** → `api.qoute.custom.fofus.in`
- CNAME `api` → Railway-provided target

---

## 5. Update flow after changes

```bash
git add . && git commit -m "..." && git push
# Railway + Vercel auto-deploy. Done.
```

---

## 6. Where things live

| What                | Where                                       |
|---------------------|---------------------------------------------|
| Frontend source     | `C:/Users/Fofus/websites/fofus-quote/frontend/` |
| Backend source      | `C:/Users/Fofus/websites/fofus-quote/backend/`  |
| Backend logs        | Railway dashboard → Logs                   |
| Job database        | Railway volume → `/app/data/jobs.db`        |
| Uploaded STL files  | Railway volume → `/app/data/uploads/`       |
| Sliced gcode        | Railway volume → `/app/data/sliced/`        |

---

## 7. Cost

At low traffic (< 1000 quotes/day):
- **Vercel**: $0 (free hobby tier)
- **Railway**: $5/mo minimum (the $5 covers ~500 hrs of the small container;
  OrcaSlicer image is heavy so idle hours matter)

To bring Railway cost to $0, swap Dockerfile → fly.toml and use Fly.io's free
allowance — same Dockerfile works as-is.

---

## 8. Architecture quirks (read this if you change the slicer)

The OrcaSlicer CLI has 5 surprising behaviors the backend handles:

1. **`.ini` files are JSON.** Despite the extension, OrcaSlicer parses them
   via `load_from_json`. Use JSON, not INI format.

2. **No `--export-gcode` flag.** Gcode goes to `<outputdir>/gcode/<stem>.gcode`
   automatically. Or, if the slicer is given a "plate", to `<outputdir>/plate_N.gcode`.
   Use a recursive scan as fallback.

3. **No `--no-save` flag.** Just don't pass it.

4. **CLI validator is overly strict.** OrcaSlicer 2.3.1 has `is_BBL_printer()`
   declared in `Print.hpp:977` but never assigned anywhere — it defaults to false.
   Result: even when slicing a Bambu printer, the `Print.cpp:1407` validator
   demands `G92 E0` in `layer_change_gcode` or `before_layer_change_gcode`.
   Inject it manually in `slicer.js buildSettingsJson`.

5. **Process + machine profiles both needed.** Pass `--load-settings <process.json>`
   AND `--load-settings <machine.json>` together. Pass only one → "process not
   compatible with printer".

6. **Filament time is in header, filament weight is in footer.** Read both ends
   in `quote.js parseGcodeFooter` to populate weight + time.

If you need to bring Railway cost to $0, swap Dockerfile → fly.toml and use Fly.io's free allowance.
