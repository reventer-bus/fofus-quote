// Final quote computation once slicing is done.
// Pulls weight + time from G-code footer comments if OrcaSlicer wrote them,
// otherwise falls back to the client-supplied quote (validated only).
import fs from 'node:fs/promises';

const RATES = {
  printer: { a1: 35, x1c: 50, k1max: 45 },
  material:{ pla: 2.5, petg: 3.5, abs: 3.0, tpu: 6.0, pacf: 12.0 },
};
const SERVICE_FEE_RATIO = 0.15;
const GST_RATE = 0.18;
const SHIPPING_FLAT = 80;
const MIN_ORDER = 199;
const POST_PROC_PRICES = {
  sanding: 30, primer: 25, painting: 60, metallic: 100,
  resin: 50, fibre: 80, assembly: 40, packaging: 35,
};

// OrcaSlicer writes these into the gcode footer/header. Different versions
// emit different combos — we match all of them.
//   ; model printing time: 30m 20s; total estimated time: 30m 21s
//   ; estimated first layer printing time (normal mode) = 1s
//   ; filament used [mm] = 1391.99
//   ; filament used [cm3] = 3.35
//   ; filament used [g] = 12.34      (some versions)
//   ; total filament used [g] = 12.34 (OrcaSlicer 2.x sometimes)
const GCODE_PATTERNS = {
  // length → weight via density if grams missing
  lengthMm:   /;\s*filament used\s*\[mm\]\s*=\s*([\d.]+)/i,
  volumeCm3: /;\s*filament used\s*\[cm3?\]\s*=\s*([\d.]+)/i,
  weightG:   /;\s*(?:total\s+)?filament used\s*\[g\]\s*=\s*([\d.]+)/i,
  // Time formats: "1h 23m 45s", "23m 45s", "45s", "1d 2h"
  timeInHeader: /total estimated time:\s*([\d\sdhms]+)/i,
  timeInModel:  /model printing time:\s*([\d\sdhms]+)/i,
  // Older PrusaSlicer style
  timeAlt: /;\s*estimated printing time.*?=\s*([\d\sdhms]+)/i,
};

// Default PLA density (g/cm³) — used when only filament length is available.
const DEFAULT_DENSITY = 1.24;

function parseTime(str) {
  if (!str) return 0;
  const re = /(\d+)\s*(d|h|m|s)/gi;
  let m, total = 0;
  while ((m = re.exec(str)) !== null) {
    const n = parseInt(m[1], 10);
    if (m[2] === 'd') total += n * 1440;
    if (m[2] === 'h') total += n * 60;
    if (m[2] === 'm') total += n;
    if (m[2] === 's') total += n / 60;
  }
  return total;
}

export async function parseGcodeFooter(gcodePath) {
  // OrcaSlicer writes filament stats in the FOOTER but print time in the
  // HEADER. Read both ends (first 8 KB + last 16 KB) to cover both.
  const fh = await fs.open(gcodePath, 'r');
  try {
    const stat = await fh.stat();

    // Tail (filament weight / length / volume)
    const tailStart = Math.max(0, stat.size - 16_384);
    const tailBuf = Buffer.alloc(stat.size - tailStart);
    await fh.read(tailBuf, 0, tailBuf.length, tailStart);
    const tail = tailBuf.toString('utf8');

    // Head (print time)
    const headLen = Math.min(8192, stat.size);
    const headBuf = Buffer.alloc(headLen);
    await fh.read(headBuf, 0, headLen, 0);
    const head = headBuf.toString('utf8');

    const weightMatch = tail.match(GCODE_PATTERNS.weightG);
    const volumeMatch = tail.match(GCODE_PATTERNS.volumeCm3);
    const lengthMatch = tail.match(GCODE_PATTERNS.lengthMm);
    const timeMatch   = head.match(GCODE_PATTERNS.timeInModel)
                     || head.match(GCODE_PATTERNS.timeInHeader)
                     || tail.match(GCODE_PATTERNS.timeAlt);

    let weightG = null;
    if (weightMatch) {
      weightG = parseFloat(weightMatch[1]);
    } else if (volumeMatch) {
      weightG = parseFloat(volumeMatch[1]) * DEFAULT_DENSITY;
    } else if (lengthMatch) {
      const mm = parseFloat(lengthMatch[1]);
      const radiusMm = 0.875; // 1.75 mm diameter / 2
      const volumeCm3 = Math.PI * radiusMm * radiusMm * mm / 1000;
      weightG = volumeCm3 * DEFAULT_DENSITY;
    }

    return {
      weightG,
      minutes: timeMatch ? parseTime(timeMatch[1]) : null,
    };
  } finally {
    await fh.close();
  }
}

export function buildFinalQuote({ slicerResult, clientQuote, material, printer }) {
  const mat = RATES.material[material] || RATES.material.pla;
  const prn = RATES.printer[printer]  || RATES.printer.x1c;

  const weightG = slicerResult.weightG ?? clientQuote?.weight_g ?? 0;
  const minutes = slicerResult.minutes ?? clientQuote?.minutes ?? 0;
  const hours = minutes / 60;

  const materialCost = weightG * mat;
  const machineCost  = hours * prn;
  const subtotal     = materialCost + machineCost;
  const serviceFee   = subtotal * SERVICE_FEE_RATIO;
  const total        = subtotal + serviceFee;

  return {
    weight_g: +weightG.toFixed(2),
    minutes:  +minutes.toFixed(1),
    hours:    +hours.toFixed(2),
    material_cost_inr: +materialCost.toFixed(2),
    machine_cost_inr:  +machineCost.toFixed(2),
    service_fee_inr:   +serviceFee.toFixed(2),
    total_inr:         +total.toFixed(2),
    source: slicerResult.weightG != null ? 'slicer' : 'client_fallback',
  };
}
