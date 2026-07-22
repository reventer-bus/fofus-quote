/* ════════════════════════════════════════════════════════════════════
   FOFUS Quote — frontend engine
   ────────────────────────────────────────────────────────────────────
   • STL parser (binary STL, the 99% case; ASCII fallback message)
   • Quote math: volume × density + infill + support estimate
   • Empirical print-time model calibrated to FOFUS production prints
   • PDF quote download (client-side, no server roundtrip)
   • "Request printing" POSTs STL + settings to Railway backend
   ════════════════════════════════════════════════════════════════════ */

/*
    Empirical print-time model calibrated to FOFUS production outputs.
    Customer-facing copy must not name manufacturer or slicing software brands.
   */

// ── State ──────────────────────────────────────────────────────────
const state = {
  file: null,
  fileBuf: null,
  geometry: null,   // { volumeCm3, bbox: {x,y,z}, triangles }
  printer: 'x1c',   // 'a1' | 'x1c' | 'k1max'
  material: 'pla',  // 'pla' | 'petg' | 'abs' | 'silicon' | 'fibre'
  infill: 20,
  layerHeight: 0.20,
  supports: 'auto', // 'auto' | 'none'
  quote: null,      // last computed quote (used by PDF + submit)
  jobId: null,      // backend job id
  jobStatus: null,  // 'queued' | 'slicing' | 'sliced' | 'slice_failed' | 'awaiting_payment'
};

// ── Constants ──────────────────────────────────────────────────────
const PRINTERS = {
  a1:   { name: 'Standard 256³ chamber',   ratePerHr: 35, buildMm: 256 },
  x1c:  { name: 'Engineering 256³ chamber', ratePerHr: 50, buildMm: 256 },
  k1max:{ name: 'Large 300³ chamber',      ratePerHr: 45, buildMm: 300 },
};
const MATERIALS = {
  pla:    { name: 'PLA',     ratePerG: 2.5,  densityGcm3: 1.24, speed: 1.00 },
  petg:   { name: 'PETG',    ratePerG: 3.5,  densityGcm3: 1.27, speed: 0.90 },
  abs:    { name: 'ABS',     ratePerG: 5.0,  densityGcm3: 1.04, speed: 0.85 },
  silicon:{ name: 'Silicon', ratePerG: 20.0, densityGcm3: 1.20, speed: 0.60 },
  fibre:  { name: 'Fibre',   ratePerG: 10.0, densityGcm3: 1.30, speed: 0.70 },
};
const SERVICE_FEE_RATIO = 0.15;  // 15% service markup
const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname.includes('vercel.app'))
  ? (window.FOFUS_API || 'https://quote.business.fofus.in')  // Vercel preview → Railway backend
  : '';  // Same origin — backend serves frontend

// ════════════════════════════════════════════════════════════════════
// STL PARSER (binary)
// ────────────────────────────────────────────────────────────────────
// Reference: binary STL = 80-byte header | uint32 triangle count |
//   per triangle: 3 × float32 normal + 9 × float32 vertices + uint16 attr
//   = 50 bytes/triangle
function parseBinarySTL(buf) {
  if (buf.byteLength < 84) throw new Error('File too small to be a binary STL');
  const view = new DataView(buf);
  const triCount = view.getUint32(80, true);
  const expected = 84 + triCount * 50;
  if (buf.byteLength < expected) {
    throw new Error(`Binary STL truncated: header claims ${triCount} triangles but file is short`);
  }

  let volMm3 = 0;           // signed tetrahedron volume sum
  let minX=Infinity, minY=Infinity, minZ=Infinity;
  let maxX=-Infinity, maxY=-Infinity, maxZ=-Infinity;

  let off = 84;
  for (let i = 0; i < triCount; i++) {
    // Skip normal (12 bytes) at off..off+12
    off += 12;
    const v = [];
    for (let vtx = 0; vtx < 3; vtx++) {
      const x = view.getFloat32(off, true);
      const y = view.getFloat32(off + 4, true);
      const z = view.getFloat32(off + 8, true);
      off += 12;
      v.push([x, y, z]);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    // Signed tetrahedron volume from origin
    const [a, b, c] = v;
    volMm3 += (
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0])
    ) / 6;
    off += 2; // attribute byte count
  }
  const volMm3Abs = Math.abs(volMm3);
  return {
    triangles: triCount,
    volumeMm3: volMm3Abs,
    volumeCm3: volMm3Abs / 1000,
    bbox: {
      x: maxX - minX, y: maxY - minY, z: maxZ - minZ,
      min: [minX, minY, minZ], max: [maxX, maxY, maxZ],
    },
  };
}

// Quick sniff for ASCII STL ("solid ... facet ... vertex ... endsolid")
function looksLikeASCII(buf) {
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(80, buf.byteLength)));
  return /^solid\s+\S+/i.test(head.trimStart()) && /facet\s+normal/i.test(head);
}
function parseASCIISTL(text) {
  // Slow but correct fallback. ~5-15 MB/s — fine for typical ASCII STLs (<50MB).
  const vertexRe = /vertex\s+(-?\d+\.?\d*(?:[eE][-+]?\d+)?)\s+(-?\d+\.?\d*(?:[eE][-+]?\d+)?)\s+(-?\d+\.?\d*(?:[eE][-+]?\d+)?)/g;
  const verts = [];
  let m;
  while ((m = vertexRe.exec(text)) !== null) {
    verts.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
  }
  if (verts.length % 3 !== 0) throw new Error('ASCII STL: vertex count not a multiple of 3');
  const tris = verts.length / 3;
  let vol = 0, minX=Infinity, minY=Infinity, minZ=Infinity, maxX=-Infinity, maxY=-Infinity, maxZ=-Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    const [a, b, c] = [verts[i], verts[i+1], verts[i+2]];
    vol += (
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0])
    ) / 6;
    for (const v of [a, b, c]) {
      if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
      if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
      if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2];
    }
  }
  const volAbs = Math.abs(vol);
  return {
    triangles: tris,
    volumeMm3: volAbs,
    volumeCm3: volAbs / 1000,
    bbox: { x: maxX-minX, y: maxY-minY, z: maxZ-minZ, min:[minX,minY,minZ], max:[maxX,maxY,maxZ] },
  };
}

async function parseSTLFile(file) {
  const buf = await file.arrayBuffer();
  let geom;
  try {
    geom = parseBinarySTL(buf);
  } catch (eBin) {
    // Maybe ASCII — try a quick text decode
    try {
      const text = new TextDecoder().decode(new Uint8Array(buf));
      if (!/facet\s+normal/i.test(text)) throw eBin;
      geom = parseASCIISTL(text);
    } catch (eAsc) {
      throw new Error(`Couldn't parse STL. ${eBin.message}`);
    }
  }
  return { buf, geom };
}

// ════════════════════════════════════════════════════════════════════
// QUOTE MODEL
// ────────────────────────────────────────────────────────────────────
// Filament used (grams) for a part:
//   shells: 4 perimeters × layer_height × perimeter_length
//   infill: percentage of internal volume
//   top/bottom: 4 layers × layer_height × (top_area)
// We approximate perimeter from the bounding-box surface:
//   perimeter ≈ 4 * (bbox.x + bbox.y) * 2 → just use a fixed effective
//   perimeter length scaled by sqrt(volume).
//
// Calibration constants derived from FOFUS production prints on a
// sample of test parts (256³ engineering chamber, 0.28 mm resolution, generic PLA profile):
//   effective_shell_volume_cm3 = kShell * volumeCm3^0.66
//   effective_topbottom_cm3   = kTopBot * (bbox.x*bbox.y) / 100 * layerCount
function computeQuote() {
  if (!state.geometry) return null;
  const g = state.geometry;
  const prn = PRINTERS[state.printer];
  const mat = MATERIALS[state.material];
  const lh  = state.layerHeight;

  // 1. Shell volume (walls). Empirical: ~kShell * V^0.66 for typical parts.
  const kShell = 0.85;
  const shellVolCm3 = kShell * Math.pow(g.volumeCm3, 0.66);

  // 2. Top + bottom skin volume. Layer count for top+bottom = 8 (4 top + 4 bottom)
  //    Area approximated as sqrt(V) for irregular parts, capped by top face.
  const topBotLayers = 8;
  const topAreaCm2 = Math.min(
    (g.bbox.x/10) * (g.bbox.y/10),
    Math.pow(g.volumeCm3, 2/3)
  );
  const topBotVolCm3 = topAreaCm2 * lh * topBotLayers / 10; // cm² × cm = cm³

  // 3. Infill volume
  const infillVolCm3 = Math.max(0, g.volumeCm3 - shellVolCm3 - topBotVolCm3) * (state.infill / 100);

  // 4. Support material estimate (only if auto)
  //    Typical support adds 8-15% of part volume for moderately complex parts.
  const supportFactor = state.supports === 'auto' ? 0.10 : 0.0;
  const supportVolCm3 = g.volumeCm3 * supportFactor;

  // 5. Total filament volume + weight
  const totalFilamentCm3 = shellVolCm3 + topBotVolCm3 + infillVolCm3 + supportVolCm3;
  const weightG = totalFilamentCm3 * mat.densityGcm3;

  // 6. Print time. Empirical model:
  //    base print speed scaled by layer height & material speed
  //    overhead = setup + travel (~3-8 min baseline + 0.5 min per 100 g filament)
  const effRate = (lh / 0.20) * 12 * mat.speed;  // cm³/min — empirically tuned to 0.20 baseline
  const printMinutes = totalFilamentCm3 / effRate;
  const overheadMinutes = 4 + (weightG / 100) * 1.2;
  const totalMinutes = printMinutes + overheadMinutes;
  const totalHours = totalMinutes / 60;

  // 7. Cost
  const materialCost = weightG * mat.ratePerG;
  const machineCost = totalHours * prn.ratePerHr;
  const subtotal = materialCost + machineCost;
  const serviceFee = subtotal * SERVICE_FEE_RATIO;
  const total = subtotal + serviceFee;

  return {
    weightG, totalHours, totalMinutes,
    materialCost, machineCost, serviceFee, total,
    breakdown: { shellVolCm3, topBotVolCm3, infillVolCm3, supportVolCm3, totalFilamentCm3 },
  };
}

// ════════════════════════════════════════════════════════════════════
// RENDER
// ════════════════════════════════════════════════════════════════════
const fmt = {
  inr(n)  { return '₹' + Math.round(n).toLocaleString('en-IN'); },
  inrPrecise(n) { return '₹' + n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ','); },
  hrs(min) {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  },
  mm(v) { return `${v.toFixed(1)} mm`; },
  cm3(v) { return `${v.toFixed(2)} cm³`; },
};

function renderQuote() {
  if (!state.geometry) {
    document.getElementById('empty-state').hidden = false;
    document.getElementById('quote-body').hidden = true;
    return;
  }
  const q = computeQuote();
  if (!q) return;
  state.quote = q;
  const g = state.geometry;
  const prn = PRINTERS[state.printer];
  const mat = MATERIALS[state.material];

  document.getElementById('empty-state').hidden = true;
  document.getElementById('quote-body').hidden = false;

  document.getElementById('q-time').textContent = fmt.hrs(q.totalMinutes);
  document.getElementById('q-weight').textContent = `${q.weightG.toFixed(1)} g`;
  document.getElementById('q-mat-label').textContent = `Material (${mat.name} · ${state.infill}% infill)`;
  document.getElementById('q-mat-cost').textContent = fmt.inr(q.materialCost);
  document.getElementById('q-mach-label').textContent = `Build chamber (${prn.buildMm}³)`;
  document.getElementById('q-mach-cost').textContent = fmt.inr(q.machineCost);
  document.getElementById('q-service').textContent = fmt.inr(q.serviceFee);
  document.getElementById('q-total').textContent = fmt.inr(q.total);

  // Show contact form once quote is ready
  document.getElementById('contact-form').hidden = false;

  // Build-volume fit check (axis-aligned; real check needs OBB rotation)
  const b = g.bbox;
  const fitWarn = document.getElementById('fit-warn');
  const oversize = (b.x > prn.buildMm) || (b.y > prn.buildMm) || (b.z > prn.buildMm);
  fitWarn.hidden = !oversize;
}

// Collect customer contact details from the form
function getContact() {
  const name = document.getElementById('c-name')?.value.trim() || '';
  const phone = document.getElementById('c-phone')?.value.trim() || '';
  const email = document.getElementById('c-email')?.value.trim() || '';
  const pincode = document.getElementById('c-pincode')?.value.trim() || '';
  const notes = document.getElementById('c-notes')?.value.trim() || '';
  return { name, phone, email, pincode, notes };
}

function validateContact(c) {
  if (!c.name) return 'Please enter your name.';
  if (!c.phone || c.phone.length < 10) return 'Please enter a valid phone number.';
  if (!c.pincode || c.pincode.length < 6) return 'Please enter a valid pincode.';
  return null;
}

// ════════════════════════════════════════════════════════════════════
// FILE HANDLING
// ════════════════════════════════════════════════════════════════════
async function handleFile(file) {
  if (!file) return;
  // 100 MB cap
  if (file.size > 100 * 1024 * 1024) {
    setNote('File too large (max 100 MB).', 'err'); return;
  }
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!['stl','obj','3mf'].includes(ext)) {
    setNote(`Unsupported file type: .${ext}. Use STL, OBJ, or 3MF.`, 'err'); return;
  }

  setNote(`Parsing ${file.name}…`);
  try {
    let geom;
    if (ext === 'stl') {
      const r = await parseSTLFile(file);
      geom = r.geom;
      state.fileBuf = r.buf;
    } else {
      // OBJ / 3MF: geometry-only analysis needs the server. We compute
      // bounding box from the file's extent metadata if present (3MF),
      // otherwise request a server-side analysis.
      setNote(`${ext.toUpperCase()} analysis needs the server. Pick an STL for instant in-browser quoting, or click Request Printing to start a server-side analysis.`);
      state.file = file;
      // Update stats placeholders so user sees something happened
      document.getElementById('dz-filename').textContent = file.name;
      document.getElementById('dz-filesize').textContent = `${(file.size/1024/1024).toFixed(2)} MB`;
      document.getElementById('dz-file').hidden = false;
      return;
    }
    state.file = file;
    state.geometry = geom;

    document.getElementById('dz-filename').textContent = file.name;
    document.getElementById('dz-filesize').textContent = `${(file.size/1024/1024).toFixed(2)} MB`;
    document.getElementById('dz-file').hidden = false;
    document.getElementById('model-stats').hidden = false;
    document.getElementById('stat-volume').textContent = fmt.cm3(geom.volumeCm3);
    document.getElementById('stat-bbox').textContent = `${geom.bbox.x.toFixed(1)} × ${geom.bbox.y.toFixed(1)} × ${geom.bbox.z.toFixed(1)} mm`;
    document.getElementById('stat-tris').textContent = geom.triangles.toLocaleString('en-IN');

    setNote(`Parsed ${geom.triangles.toLocaleString('en-IN')} triangles.`, 'ok');
    renderQuote();
  } catch (e) {
    setNote(`Parse error: ${e.message}`, 'err');
  }
}

function setNote(text, kind='') {
  const el = document.getElementById('quote-note');
  el.textContent = text;
  el.className = 'quote-note' + (kind ? ' ' + kind : '');
  el.hidden = false;
}

// ════════════════════════════════════════════════════════════════════
// PDF QUOTE
// ════════════════════════════════════════════════════════════════════
function downloadQuotePDF() {
  if (!state.quote || !state.geometry) return;
  const q = state.quote;
  const g = state.geometry;
  const prn = PRINTERS[state.printer];
  const mat = MATERIALS[state.material];

  // Build a printable HTML doc, open in new window, print → user saves as PDF.
  // This avoids a 200KB jsPDF dep and renders perfectly.
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>FOFUS Quote</title>
<style>
  body{font-family:Georgia,serif;color:#080807;background:#fff;padding:40px;max-width:680px;margin:0 auto}
  .h{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #C9A063;padding-bottom:14px;margin-bottom:24px}
  .logo{font-size:28px;letter-spacing:.16em;color:#C9A063}
  .tag{font-size:10px;color:#524E46;letter-spacing:.18em;text-transform:uppercase}
  h1{font-size:42px;font-weight:300;margin:0 0 4px}
  h1 em{font-style:italic;color:#C9A063}
  .meta{font-size:12px;color:#524E46;margin-bottom:24px}
  table{width:100%;border-collapse:collapse;margin:20px 0}
  th,td{padding:10px 0;border-bottom:1px solid #E5E0D8;text-align:left;font-size:13px}
  th{font-size:10px;letter-spacing:.16em;color:#524E46;text-transform:uppercase;font-weight:500}
  td:last-child{text-align:right;font-family:'Courier New',monospace}
  .total{margin-top:24px;padding:20px;background:#FAF6EE;border-left:3px solid #C9A063}
  .total-row{display:flex;justify-content:space-between;align-items:baseline}
  .total-label{font-size:11px;letter-spacing:.18em;color:#C9A063;text-transform:uppercase}
  .total-val{font-size:42px;color:#C9A063;font-weight:300}
  .note{font-size:11px;color:#524E46;margin-top:20px;line-height:1.6;border-top:1px solid #E5E0D8;padding-top:14px}
  @media print{body{padding:20px}.total{background:#fff}}
</style></head><body>
<div class="h">
  <div><div class="logo">FOFUS</div><div class="tag">3D Manufacturing · Kerala</div></div>
  <div style="text-align:right">
    <div style="font-size:11px;color:#524E46">Quote</div>
    <div style="font-size:18px;font-family:monospace">${Date.now().toString(36).toUpperCase()}</div>
  </div>
</div>
<h1>Your <em>3D printing</em> quote</h1>
<div class="meta">
  File: <b>${state.file?.name || '—'}</b> &middot;
  ${g.triangles.toLocaleString('en-IN')} triangles &middot;
  ${g.volumeCm3.toFixed(2)} cm³ &middot;
  Bounding box ${g.bbox.x.toFixed(1)} × ${g.bbox.y.toFixed(1)} × ${g.bbox.z.toFixed(1)} mm<br>
  ${new Date().toLocaleString('en-IN', {dateStyle:'long', timeStyle:'short'})}
</div>

<table>
  <tr><th>Build chamber</th><td>${prn.name} (${prn.buildMm}³ build)</td></tr>
  <tr><th>Material</th><td>${mat.name}</td></tr>
  <tr><th>Infill</th><td>${state.infill}%</td></tr>
  <tr><th>Resolution</th><td>${state.layerHeight} mm</td></tr>
  <tr><th>Supports</th><td>${state.supports === 'auto' ? 'Auto-generated' : 'None'}</td></tr>
  <tr><th>Print time</th><td>${fmt.hrs(q.totalMinutes)}</td></tr>
  <tr><th>Weight</th><td>${q.weightG.toFixed(1)} g</td></tr>
</table>

<table>
  <tr><th>Material cost</th><td>${fmt.inr(q.materialCost)}</td></tr>
  <tr><th>Machine time (${prn.buildMm}³ chamber)</th><td>${fmt.inr(q.machineCost)}</td></tr>
  <tr><th>Service fee (${(SERVICE_FEE_RATIO*100)}%)</th><td>${fmt.inr(q.serviceFee)}</td></tr>
</table>

<div class="total">
  <div class="total-row">
    <span class="total-label">Total</span>
    <span class="total-val">${fmt.inr(q.total)}</span>
  </div>
</div>

<div class="note">
  Quote is indicative and valid for 7 days. Final price confirmed after our backend
  re-slices your file with the FOFUS production engine for the selected build chamber. GST extra as applicable.
  Pickup at Irinjalakuda, Thrissur · pan-India shipping available.
  <br><br>FOFUS · hello@fofus.in · <a href="https://fofus.in">fofus.in</a>
</div>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) { setNote('Popup blocked — allow popups to download PDF.', 'err'); return; }
  w.document.write(html);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 400);
}

// ════════════════════════════════════════════════════════════════════
// REQUEST PRINTING → backend
// ════════════════════════════════════════════════════════════════════
async function requestPrinting() {
  if (!state.quote || !state.file) {
    setNote('Upload a file and wait for a quote first.', 'err'); return;
  }
  const contact = getContact();
  const err = validateContact(contact);
  if (err) { setNote(err, 'err'); return; }

  const q = state.quote;
  const g = state.geometry;
  const prn = PRINTERS[state.printer];
  const mat = MATERIALS[state.material];

  const payload = {
    file_name: state.file.name,
    file_size: state.file.size,
    file_base64: state.fileBuf ? _arrayBufferToBase64(state.fileBuf) : null,
    geometry: g,
    printer: state.printer,
    printer_name: prn.name,
    material: state.material,
    material_name: mat.name,
    infill: state.infill,
    layer_height: state.layerHeight,
    supports: state.supports,
    quote: {
      weight_g: q.weightG,
      hours: q.totalHours,
      minutes: q.totalMinutes,
      material_cost: q.materialCost,
      machine_cost: q.machineCost,
      service_fee: q.serviceFee,
      total: q.total,
      total_inr: q.total,
    },
    contact,
    notes: contact.notes || '',
    requested_at: new Date().toISOString(),
  };

  setNote('Sending to print queue…');
  try {
    const r = await fetch(`${API_BASE}/api/print-jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`Backend returned ${r.status}`);
    const data = await r.json();
    const jobId = data.job_id;

    // Trigger server-side final production slice
    setNote('Quote saved. Running final production slice for the confirmed price…');
    await fetch(`${API_BASE}/api/print-jobs/${jobId}/slice`, { method: 'POST' });

    // Poll until slicing is done
    pollJobForPayment(jobId, contact, q.total);
  } catch (e) {
    fallbackToMailto(contact, q, prn, mat);
  }
}

/*
   Server-side slicing may fail for exotic geometry. Fall back to the
   instant estimate so we never lose a ready-to-buy customer.
*/
async function pollJobForPayment(jobId, contact, clientTotal) {
  const btn = document.getElementById('request-print');
  btn.disabled = true;
  btn.textContent = 'Finalising quote…';

  let attempts = 0;
  const maxAttempts = 60; // ~5 minutes
  const timer = setInterval(async () => {
    attempts++;
    try {
      const r = await fetch(`${API_BASE}/api/print-jobs/${jobId}`);
      if (!r.ok) return;
      const job = await r.json();
      state.jobStatus = job.status;

      if (job.status === 'sliced') {
        clearInterval(timer);
        btn.disabled = false;
        btn.textContent = 'Pay & confirm printing';
        setNote('Final quote ready. Click "Pay & confirm printing" to complete your order.', 'ok');
        return;
      }

      if (job.status === 'slice_failed') {
        clearInterval(timer);
        btn.disabled = false;
        btn.textContent = 'Pay & confirm printing';
        setNote('Final production slice could not refine the quote, but we can still accept your order using the instant estimate.', 'ok');
        return;
      }

      if (attempts >= maxAttempts) {
        clearInterval(timer);
        btn.disabled = false;
        btn.textContent = 'Pay & confirm printing';
        setNote('Slicing is taking longer than usual. Continue with the instant estimate?', 'ok');
      }
    } catch (e) {
      // ignore polling errors, keep trying
    }
  }, 5000);
}

async function createCheckout(jobId, fallbackTotal) {
  const contact = getContact();
  const err = validateContact(contact);
  if (err) { setNote(err, 'err'); return; }

  setNote('Creating Shopify checkout…');
  try {
    const r = await fetch(`${API_BASE}/api/print-jobs/${jobId}/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contact }),
    });
    if (!r.ok) throw new Error(`Backend returned ${r.status}`);
    const data = await r.json();
    setNote('Redirecting to secure payment…', 'ok');
    window.location.href = data.checkout_url;
  } catch (e) {
    setNote(`Checkout failed: ${e.message}. We'll email you a payment link instead.`, 'err');
  }
}

function fallbackToMailto(contact, q, prn, mat) {
  const subject = encodeURIComponent(`FOFUS 3D print job — ${state.file.name}`);
  const body = encodeURIComponent(
    `Hi FOFUS,\n\nI'd like to proceed with the quote on your site.\n\n` +
    `File: ${state.file.name} (${(state.file.size/1024/1024).toFixed(2)} MB)\n` +
    `Printer: ${prn.name}\nMaterial: ${mat.name}\n` +
    `Infill: ${state.infill}%  Layer: ${state.layerHeight} mm  Supports: ${state.supports}\n\n` +
    `Quote (instant estimate):\n` +
    `  Print time: ${fmt.hrs(q.totalMinutes)}\n` +
    `  Weight: ${q.weightG.toFixed(1)} g\n` +
    `  Total: ${fmt.inr(q.total)}\n\n` +
    `Name: ${contact.name}\nPhone: ${contact.phone}\nEmail: ${contact.email || ''}\nPincode: ${contact.pincode}\nNotes: ${contact.notes || ''}\n\nThanks!`
  );
  setNote(`Couldn't reach the print queue backend. Email us instead — link opened with your quote pre-filled.`, 'err');
  window.location.href = `mailto:hello@fofus.in?subject=${subject}&body=${body}`;
}

function _arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// ════════════════════════════════════════════════════════════════════
// WIRE UP
// ════════════════════════════════════════════════════════════════════
function pickGroup(containerId, onPick) {
  const el = document.getElementById(containerId);
  el.addEventListener('click', e => {
    const btn = e.target.closest('.pick');
    if (!btn) return;
    el.querySelectorAll('.pick').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    onPick(btn);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // File input + drag-and-drop
  const dz = document.getElementById('dropzone');
  const input = document.getElementById('stl-input');
  input.addEventListener('change', e => handleFile(e.target.files[0]));
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });

  // Picker groups
  pickGroup('printer-picker', btn => {
    state.printer = btn.dataset.printer;
    renderQuote();
  });
  pickGroup('material-picker', btn => {
    state.material = btn.dataset.mat;
    renderQuote();
  });
  pickGroup('layer-picker', btn => {
    state.layerHeight = parseFloat(btn.dataset.lh);
    renderQuote();
  });
  pickGroup('supports-picker', btn => {
    state.supports = btn.dataset.sp;
    renderQuote();
  });

  // Slider
  document.getElementById('infill').addEventListener('input', e => {
    state.infill = parseInt(e.target.value, 10);
    document.getElementById('infill-val').textContent = `${state.infill}%`;
    renderQuote();
  });

  // Actions
  document.getElementById('download-quote').addEventListener('click', downloadQuotePDF);
  document.getElementById('request-print').addEventListener('click', () => {
    if (state.jobId && (state.jobStatus === 'sliced' || state.jobStatus === 'slice_failed' || state.jobStatus === 'awaiting_payment')) {
      createCheckout(state.jobId, state.quote?.total || 0);
    } else {
      requestPrinting();
    }
  });

  // Theme toggle — dark/light mode
  const themeToggle = document.getElementById('theme-toggle');
  // Restore saved theme or default to dark
  const savedTheme = localStorage.getItem('fofus-quote-theme');
  if (savedTheme) {
    document.documentElement.setAttribute('data-theme', savedTheme);
  }
  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('fofus-quote-theme', next);
  });
});
