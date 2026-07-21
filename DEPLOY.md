# Deploy guide — FOFUS Quote

End-to-end: from this repo to a live site at `quote.business.fofus.in`.

Single-origin on **Railway**. The Express backend serves both the static
frontend and the API from the same domain, so there is no CORS and only one
host to manage. Vercel is no longer used for this service.

## 1. Push to GitHub

```bash
cd /home/reventer/work/fofus-quote
git add . && git commit -m "init" && git push
```

## 2. Railway deploy

1. https://railway.app/new → **Deploy from GitHub repo** → pick `fofus-quote`
2. Railway uses the repo-root `Dockerfile` (configured in `railway.json`)
3. First build is ~8–10 min: it downloads the ~200 MB OrcaSlicer AppImage and installs Ubuntu 24.04 GUI libs.
4. Add a **volume** mounted at `/app/data` so jobs/uploaded models/gcode persist across deploys.
5. Add env var `ADMIN_TOKEN=***` (random string) for the admin list endpoint.
6. Generate or set custom domain `quote.business.fofus.in` in Railway **Networking**.
7. In GoDaddy DNS add a **CNAME** `quote` → `wj7vscgg.up.railway.app` (or whatever Railway gives you).

### Verify

```bash
curl https://quote.business.fofus.in/              # should return HTML
curl https://quote.business.fofus.in/api/health   # {"status":"ok",...}
curl https://quote.business.fofus.in/api/slicer/check
# {"ok":true,"bin":"/usr/local/bin/orca-slicer-xvfb","profiles_dir":"/app/profiles"}
```

### End-to-end smoke test

```bash
python3 -c "
import base64, json, os
stl = open('/tmp/cube10mm.stl','rb').read()
body = json.dumps({
    'file_name':'cube10mm.stl', 'file_size':len(stl),
    'file_base64': base64.b64encode(stl).decode(),
    'printer':'x1c', 'material':'pla', 'infill':20,
    'layer_height':0.28, 'supports':'auto',
    'quote':{'weight_g':3.4,'minutes':4,'total':14},
    'contact':{'name':'Test','email':'test@fofus.in','phone':'','pincode':'680001'}
})
print(body)
" > /tmp/quote_payload.json

JOB=$(curl -sS -X POST -H 'Content-Type: application/json' -d @/tmp/quote_payload.json \
  https://quote.business.fofus.in/api/print-jobs | python3 -c 'import json,sys; print(json.load(sys.stdin)["job_id"])')

curl -sS -X POST https://quote.business.fofus.in/api/print-jobs/$JOB/slice

# Wait ~30-60s, then:
curl -sS https://quote.business.fofus.in/api/print-jobs/$JOB | python3 -m json.tool
# Expect status:"sliced", final_quote.source:"slicer", gcode_path set.
```

## 3. Update flow after changes

```bash
git add . && git commit -m "..." && git push
# Railway auto-deploys. No Vercel step.
```

## 4. Where things live

| What                | Where                                       |
|---------------------|---------------------------------------------|
| Frontend source     | `frontend/`                                 |
| Backend source      | `backend/`                                  |
| Production image    | `Dockerfile` (repo root)                    |
| Railway config      | `railway.json`                              |
| Backend logs        | Railway dashboard → Logs                    |
| Job database        | Railway volume → `/app/data/jobs.db`          |
| Uploaded STL files  | Railway volume → `/app/data/uploads/`         |
| Sliced gcode        | Railway volume → `/app/data/sliced/`          |

## 5. Cost

At low traffic the Railway container sits above the $5/mo minimum because the
image is heavy. Budget ~$5–10/mo for the quote service.

## 6. Headless slicing notes

The Dockerfile uses:
- `ubuntu:24.04` runtime so the Ubuntu 24.04 OrcaSlicer AppImage gets GLIBC 2.38+
- `xvfb-run -a` wrapper (`/usr/local/bin/orca-slicer-xvfb`) so OrcaSlicer has a virtual X display
- GTK / WebKit / GStreamer / OpenGL libs required by the AppImage

The backend copies `backend/profiles` into `/app/profiles`; these are the
process/machine/filament overrides OrcaSlicer needs.

If the AppImage fails to launch, read the job `slice_log` from
`/api/print-jobs/:id` — it surfaces the exact `ldd`-style error.
