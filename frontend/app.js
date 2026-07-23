/* ════════════════════════════════════════════════════════════════════
   FOFUS Quote — frontend engine  v0.3
   ────────────────────────────────────────────────────────────────────
   • STL parser (binary STL, the 99% case; ASCII fallback)
   • 3D model viewer (Three.js OrbitControls)
   • Quote math: volume × density + infill + support estimate
   •   + post-processing + shipping + GST + minimum order
   • Empirical print-time model calibrated to FOFUS production prints
   • PDF estimate download (client-side, no server roundtrip)
   • "Request printing" POSTs STL + settings to Railway backend
   • "Get quote on WhatsApp" opens wa.me with pre-filled message
   ════════════════════════════════════════════════════════════════════ */

// ── State ──────────────────────────────────────────────────────────
const state = {
  file: null,
  fileBuf: null,
  geometry: null,   // { volumeCm3, bbox: {x,y,z}, triangles }
  printer: 'x1c',   // 'a1' | 'x1c' | 'k1max'
  material: 'pla',  // 'pla' | 'petg' | 'abs' | 'silicone' | 'fibre'
  colour: 'black',
  infill: 20,
  layerHeight: 0.20,
  supports: 'auto', // 'auto' | 'tree' | 'none'
  scale: 1.0,       // model scale factor (0.25 – 3.0)
  postProc: new Set(),
  quote: null,      // last computed quote
  jobId: null,
  jobStatus: null,
  viewer: null,     // Three.js viewer instance
};

// ── Constants ──────────────────────────────────────────────────────
const PRINTERS = {
  a1:   { name: 'Standard 256³ chamber',   ratePerHr: 35, buildMm: 256 },
  x1c:  { name: 'Engineering 256³ chamber', ratePerHr: 50, buildMm: 256 },
  k1max:{ name: 'Large 300³ chamber',      ratePerHr: 45, buildMm: 300 },
};
const MATERIALS = {
  pla:     { name: 'PLA',               ratePerG: 2.5,  densityGcm3: 1.24, speed: 1.00, custom: false },
  petg:    { name: 'PETG',              ratePerG: 3.5,  densityGcm3: 1.27, speed: 0.90, custom: false },
  abs:     { name: 'ABS',               ratePerG: 5.0,  densityGcm3: 1.04, speed: 0.85, custom: false },
  silicone:{ name: 'Silicone Casting',  ratePerG: 0,    densityGcm3: 1.20, speed: 0.60, custom: true  },
  fibre:   { name: 'Fibre-Reinforced',  ratePerG: 0,    densityGcm3: 1.30, speed: 0.70, custom: true  },
};
const COLOURS = {
  black: 'Black', white: 'White', red: 'Red', blue: 'Blue',
  green: 'Green', yellow: 'Yellow', custom: 'Custom colour',
};
const POST_PROC_PRICES = {
  sanding: 30, primer: 25, painting: 60, metallic: 100,
  resin: 50, fibre: 80, assembly: 40, packaging: 35,
};
const POST_PROC_NAMES = {
  sanding: 'Sanding', primer: 'Primer', painting: 'Painting', metallic: 'Metallic finish',
  resin: 'Resin coating', fibre: 'Fibre reinforcement', assembly: 'Assembly', packaging: 'Custom packaging',
};
const SERVICE_FEE_RATIO = 0.15;
const MIN_ORDER = 199;
const GST_RATE = 0.18;
const SHIPPING_FLAT = 80;
const WHATSAPP_NUMBER = '918301874640'; // FOFUS WhatsApp
const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname.includes('vercel.app'))
  ? (window.FOFUS_API || 'https://quote.business.fofus.in')
  : '';

// ════════════════════════════════════════════════════════════════════
// STL PARSER (binary)
// ════════════════════════════════════════════════════════════════════
function parseBinarySTL(buf) {
  if (buf.byteLength < 84) throw new Error('File too small to be a binary STL');
  const view = new DataView(buf);
  const triCount = view.getUint32(80, true);
  const expected = 84 + triCount * 50;
  if (buf.byteLength < expected) {
    throw new Error(`Binary STL truncated: header claims ${triCount} triangles but file is short`);
  }

  let volMm3 = 0;
  let minX=Infinity, minY=Infinity, minZ=Infinity;
  let maxX=-Infinity, maxY=-Infinity, maxZ=-Infinity;
  const vertices = []; // for 3D viewer

  let off = 84;
  for (let i = 0; i < triCount; i++) {
    off += 12; // skip normal
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
    vertices.push(v[0], v[1], v[2]);
    const [a, b, c] = v;
    volMm3 += (
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0])
    ) / 6;
    off += 2;
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
    vertices, // flat array of [x,y,z] triplets for Three.js
  };
}

function looksLikeASCII(buf) {
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(80, buf.byteLength)));
  return /^solid\s+\S+/i.test(head.trimStart()) && /facet\s+normal/i.test(head);
}
function parseASCIISTL(text) {
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
    triangles: tris, volumeMm3: volAbs, volumeCm3: volAbs / 1000,
    bbox: { x: maxX-minX, y: maxY-minY, z: maxZ-minZ, min:[minX,minY,minZ], max:[maxX,maxY,maxZ] },
    vertices: verts,
  };
}

async function parseSTLFile(file) {
  const buf = await file.arrayBuffer();
  let geom;
  try {
    geom = parseBinarySTL(buf);
  } catch (eBin) {
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
// 3D VIEWER (Three.js)
// ════════════════════════════════════════════════════════════════════
function initViewer(vertices) {
  const container = document.getElementById('viewer-canvas');
  if (!container || !window.THREE) return;

  // Clean up previous viewer
  if (state.viewer) {
    state.viewer.renderer.dispose();
    if (state.viewer.renderer.domElement) container.removeChild(state.viewer.renderer.domElement);
  }

  const w = container.clientWidth || 300;
  const h = 280;

  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 5000);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  // Build geometry from vertices
  const positions = new Float32Array(vertices.length * 3);
  for (let i = 0; i < vertices.length; i++) {
    positions[i * 3] = vertices[i][0];
    positions[i * 3 + 1] = vertices[i][1];
    positions[i * 3 + 2] = vertices[i][2];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();

  // Center and scale model to fit viewer
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  const center = new THREE.Vector3();
  bbox.getCenter(center);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  const fitScale = maxDim > 0 ? 100 / maxDim : 1;
  geometry.translate(-center.x, -center.y, -center.z);
  geometry.scale(fitScale * state.scale, fitScale * state.scale, fitScale * state.scale);

  // Material
  const material = new THREE.MeshPhongMaterial({
    color: 0xC9A063,
    specular: 0x333333,
    shininess: 30,
    flatShading: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // Wireframe overlay (toggleable)
  const wireMat = new THREE.MeshBasicMaterial({ color: 0x608FA8, wireframe: true });
  const wireMesh = new THREE.Mesh(geometry, wireMat);
  wireMesh.visible = false;
  scene.add(wireMesh);

  // Lights
  const ambient = new THREE.AmbientLight(0x666666);
  scene.add(ambient);
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(100, 100, 200);
  scene.add(dirLight);
  const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
  dirLight2.position.set(-100, -50, -100);
  scene.add(dirLight2);

  // Grid
  const grid = new THREE.GridHelper(200, 20, 0x333333, 0x222222);
  grid.position.y = -55;
  scene.add(grid);

  // Controls
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  camera.position.set(80, 80, 120);
  controls.target.set(0, 0, 0);
  controls.update();

  let wireframeOn = false;
  document.getElementById('viewer-wireframe').onclick = () => {
    wireframeOn = !wireframeOn;
    mesh.visible = !wireframeOn;
    wireMesh.visible = wireframeOn;
  };
  document.getElementById('viewer-reset').onclick = () => {
    camera.position.set(80, 80, 120);
    controls.target.set(0, 0, 0);
    controls.update();
  };

  // Resize handler
  function onResize() {
    const nw = container.clientWidth || 300;
    camera.aspect = nw / h;
    camera.updateProjectionMatrix();
    renderer.setSize(nw, h);
  }
  window.addEventListener('resize', onResize);

  // Render loop
  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  state.viewer = { renderer, scene, camera, mesh, wireMesh, controls };
}

// ════════════════════════════════════════════════════════════════════
// QUOTE MODEL
// ════════════════════════════════════════════════════════════════════
function computeQuote() {
  if (!state.geometry) return null;
  const g = state.geometry;
  const prn = PRINTERS[state.printer];
  const mat = MATERIALS[state.material];
  const lh  = state.layerHeight;
  const sc  = state.scale;

  // Custom materials — no instant estimate
  if (mat.custom) {
    return { custom: true };
  }

  // Apply scale: volume scales cubic, bbox linear
  const volCm3  = g.volumeCm3  * sc * sc * sc;
  const bbox    = { x: g.bbox.x * sc, y: g.bbox.y * sc, z: g.bbox.z * sc };

  // 1. Shell volume
  const kShell = 0.85;
  const shellVolCm3 = kShell * Math.pow(volCm3, 0.66);

  // 2. Top + bottom skin volume
  const topBotLayers = 8;
  const topAreaCm2 = Math.min(
    (bbox.x/10) * (bbox.y/10),
    Math.pow(volCm3, 2/3)
  );
  const topBotVolCm3 = topAreaCm2 * lh * topBotLayers / 10;

  // 3. Infill volume
  const infillVolCm3 = Math.max(0, volCm3 - shellVolCm3 - topBotVolCm3) * (state.infill / 100);

  // 4. Support material estimate
  const supportFactor = state.supports === 'auto' ? 0.10 : state.supports === 'tree' ? 0.06 : 0.0;
  const supportVolCm3 = volCm3 * supportFactor;

  // 5. Total filament volume + weight
  const totalFilamentCm3 = shellVolCm3 + topBotVolCm3 + infillVolCm3 + supportVolCm3;
  const weightG = totalFilamentCm3 * mat.densityGcm3;

  // 6. Print time
  const effRate = (lh / 0.20) * 12 * mat.speed;
  const printMinutes = totalFilamentCm3 / effRate;
  const overheadMinutes = 4 + (weightG / 100) * 1.2;
  const totalMinutes = printMinutes + overheadMinutes;
  const totalHours = totalMinutes / 60;

  // 7. Costs
  const materialCost = weightG * mat.ratePerG;
  const machineCost = totalHours * prn.ratePerHr;
  const subtotal = materialCost + machineCost;

  // 8. Post-processing
  let postProcCost = 0;
  const ppItems = [];
  for (const key of state.postProc) {
    const cost = POST_PROC_PRICES[key] || 0;
    postProcCost += cost;
    ppItems.push(POST_PROC_NAMES[key] || key);
  }

  // 9. Service fee (on subtotal + post-processing)
  const serviceFee = (subtotal + postProcCost) * SERVICE_FEE_RATIO;

  // 10. Shipping
  const shipping = SHIPPING_FLAT;

  // 11. Pre-GST subtotal
  let preGstSubtotal = subtotal + postProcCost + serviceFee + shipping;

  // 12. Minimum order adjustment
  let minOrderApplied = false;
  if (preGstSubtotal < MIN_ORDER) {
    preGstSubtotal = MIN_ORDER;
    minOrderApplied = true;
  }

  // 13. GST
  const gst = preGstSubtotal * GST_RATE;

  // 14. Grand total
  const total = preGstSubtotal + gst;

  return {
    custom: false,
    weightG, totalHours, totalMinutes,
    materialCost, machineCost, postProcCost, ppItems,
    serviceFee, shipping, gst,
    preGstSubtotal, total,
    minOrderApplied,
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

  // Custom material — show custom quote note
  if (q.custom) {
    document.getElementById('q-time').textContent = '—';
    document.getElementById('q-weight').textContent = '—';
    document.getElementById('q-mat-label').textContent = `${mat.name}`;
    document.getElementById('q-mat-cost').textContent = 'Custom quote';
    document.getElementById('q-mach-label').textContent = `Build chamber (${prn.buildMm}³)`;
    document.getElementById('q-mach-cost').textContent = 'Custom quote';
    document.getElementById('q-pp-row').hidden = true;
    document.getElementById('q-service').textContent = '—';
    document.getElementById('q-shipping').textContent = '—';
    document.getElementById('q-subtotal').textContent = 'Custom quote';
    document.getElementById('q-gst').textContent = '—';
    document.getElementById('q-total').textContent = 'Custom';
    document.getElementById('custom-quote-note').hidden = false;
    document.getElementById('min-order-note').hidden = true;
    document.getElementById('estimate-disclaimer').style.display = 'none';
    document.getElementById('contact-form').hidden = false;
    return;
  }

  document.getElementById('custom-quote-note').hidden = true;
  document.getElementById('estimate-disclaimer').style.display = '';

  document.getElementById('q-time').textContent = fmt.hrs(q.totalMinutes);
  document.getElementById('q-weight').textContent = `${q.weightG.toFixed(1)} g`;
  document.getElementById('q-mat-label').textContent = `Material (${mat.name} · ${state.infill}% infill)`;
  document.getElementById('q-mat-cost').textContent = fmt.inr(q.materialCost);
  document.getElementById('q-mach-label').textContent = `Build chamber (${prn.buildMm}³)`;
  document.getElementById('q-mach-cost').textContent = fmt.inr(q.machineCost);

  // Post-processing row
  const ppRow = document.getElementById('q-pp-row');
  if (q.postProcCost > 0) {
    ppRow.hidden = false;
    document.getElementById('q-pp-label').textContent = `Post-processing (${q.ppItems.join(', ')})`;
    document.getElementById('q-pp-cost').textContent = fmt.inr(q.postProcCost);
  } else {
    ppRow.hidden = true;
  }

  document.getElementById('q-service').textContent = fmt.inr(q.serviceFee);
  document.getElementById('q-shipping').textContent = fmt.inr(q.shipping);
  document.getElementById('q-subtotal').textContent = fmt.inr(q.preGstSubtotal);
  document.getElementById('q-gst').textContent = fmt.inr(q.gst);
  document.getElementById('q-total').textContent = fmt.inr(q.total);

  // Min order note
  document.getElementById('min-order-note').hidden = !q.minOrderApplied;

  // Show contact form
  document.getElementById('contact-form').hidden = false;

  // Build-volume fit check (uses scaled bbox)
  const b = { x: g.bbox.x * state.scale, y: g.bbox.y * state.scale, z: g.bbox.z * state.scale };
  const fitWarn = document.getElementById('fit-warn');
  const oversize = (b.x > prn.buildMm) || (b.y > prn.buildMm) || (b.z > prn.buildMm);
  fitWarn.hidden = !oversize;
}

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
      setNote(`${ext.toUpperCase()} analysis needs the server. Pick an STL for instant in-browser quoting, or click Request Printing to start a server-side analysis.`);
      state.file = file;
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

    // Update scale hint with original dimensions
    updateScaleHint();

    // Show and init 3D viewer
    document.getElementById('viewer-wrap').hidden = false;
    if (geom.vertices && geom.vertices.length > 0) {
      initViewer(geom.vertices);
    }

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
// WHATSAPP QUOTE
// ════════════════════════════════════════════════════════════════════
function sendWhatsAppQuote() {
  if (!state.file) {
    setNote('Upload a file first.', 'err'); return;
  }
  const contact = getContact();
  const q = state.quote;
  const prn = PRINTERS[state.printer];
  const mat = MATERIALS[state.material];
  const colour = COLOURS[state.colour] || '—';

  let msg = `Hi FOFUS, I want to print a model. Here are my details:\n\n`;
  msg += `File: ${state.file.name}\n`;
  msg += `Material: ${mat.name}\n`;
  msg += `Colour: ${colour}\n`;
  msg += `Build chamber: ${prn.name}\n`;
  msg += `Infill: ${state.infill}%\n`;
  msg += `Resolution: ${state.layerHeight} mm\n`;
  msg += `Scale: ${Math.round(state.scale*100)}%\n`;
  msg += `Supports: ${state.supports}\n`;

  // Post-processing
  if (state.postProc.size > 0) {
    const ppNames = [...state.postProc].map(k => POST_PROC_NAMES[k] || k);
    msg += `Post-processing: ${ppNames.join(', ')}\n`;
  }

  if (q && !q.custom) {
    msg += `\nMy instant estimate:\n`;
    msg += `  Print time: ${fmt.hrs(q.totalMinutes)}\n`;
    msg += `  Weight: ${q.weightG.toFixed(1)} g\n`;
    msg += `  Total: ${fmt.inr(q.total)} (incl. GST)\n`;
  } else if (q && q.custom) {
    msg += `\nThis material requires a custom quote. Please provide a price.\n`;
  }

  if (contact.name) msg += `\nName: ${contact.name}\n`;
  if (contact.phone) msg += `Phone: ${contact.phone}\n`;
  if (contact.email) msg += `Email: ${contact.email}\n`;
  if (contact.pincode) msg += `Pincode: ${contact.pincode}\n`;
  if (contact.notes) msg += `Notes: ${contact.notes}\n`;

  const url = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;
  window.open(url, '_blank');
  setNote('Opening WhatsApp with your quote details…', 'ok');
}

// ════════════════════════════════════════════════════════════════════
// PDF ESTIMATE
// ════════════════════════════════════════════════════════════════════
function downloadQuotePDF() {
  if (!state.quote || !state.geometry) return;
  const q = state.quote;
  const g = state.geometry;
  const prn = PRINTERS[state.printer];
  const mat = MATERIALS[state.material];
  const colour = COLOURS[state.colour] || '—';

  if (q.custom) {
    setNote('Custom quote materials cannot generate a PDF estimate. Use WhatsApp instead.', 'err');
    return;
  }

  const ppLine = q.postProcCost > 0
    ? `<tr><th>Post-processing (${q.ppItems.join(', ')})</th><td>${fmt.inr(q.postProcCost)}</td></tr>`
    : '';

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>FOFUS Estimate</title>
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
  .subtotal{margin-top:16px;padding:14px;background:#FAF6EE;border-left:3px solid #C9A063}
  .subtotal-row{display:flex;justify-content:space-between;align-items:baseline}
  .subtotal-label{font-size:11px;letter-spacing:.18em;color:#524E46;text-transform:uppercase}
  .subtotal-val{font-size:20px;color:#333;font-family:monospace}
  .gst-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #E5E0D8}
  .total{margin-top:24px;padding:20px;background:#FAF6EE;border-left:3px solid #C9A063}
  .total-row{display:flex;justify-content:space-between;align-items:baseline}
  .total-label{font-size:11px;letter-spacing:.18em;color:#C9A063;text-transform:uppercase}
  .total-val{font-size:42px;color:#C9A063;font-weight:300}
  .disclaimer{font-size:11px;color:#B05030;margin-top:16px;padding:10px;background:#FFF5F0;border:1px solid #E5D0C0;border-radius:4px}
  .note{font-size:11px;color:#524E46;margin-top:20px;line-height:1.6;border-top:1px solid #E5E0D8;padding-top:14px}
  @media print{body{padding:20px}.total{background:#fff}}
</style></head><body>
<div class="h">
  <div><div class="logo">FOFUS</div><div class="tag">3D Manufacturing · Kerala</div></div>
  <div style="text-align:right">
    <div style="font-size:11px;color:#524E46">Estimate</div>
    <div style="font-size:18px;font-family:monospace">${Date.now().toString(36).toUpperCase()}</div>
  </div>
</div>
<h1>Your <em>3D printing</em> estimate</h1>
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
  <tr><th>Colour</th><td>${colour}</td></tr>
  <tr><th>Infill</th><td>${state.infill}%</td></tr>
  <tr><th>Resolution</th><td>${state.layerHeight} mm</td></tr>
  <tr><th>Scale</th><td>${Math.round(state.scale*100)}%</td></tr>
  <tr><th>Supports</th><td>${state.supports === 'auto' ? 'Auto-generated' : state.supports === 'tree' ? 'Tree supports' : 'None'}</td></tr>
  <tr><th>Print time</th><td>${fmt.hrs(q.totalMinutes)}</td></tr>
  <tr><th>Weight</th><td>${q.weightG.toFixed(1)} g</td></tr>
</table>

<table>
  <tr><th>Material cost</th><td>${fmt.inr(q.materialCost)}</td></tr>
  <tr><th>Machine time (${prn.buildMm}³ chamber)</th><td>${fmt.inr(q.machineCost)}</td></tr>
  ${ppLine}
  <tr><th>Service fee (${(SERVICE_FEE_RATIO*100)}%)</th><td>${fmt.inr(q.serviceFee)}</td></tr>
  <tr><th>Shipping</th><td>${fmt.inr(q.shipping)}</td></tr>
</table>

<div class="subtotal">
  <div class="subtotal-row">
    <span class="subtotal-label">Subtotal</span>
    <span class="subtotal-val">${fmt.inr(q.preGstSubtotal)}</span>
  </div>
</div>
<div class="gst-row">
  <span style="font-size:13px;color:#524E46">GST (18%)</span>
  <span style="font-family:monospace;font-size:13px">${fmt.inr(q.gst)}</span>
</div>

<div class="total">
  <div class="total-row">
    <span class="total-label">Total (incl. GST)</span>
    <span class="total-val">${fmt.inr(q.total)}</span>
  </div>
</div>

${q.minOrderApplied ? '<div class="disclaimer">ⓘ A minimum order value of ₹199 applies. Your estimate has been adjusted accordingly.</div>' : ''}

<div class="disclaimer">
  This is an instant estimate. Final price may vary after production review for complex models, special materials, or post-processing. Valid for 7 days.
</div>

<div class="note">
  Pickup at Irinjalakuda, Thrissur · pan-India shipping available. Estimated delivery: 3–5 working days.<br><br>
  FOFUS · hello@fofus.in · <a href="https://fofus.in">fofus.in</a>
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
  const colour = COLOURS[state.colour] || '—';

  const payload = {
    file_name: state.file.name,
    file_size: state.file.size,
    file_base64: state.fileBuf ? _arrayBufferToBase64(state.fileBuf) : null,
    geometry: g,
    printer: state.printer,
    printer_name: prn.name,
    material: state.material,
    material_name: mat.name,
    colour: state.colour,
    infill: state.infill,
    layer_height: state.layerHeight,
    scale: state.scale,
    supports: state.supports,
    post_processing: [...state.postProc],
    quote: q.custom ? null : {
      weight_g: q.weightG,
      hours: q.totalHours,
      minutes: q.totalMinutes,
      material_cost: q.materialCost,
      machine_cost: q.machineCost,
      post_proc_cost: q.postProcCost,
      service_fee: q.serviceFee,
      shipping: q.shipping,
      gst: q.gst,
      subtotal: q.preGstSubtotal,
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
    state.jobId = jobId;

    setNote('Estimate saved. Running final production slice for the confirmed price…');
    await fetch(`${API_BASE}/api/print-jobs/${jobId}/slice`, { method: 'POST' });

    pollJobForPayment(jobId, contact, q.custom ? 0 : q.total);
  } catch (e) {
    fallbackToMailto(contact, q, prn, mat);
  }
}

async function pollJobForPayment(jobId, contact, clientTotal) {
  const btn = document.getElementById('request-print');
  btn.disabled = true;
  btn.textContent = 'Finalising quote…';

  let attempts = 0;
  const maxAttempts = 60;
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
      // ignore polling errors
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
  const colour = COLOURS[state.colour] || '—';
  const ppStr = state.postProc.size > 0
    ? [...state.postProc].map(k => POST_PROC_NAMES[k]).join(', ')
    : 'None';
  const totalStr = q.custom ? 'Custom quote' : fmt.inr(q.total);
  const body = encodeURIComponent(
    `Hi FOFUS,\n\nI'd like to proceed with the estimate on your site.\n\n` +
    `File: ${state.file.name} (${(state.file.size/1024/1024).toFixed(2)} MB)\n` +
    `Printer: ${prn.name}\nMaterial: ${mat.name}\nColour: ${colour}\n` +
    `Infill: ${state.infill}%  Layer: ${state.layerHeight} mm  Scale: ${Math.round(state.scale*100)}%  Supports: ${state.supports}\n` +
    `Post-processing: ${ppStr}\n\n` +
    `Estimate (instant):\n` +
    (q.custom ? `  Custom quote required\n` :
    `  Print time: ${fmt.hrs(q.totalMinutes)}\n  Weight: ${q.weightG.toFixed(1)} g\n  Total: ${totalStr} (incl. GST)\n\n`) +
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
// SCALE HELPER
// ════════════════════════════════════════════════════════════════════
function updateScaleHint() {
  if (!state.geometry) return;
  const sc = state.scale;
  const g = state.geometry;
  const sx = (g.bbox.x * sc).toFixed(1);
  const sy = (g.bbox.y * sc).toFixed(1);
  const sz = (g.bbox.z * sc).toFixed(1);
  const hint = document.getElementById('scale-hint');
  if (!hint) return;
  if (sc === 1) {
    hint.textContent = 'Original size';
  } else {
    hint.textContent = `${sx} × ${sy} × ${sz} mm`;
  }
  // Update displayed volume too
  const volEl = document.getElementById('stat-volume');
  if (volEl) {
    const scaledVol = g.volumeCm3 * sc * sc * sc;
    volEl.textContent = fmt.cm3(scaledVol);
  }
  // Update displayed bbox
  const bboxEl = document.getElementById('stat-bbox');
  if (bboxEl) {
    bboxEl.textContent = `${sx} × ${sy} × ${sz} mm`;
  }
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

  // Colour picker
  document.getElementById('colour-picker').addEventListener('click', e => {
    const btn = e.target.closest('.colour-pick');
    if (!btn) return;
    document.querySelectorAll('.colour-pick').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    state.colour = btn.dataset.colour;
  });

  // Post-processing checkboxes
  document.getElementById('post-proc').addEventListener('change', e => {
    const cb = e.target;
    if (cb.type !== 'checkbox') return;
    const key = cb.dataset.pp;
    if (cb.checked) state.postProc.add(key);
    else state.postProc.delete(key);
    renderQuote();
  });

  // Slider
  document.getElementById('infill').addEventListener('input', e => {
    state.infill = parseInt(e.target.value, 10);
    document.getElementById('infill-val').textContent = `${state.infill}%`;
    renderQuote();
  });

  // Scale slider
  document.getElementById('scale').addEventListener('input', e => {
    state.scale = parseInt(e.target.value, 10) / 100;
    document.getElementById('scale-val').textContent = `${e.target.value}%`;
    updateScaleHint();
    // Re-init viewer with new scale
    if (state.geometry && state.geometry.vertices && state.geometry.vertices.length > 0) {
      initViewer(state.geometry.vertices);
    }
    renderQuote();
  });

  // Hamburger menu
  const hamburger = document.getElementById('nav-hamburger');
  const navLinks = document.querySelector('.nav-links');
  if (hamburger) {
    hamburger.addEventListener('click', () => {
      hamburger.classList.toggle('active');
      navLinks.classList.toggle('open');
    });
    // Close menu when a link is clicked
    navLinks.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => {
        hamburger.classList.remove('active');
        navLinks.classList.remove('open');
      });
    });
  }

  // Actions
  document.getElementById('download-quote').addEventListener('click', downloadQuotePDF);
  document.getElementById('whatsapp-quote').addEventListener('click', sendWhatsAppQuote);
  document.getElementById('request-print').addEventListener('click', () => {
    if (state.jobId && (state.jobStatus === 'sliced' || state.jobStatus === 'slice_failed' || state.jobStatus === 'awaiting_payment')) {
      createCheckout(state.jobId, state.quote?.total || 0);
    } else {
      requestPrinting();
    }
  });

  // Theme toggle
  const themeToggle = document.getElementById('theme-toggle');
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