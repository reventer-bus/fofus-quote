// SQLite job queue — single file, no migrations needed for v1.
import Database from 'better-sqlite3';

export function initDb(filePath) {
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id              TEXT PRIMARY KEY,
      status          TEXT NOT NULL DEFAULT 'queued',
      -- file
      file_name       TEXT,
      file_size       INTEGER,
      stored_path     TEXT NOT NULL,
      gcode_path      TEXT,
      -- settings
      printer         TEXT,
      material        TEXT,
      infill          INTEGER,
      layer_height    REAL,
      supports        TEXT,
      -- quotes
      client_quote    TEXT,    -- JSON
      final_quote     TEXT,    -- JSON (server-computed after slicing)
      -- contact
      contact_name    TEXT,
      contact_email   TEXT,
      contact_phone   TEXT,
      pincode         TEXT,
      notes           TEXT,
      -- audit
      slice_log       TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      sliced_at       TEXT,
      -- shopify integration
      shopify_draft_order_id TEXT,
      shopify_product_id    TEXT,
      shopify_variant_id    TEXT,
      shopify_invoice_url    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON print_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON print_jobs(created_at DESC);
  `);

  // Migrations: add columns that were introduced after v1
  try { db.exec(`ALTER TABLE print_jobs ADD COLUMN shopify_draft_order_id TEXT`); } catch {}
  try { db.exec(`ALTER TABLE print_jobs ADD COLUMN shopify_product_id    TEXT`); } catch {}
  try { db.exec(`ALTER TABLE print_jobs ADD COLUMN shopify_variant_id    TEXT`); } catch {}
  try { db.exec(`ALTER TABLE print_jobs ADD COLUMN shopify_invoice_url    TEXT`); } catch {}

  return db;
}

export function createJob(db, job) {
  const stmt = db.prepare(`
    INSERT INTO print_jobs (
      id, status, stored_path,
      file_name, file_size,
      printer, material, infill, layer_height, supports,
      client_quote,
      contact_name, contact_email, contact_phone, pincode, notes
    ) VALUES (
      @id, @status, @stored_path,
      @file_name, @file_size,
      @printer, @material, @infill, @layer_height, @supports,
      @client_quote,
      @contact_name, @contact_email, @contact_phone, @pincode, @notes
    )
  `);
  // Spread FIRST, then overwrite client_quote so the JSON-stringified version wins.
  stmt.run({
    ...job,
    client_quote: job.client_quote ? JSON.stringify(job.client_quote) : null,
  });
}

export function getJob(db, id) {
  const row = db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(id);
  if (!row) return null;
  // JSON-stringify the JSON columns back to objects
  for (const k of ['client_quote', 'final_quote']) {
    if (row[k] && typeof row[k] === 'string') {
      try { row[k] = JSON.parse(row[k]); } catch {}
    }
  }
  return row;
}

export function listJobs(db, { limit = 50, status } = {}) {
  let sql = 'SELECT * FROM print_jobs';
  const args = [];
  if (status) { sql += ' WHERE status = ?'; args.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ?'; args.push(limit);
  const rows = db.prepare(sql).all(...args);
  for (const row of rows) {
    for (const k of ['client_quote', 'final_quote']) {
      if (row[k] && typeof row[k] === 'string') {
        try { row[k] = JSON.parse(row[k]); } catch {}
      }
    }
  }
  return rows;
}

export function updateJob(db, id, patch) {
  const allowed = [
    'status','gcode_path','slice_log','sliced_at','final_quote',
    'contact_name','contact_email','contact_phone','pincode','notes',
    'shopify_draft_order_id','shopify_product_id','shopify_variant_id','shopify_invoice_url',
  ];
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    args.push(k === 'final_quote' && v && typeof v !== 'string' ? JSON.stringify(v) : v);
  }
  if (!sets.length) return 0;
  args.push(id);
  return db.prepare(`UPDATE print_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...args).changes;
}
