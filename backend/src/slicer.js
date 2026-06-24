// ════════════════════════════════════════════════════════════════════
// Slicer wrapper around OrcaSlicer CLI
// ────────────────────────────────────────────────────────────────────
// On Windows (dev): uses bundled orca-slicer.exe at C:/Program Files/OrcaSlicer
// On Linux (Railway): the Dockerfile installs the AppImage to /usr/local/bin
//
// OrcaSlicer CLI:
//   orca-slicer --slice 0
//     --load-settings <machine+process.json>
//     --load-filaments <filament.json>
//     --outputdir <dir>
//     <input.stl>
//
// IMPORTANT: profile JSON files in BambuStudio/OrcaSlicer are "User"
// overrides — they inherit ("fdm_bbl_3dp_001_common" for machine, etc.)
// from system profiles bundled INSIDE the OrcaSlicer binary. As long as
// we pass the User JSON, OrcaSlicer resolves the full effective profile
// on its own. We don't need to ship the full system profile set.
// ════════════════════════════════════════════════════════════════════
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = process.env.PROFILES_DIR || path.resolve(__dirname, '..', 'profiles');

const SLICER_BIN = process.env.SLICER_BIN || (
  process.platform === 'win32'
    ? 'C:\\Program Files\\OrcaSlicer\\orca-slicer.exe'
    : '/usr/local/bin/orca-slicer'
);

// ── Profile resolution ──────────────────────────────────────────────
// Map our simple printer/material keys to actual User-profile filenames
// shipped in profiles/{machine,filament}/. Override by setting env vars.
function profilePath(kind, name) {
  return path.join(PROFILES_DIR, kind, `${name}.json`);
}

const PRINTER_PROFILE = {
  a1:    process.env.PRINTER_PROFILE_A1   || 'Bambu Lab A1 0.4 nozzle',
  x1c:   process.env.PRINTER_PROFILE_X1C  || 'Bambu Lab X1 Carbon 0.4 nozzle',
  k1max: process.env.PRINTER_PROFILE_K1MAX|| 'Creality K1 Max 0.4 nozzle',
};
const FILAMENT_PROFILE = {
  pla:  process.env.FILAMENT_PROFILE_PLA  || 'Generic PLA @BBL A1',
  petg: process.env.FILAMENT_PROFILE_PETG || 'Generic PETG @BBL A1',
  abs:  process.env.FILAMENT_PROFILE_ABS  || 'Generic ABS @BBL A1',
  tpu:  process.env.FILAMENT_PROFILE_TPU  || 'Generic TPU @BBL A1',
  pacf: process.env.FILAMENT_PROFILE_PACF || 'Generic PA-CF @BBL A1',
};

// ── Health ──────────────────────────────────────────────────────────
export async function slicerHealth() {
  try {
    const ver = await runOrca(['--help'], { timeoutMs: 5000 });
    return {
      ok: true,
      bin: SLICER_BIN,
      version_hint: ver.stdout.slice(0, 200),
    };
  } catch (e) {
    return {
      ok: false,
      bin: SLICER_BIN,
      error: e.message,
    };
  }
}

function runOrca(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(SLICER_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`orca-slicer timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// ── Build a per-job settings JSON by merging user choices onto the
//    selected machine profile. OrcaSlicer accepts these as the first
//    --load-settings arg.
// ────────────────────────────────────────────────────────────────────
async function buildSettingsJson({ printer, infill, layerHeight, supports }) {
  const machineName = PRINTER_PROFILE[printer] || PRINTER_PROFILE.x1c;
  const machinePath = profilePath('machine', machineName);

  // Look at a list of process profiles compatible with this machine,
  // then pick one matching the requested layer height.
  const processDir = path.join(PROFILES_DIR, 'process');
  const processFiles = (await fs.readdir(processDir)).filter(f => f.endsWith('.json'));

  // Read all profiles once, filter by compatible_printers
  const compatible = [];
  for (const f of processFiles) {
    try {
      const p = JSON.parse(await fs.readFile(path.join(processDir, f), 'utf8'));
      const cp = p.compatible_printers || [];
      if (cp.includes(machineName)) {
        compatible.push({ file: f, json: p });
      }
    } catch {}
  }

  if (!compatible.length) {
    // Fallback: pick any process profile (works because OrcaSlicer will warn but proceed)
    for (const f of processFiles.slice(0, 5)) {
      try {
        compatible.push({ file: f, json: JSON.parse(await fs.readFile(path.join(processDir, f), 'utf8')) });
      } catch {}
    }
  }

  // Pick the one whose layer_height best matches, defaulting to 0.28
  const targetLh = String(layerHeight);
  let best = compatible.find(p => p.json.layer_height === targetLh)
          || compatible.find(p => parseFloat(p.json.layer_height) <= layerHeight)
          || compatible[0];
  if (!best) {
    throw new Error(`No process profiles compatible with ${machineName}. Copy system process profiles into ${processDir}.`);
  }
  const proc = best.json;

  // Override with user choices
  proc.sparse_infill_density     = `${infill}%`;
  proc.skin_infill_density       = `${infill}%`;
  proc.skeleton_infill_density   = `${infill}%`;
  if (layerHeight) {
    proc.layer_height           = String(layerHeight);
    proc.first_layer_height     = String(layerHeight);
  }
  proc.enable_support             = supports === 'auto' ? '1' : '0';

  // OrcaSlicer CLI validator at Print.cpp:1407-1417 enforces G92 E0 in
  // layer_change_gcode OR before_layer_change_gcode when relative E
  // addressing + marlin flavor. is_BBL_printer() is declared but never
  // assigned in this build (broken), so the check fires for every CLI
  // invocation. Inject G92 E0 to satisfy the regex.
  proc.use_relative_e_distances   = '1';
  proc.gcode_flavor               = 'marlin';
  const g92 = 'G92 E0';
  proc.before_layer_change_gcode  = (proc.before_layer_change_gcode || '').includes(g92)
    ? proc.before_layer_change_gcode
    : (proc.before_layer_change_gcode ? proc.before_layer_change_gcode + '\n' : '') + g92;
  proc.layer_change_gcode         = (proc.layer_change_gcode || '').includes(g92)
    ? proc.layer_change_gcode
    : (proc.layer_change_gcode ? proc.layer_change_gcode + '\n' : '') + g92;

  // OrcaSlicer can take one or many --load-settings files. To make a
  // single settings JSON the slicer accepts without conflict, just pass
  // the process profile — it carries the "compatible_printers" hint
  // and inherits everything from system base profiles internally.
  return proc;
}

async function buildFilamentJson({ material }) {
  const name = FILAMENT_PROFILE[material] || FILAMENT_PROFILE.pla;
  const p = profilePath('filament', name);
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

// ── Slice one file ──────────────────────────────────────────────────
export async function sliceWithOrca({ inputPath, outputDir, printer, material, infill, layerHeight, supports }) {
  await fs.mkdir(outputDir, { recursive: true });

  const settingsPath = path.join(outputDir, 'settings.json');
  const filPath = path.join(outputDir, 'filament.json');
  const settings = await buildSettingsJson({ printer, infill, layerHeight, supports });
  const fil = await buildFilamentJson({ material });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  await fs.writeFile(filPath, JSON.stringify(fil, null, 2));

  // Also pass the machine profile so OrcaSlicer knows the active printer.
  const machineName = PRINTER_PROFILE[printer] || PRINTER_PROFILE.x1c;
  const machinePath = profilePath('machine', machineName);

  const stem = path.basename(inputPath).replace(/\.(stl|3mf|obj)$/i, '');
  const expectedGcode = path.join(outputDir, 'gcode', `${stem}.gcode`);

  const args = [
    '--slice', '0',
    '--outputdir', outputDir,
    '--load-settings', settingsPath,
    '--load-filaments', filPath,
  ];
  try {
    await fs.access(machinePath);
    args.push('--load-settings', machinePath);  // can be passed multiple times
  } catch {
    // Machine profile not bundled — OrcaSlicer will use default machine
  }
  args.push(inputPath);

  let result;
  try {
    result = await runOrca(args, { timeoutMs: 10 * 60_000 });
  } catch (e) {
    return { ok: false, log: e.message };
  }

  let gcodePath = null;
  let gcodeSize = 0;
  try {
    const stat = await fs.stat(expectedGcode);
    gcodePath = expectedGcode;
    gcodeSize = stat.size;
  } catch {
    try {
      const found = await findGcode(outputDir);
      if (found) { gcodePath = found.path; gcodeSize = found.size; }
    } catch {}
  }

  return {
    ok: gcodeSize > 0,
    gcodePath,
    gcodeSize,
    exitCode: result.code,
    log: `exit=${result.code}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`.slice(0, 8000),
  };
}

async function findGcode(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = await findGcode(p);
      if (r) return r;
    } else if (e.name.endsWith('.gcode') || e.name.endsWith('.gco')) {
      const s = await fs.stat(p);
      return { path: p, size: s.size };
    }
  }
  return null;
}
