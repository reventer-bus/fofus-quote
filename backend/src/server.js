// ════════════════════════════════════════════════════════════════════
// FOFUS Quote — backend
//   POST /api/print-jobs         queue a print (re-slices with OrcaSlicer)
//   GET  /api/print-jobs/:id     fetch one job (incl. final quote + gcode URL)
//   GET  /api/print-jobs         list jobs (admin — gated by X-Admin-Token)
//   GET  /api/health             liveness probe
//   GET  /api/slicer/check       verify OrcaSlicer CLI is callable
// ────────────────────────────────────────────────────────────────────
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';

import { initDb, createJob, getJob, listJobs, updateJob } from './db.js';
import { sliceWithOrca, slicerHealth } from './slicer.js';
import { buildFinalQuote, parseGcodeFooter } from './quote.js';
import { createCheckoutFromJob } from './shopify.js';
import { notifyNewQuote } from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const UPLOADS_DIR = path.resolve(DATA_DIR, 'uploads');
const SLICED_DIR = path.resolve(DATA_DIR, 'sliced');

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(UPLOADS_DIR, { recursive: true });
await fs.mkdir(SLICED_DIR, { recursive: true });

const db = initDb(path.join(DATA_DIR, 'jobs.db'));

const app = express();
app.use(cors({ origin: '*' }));              // Vercel frontend → Railway backend
app.use(express.json({ limit: '110mb' }));   // 100 MB STL cap + headroom
app.use(express.urlencoded({ extended: true, limit: '110mb' }));

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

// ── Health ──────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({
  status: 'ok',
  service: 'fofus-quote-backend',
  version: '0.1.0',
  time: new Date().toISOString(),
}));

// ── Serve frontend static files ─────────────────────────────────────
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND_DIR));

// ── Explicit SEO / crawlability files (must not be swallowed by catch-all SPA route) ──
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').sendFile(path.join(FRONTEND_DIR, 'robots.txt'));
});
app.get('/sitemap.xml', (_req, res) => {
  res.type('application/xml').sendFile(path.join(FRONTEND_DIR, 'sitemap.xml'));
});

// ── Root → frontend index.html ──────────────────────────────────────
app.get('/', (_req, res) => {
  const indexFile = path.join(FRONTEND_DIR, 'index.html');
  res.sendFile(indexFile, (err) => {
    if (err) {
      res.json({
        service: 'fofus-quote-backend',
        version: '0.1.0',
        docs: 'https://github.com/reventer-bus/fofus-quote',
      });
    }
  });
});

// ── Slicer health ───────────────────────────────────────────────────
app.get('/api/slicer/check', async (_req, res) => {
  const h = await slicerHealth();
  res.json(h);
});

// ── Submit print job (multipart upload) ─────────────────────────────
app.post('/api/print-jobs/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const jobId = uuidv4();
    const ext = path.extname(req.file.originalname).toLowerCase() || '.stl';

    // Move upload to per-job dir
    const jobDir = path.join(UPLOADS_DIR, jobId);
    await fs.mkdir(jobDir, { recursive: true });
    const storedPath = path.join(jobDir, `model${ext}`);
    await fs.rename(req.file.path, storedPath);

    const meta = {
      file_name: req.file.originalname,
      file_size: req.file.size,
      printer: req.body.printer || 'x1c',
      material: req.body.material || 'pla',
      infill: parseInt(req.body.infill || '20', 10),
      layer_height: parseFloat(req.body.layer_height || '0.28'),
      supports: req.body.supports || 'auto',
      contact_name: req.body.name || null,
      contact_email: req.body.email || null,
      contact_phone: req.body.phone || null,
      pincode: req.body.pincode || null,
      notes: req.body.notes || null,
      // Browser pre-quote (we'll recompute server-side for accuracy)
      client_quote: req.body.client_quote ? JSON.parse(req.body.client_quote) : null,
    };

    createJob(db, {
      id: jobId,
      status: 'queued',
      stored_path: storedPath,
      ...meta,
    });

    res.json({ job_id: jobId, status: 'queued' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Submit print job (JSON, file sent as base64) ────────────────────
app.post('/api/print-jobs', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.file_base64) return res.status(400).json({ error: 'file_base64 required' });
    if (!body.file_name)   return res.status(400).json({ error: 'file_name required' });

    const jobId = uuidv4();
    const ext = (path.extname(body.file_name) || '.stl').toLowerCase();
    const jobDir = path.join(UPLOADS_DIR, jobId);
    await fs.mkdir(jobDir, { recursive: true });
    const storedPath = path.join(jobDir, `model${ext}`);

    const buf = Buffer.from(body.file_base64, 'base64');
    await fs.writeFile(storedPath, buf);

    createJob(db, {
      id: jobId,
      status: 'queued',
      stored_path: storedPath,
      file_name: body.file_name,
      file_size: body.file_size || buf.length,
      printer: body.printer || 'x1c',
      material: body.material || 'pla',
      infill: body.infill ?? 20,
      layer_height: body.layer_height ?? 0.28,
      supports: body.supports || 'auto',
      client_quote: body.quote || null,
      contact_name: body.contact?.name || null,
      contact_email: body.contact?.email || null,
      contact_phone: body.contact?.phone || null,
      pincode: body.contact?.pincode || null,
      notes: body.notes || null,
    });

    res.json({ job_id: jobId, status: 'queued' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Re-slice a queued job with OrcaSlicer ───────────────────────────
app.post('/api/print-jobs/:id/slice', async (req, res) => {
  const job = getJob(db, req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  if (job.status === 'slicing') return res.status(409).json({ error: 'already slicing' });

  updateJob(db, job.id, { status: 'slicing' });
  res.json({ job_id: job.id, status: 'slicing' });

  // Slice in background
  (async () => {
    try {
      const result = await sliceWithOrca({
        inputPath: job.stored_path,
        outputDir: path.join(SLICED_DIR, job.id),
        printer: job.printer,
        material: job.material,
        infill: job.infill,
        layerHeight: job.layer_height,
        supports: job.supports,
      });

      // Pull final weight/time from the slicing output (G-code metadata)
      const slicerStats = result.ok ? await parseGcodeFooter(result.gcodePath) : { weightG: null, minutes: null };
      const finalQuote = buildFinalQuote({
        slicerResult: slicerStats,
        clientQuote: job.client_quote,
        material: job.material,
        printer: job.printer,
      });

      updateJob(db, job.id, {
        status: result.ok ? 'sliced' : 'slice_failed',
        gcode_path: result.ok ? result.gcodePath : null,
        slice_log: result.log,
        final_quote: finalQuote,
        sliced_at: new Date().toISOString(),
      });
    } catch (e) {
      console.error('slice failed', e);
      updateJob(db, job.id, {
        status: 'slice_failed',
        slice_log: e.message,
      });
    }
  })();
});

// ── Get a job ───────────────────────────────────────────────────────
app.get('/api/print-jobs/:id', (req, res) => {
  const job = getJob(db, req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job);
});

// ── List jobs (admin) ───────────────────────────────────────────────
app.get('/api/print-jobs', (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && req.header('x-admin-token') !== adminToken) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.json(listJobs(db, { limit: parseInt(req.query.limit || '50', 10) }));
});

// ── Download sliced gcode (or original file) ────────────────────────
app.get('/api/print-jobs/:id/file', async (req, res) => {
  const job = getJob(db, req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const kind = req.query.kind || 'gcode';
  const filePath = kind === 'original' ? job.stored_path : job.gcode_path;
  if (!filePath) return res.status(404).json({ error: `${kind} not available` });
  res.download(filePath);
});

// ── Forward accepted quote to Shopify draft order ───────────────────
app.post('/api/print-jobs/:id/checkout', async (req, res) => {
  const job = getJob(db, req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });

  // Update contact details if provided
  const contact = req.body.contact || {};
  if (contact.name || contact.phone || contact.pincode || contact.email || contact.notes) {
    updateJob(db, job.id, {
      contact_name: contact.name || job.contact_name,
      contact_phone: contact.phone || job.contact_phone,
      contact_email: contact.email || job.contact_email,
      pincode: contact.pincode || job.pincode,
      notes: contact.notes || job.notes,
    });
    Object.assign(job, {
      contact_name: contact.name || job.contact_name,
      contact_phone: contact.phone || job.contact_phone,
      contact_email: contact.email || job.contact_email,
      pincode: contact.pincode || job.pincode,
      notes: contact.notes || job.notes,
    });
  }

  // Validate minimum contact info
  if (!job.contact_name || !job.contact_phone || !job.pincode) {
    return res.status(400).json({ error: 'name, phone and pincode are required' });
  }

  const quote = job.final_quote || job.client_quote || {};
  const total = Math.round(quote.total_inr || quote.total || 0);
  if (!total || total < 50) {
    return res.status(400).json({ error: 'quote total missing or too low' });
  }

  try {
    const checkout = await createCheckoutFromJob(job);
    updateJob(db, job.id, {
      status: 'awaiting_payment',
      shopify_product_id: checkout.product_id,
      shopify_variant_id: checkout.variant_id,
      shopify_invoice_url: checkout.checkout_url,
      notes: (job.notes || '') + `\nShopify product: ${checkout.product_id}`,
    });

    // Notify operations team
    notifyNewQuote(job).catch(e => console.error('notify failed', e));

    res.json({
      job_id: job.id,
      status: 'awaiting_payment',
      checkout_url: checkout.checkout_url,
      product_id: checkout.product_id,
      variant_id: checkout.variant_id,
    });
  } catch (e) {
    console.error('Shopify checkout creation failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Forward accepted quote to PrintDash (creates an order) ──────────
app.post('/api/print-jobs/:id/forward', async (req, res) => {
  const job = getJob(db, req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  if (job.status !== 'sliced') return res.status(400).json({ error: 'job must be sliced first' });

  const quote = job.final_quote || job.client_quote;
  if (!quote) return res.status(400).json({ error: 'no quote available' });

  const PRINTDASH_BASE = process.env.PRINTDASH_BASE || 'https://printdash-production.up.railway.app';
  const PRINTDASH_API_KEY = process.env.PRINTDASH_API_KEY || '';

  try {
    const orderReq = {
      customer_name: job.contact_name || 'Unknown',
      customer_phone: job.contact_phone || '',
      customer_email: job.contact_email || '',
      product_name: job.file_name || 'Custom 3D Print',
      material: (job.material || 'pla').toUpperCase(),
      weight_g: quote.weight_g || 0,
      print_time_min: quote.minutes || 0,
      machine: job.printer === 'a1' ? 'ALA-Standard' : job.printer === 'x1c' ? 'ALA-Engineering' : 'ALA-Standard',
      total_inr: quote.total_inr || 0,
      model_file_path: job.gcode_path || job.stored_path || '',
      notes: `From fofus-quote job ${job.id}. G-code: ${job.gcode_path ? 'yes' : 'no'}`,
      source: 'fofus-quote',
    };

    const headers = { 'Content-Type': 'application/json' };
    if (PRINTDASH_API_KEY) headers['X-API-Key'] = PRINTDASH_API_KEY;

    const resp = await fetch(`${PRINTDASH_BASE}/api/v1/orders/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify(orderReq),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('PrintDash order creation failed:', resp.status, errText);
      return res.status(502).json({ error: `PrintDash returned ${resp.status}`, detail: errText.slice(0, 500) });
    }

    const result = await resp.json();
    updateJob(db, job.id, { status: 'forwarded', notes: `PrintDash order: ${result.order_id}` });
    res.json({ job_id: job.id, status: 'forwarded', printdash_order_id: result.order_id });
  } catch (e) {
    console.error('Forward to PrintDash failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Start ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FOFUS Quote backend listening on :${PORT}`);
  console.log(`  data dir: ${DATA_DIR}`);
  console.log(`  uploads:  ${UPLOADS_DIR}`);
  console.log(`  sliced:   ${SLICED_DIR}`);
});
