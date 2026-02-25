const tsv = await Deno.readTextFile("data/khanacademy/khandata.tsv");
const lines = tsv.split("\n").filter((l, i) => i > 1 && l.trim());

// parse
type Node = { code: string; slug: string; name: string; prereqStr: string; origH: number | null; origV: number | null; x: number; y: number; vx: number; vy: number; prereqs: Node[]; dependents: Node[]; depth: number; dc: number; ds: number; dom: number };
const nodes: Node[] = [];
const byCode = new Map<string, Node>();
const bySlug = new Map<string, Node>();

for (const line of lines) {
  const [code, slug, prereqStr, hStr, vStr, displayName] = line.split("\t");
  if (!slug) continue;
  const h = hStr === "x" ? null : +hStr;
  const v = vStr === "x" ? null : +vStr;
  const node: Node = { code, slug, name: (displayName || slug).replace(/\\/g, '"'), prereqStr: prereqStr || "", origH: h, origV: v, x: 0, y: 0, vx: 0, vy: 0, prereqs: [], dependents: [], depth: 0, dc: 0, ds: 0, dom: 0 };
  nodes.push(node);
  byCode.set(code, node);
  bySlug.set(slug, node);
}

// resolve prereqs
const edges: [Node, Node][] = [];
for (const node of nodes) {
  if (!node.prereqStr || node.prereqStr === "root") continue;
  for (const tok of node.prereqStr.split(";").map(t => t.trim()).filter(Boolean)) {
    if (tok === "root") continue;
    const resolved = /^\d+$/.test(tok) ? byCode.get(tok) : bySlug.get(tok);
    if (resolved) {
      node.prereqs.push(resolved);
      resolved.dependents.push(node);
      edges.push([resolved, node]);
    }
  }
}

// --- Pre-compute graph metadata ---

// Depth: longest path from any root via topo sort
const inDeg = new Map<Node, number>();
for (const n of nodes) inDeg.set(n, n.prereqs.length);
const queue: Node[] = nodes.filter(n => n.prereqs.length === 0);
for (const n of queue) n.depth = 0;
let qi = 0;
while (qi < queue.length) {
  const n = queue[qi++];
  for (const d of n.dependents) {
    d.depth = Math.max(d.depth, n.depth + 1);
    inDeg.set(d, inDeg.get(d)! - 1);
    if (inDeg.get(d) === 0) queue.push(d);
  }
}

// Dependent count (direct)
for (const n of nodes) n.dc = n.dependents.length;

// Downstream count (transitive dependents)
const topoOrder = [...queue];
for (let i = topoOrder.length - 1; i >= 0; i--) {
  const n = topoOrder[i];
  n.ds = n.dependents.reduce((sum, d) => sum + 1 + d.ds, 0);
}

// Domain classification by H-Position ranges
const DOMAIN_BREAKS = [-Infinity, 10, 40, 70, 100, 135, 170, Infinity];
const DOMAIN_NAMES = ["Early Elementary", "Late Elementary", "Pre-Algebra", "Algebra", "Geometry & Trig", "Pre-Calculus", "Calculus"];

function classifyDomain(h: number | null): number {
  if (h === null) return 3;
  for (let i = 0; i < DOMAIN_BREAKS.length - 1; i++) {
    if (h >= DOMAIN_BREAKS[i] && h < DOMAIN_BREAKS[i + 1]) return i;
  }
  return 6;
}

// Inherit H for unpositioned nodes from neighbors
const positioned = nodes.filter(n => n.origH !== null);
const unpositioned = nodes.filter(n => n.origH === null);
for (const n of unpositioned) {
  const neighbors = [...n.prereqs, ...n.dependents].filter(p => p.origH !== null);
  if (neighbors.length) {
    n.origH = neighbors.reduce((s, p) => s + p.origH!, 0) / neighbors.length;
  }
}
for (const n of nodes) n.dom = classifyDomain(n.origH);

// --- Layout: vertical orientation (K at bottom, Calculus at top) ---
// H-Position → Y axis (inverted: low H = bottom = large Y)
// V-Position → X axis (horizontal spread)

const uniqueH = [...new Set(positioned.map(n => n.origH!))].sort((a, b) => a - b);
const uniqueV = [...new Set(positioned.map(n => n.origV!))].sort((a, b) => a - b);
const hRank = new Map<number, number>(); uniqueH.forEach((h, i) => hRank.set(h, i));
const vRank = new Map<number, number>(); uniqueV.forEach((v, i) => vRank.set(v, i));
const maxHRank = uniqueH.length - 1;

const INIT_SX = 200, INIT_SY = 140;
for (const n of positioned) {
  n.x = vRank.get(n.origV!)! * INIT_SX;
  n.y = (maxHRank - hRank.get(n.origH!)!) * INIT_SY; // invert: low H → large Y (bottom)
}

// Place unpositioned: above highest prereq (lower Y), 5 passes
const unposSet = new Set(unpositioned);
for (let pass = 0; pass < 5; pass++) {
  for (const n of unpositioned) {
    const allNeighbors = [...n.prereqs, ...n.dependents].filter(p => !unposSet.has(p) || pass > 0);
    if (allNeighbors.length) {
      const prereqsWithPos = n.prereqs.filter(p => !unposSet.has(p) || pass > 0);
      if (prereqsWithPos.length) {
        // Place above (lower Y) the highest prereq
        const highest = prereqsWithPos.reduce((best, p) => p.y < best.y ? p : best);
        n.y = highest.y - INIT_SY * 0.8 + (Math.random() - 0.5) * 40;
        let sx = 0;
        for (const p of allNeighbors) sx += p.x;
        n.x = sx / allNeighbors.length + (Math.random() - 0.5) * 60;
      } else {
        let sx = 0, sy = 0;
        for (const p of allNeighbors) { sx += p.x; sy += p.y; }
        n.x = sx / allNeighbors.length + (Math.random() - 0.5) * 60;
        n.y = sy / allNeighbors.length - INIT_SY * 0.5;
      }
    } else if (pass === 0) {
      n.x = uniqueV.length * INIT_SX / 2 + (Math.random() - 0.5) * 600;
      n.y = -INIT_SY * 2 + Math.random() * 400;
    }
  }
}

// Force-directed simulation with hard Y-lock for positioned nodes
const isUnpositioned = new Set(unpositioned);
const anchorX = nodes.map(n => n.x);

const IDEAL_LEN = 160;
const ITERATIONS = 1200;
const repulseRadius = 250;
const repulseStrength = 3000;
const springK = 0.18;

function simulate() {
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const alpha = 1 - iter / ITERATIONS;
    const step = 0.25 * alpha + 0.03;

    for (const n of nodes) { n.vx = 0; n.vy = 0; }

    // spatial grid for repulsion
    const cellSize = repulseRadius;
    const grid = new Map<string, Node[]>();
    for (const n of nodes) {
      const key = Math.floor(n.x / cellSize) + "," + Math.floor(n.y / cellSize);
      const cell = grid.get(key);
      if (cell) cell.push(n); else grid.set(key, [n]);
    }

    for (const n of nodes) {
      const cx = Math.floor(n.x / cellSize), cy = Math.floor(n.y / cellSize);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const cell = grid.get((cx + dx) + "," + (cy + dy));
          if (!cell) continue;
          for (const other of cell) {
            if (other === n) continue;
            const ddx = n.x - other.x, ddy = n.y - other.y;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 < repulseRadius * repulseRadius && d2 > 0.1) {
              const d = Math.sqrt(d2);
              const f = repulseStrength / d2;
              n.vx += ddx / d * f;
              n.vy += ddy / d * f;
            }
          }
        }
      }
    }

    // springs on edges
    for (const [a, b] of edges) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.1;
      const f = springK * (d - IDEAL_LEN) / d;
      const fx = dx * f, fy = dy * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }

    // directional bias: push edges to flow bottom→top (DAG: from=below, to=above)
    const dagBias = 0.15 * alpha;
    for (const [from, to] of edges) {
      if (to.y >= from.y - 20) { // to should be above (lower Y)
        to.vy -= dagBias * 30;
        from.vy += dagBias * 30;
      }
    }

    // X anchor to preserve horizontal structure
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const isUnpos = isUnpositioned.has(n);
      const wx = isUnpos ? 0.003 : 0.02;
      n.vx += (anchorX[i] - n.x) * wx;
    }

    // apply velocities with speed cap
    for (const n of nodes) {
      const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (speed > 8) { n.vx = n.vx / speed * 8; n.vy = n.vy / speed * 8; }

      // positioned nodes: Y is locked (progression axis), only X floats
      n.x += n.vx * step;
      if (isUnpositioned.has(n)) {
        n.y += n.vy * step;
      }
    }

    if (iter % 300 === 0) console.log(`  iter ${iter}/${ITERATIONS}, alpha=${alpha.toFixed(2)}`);
  }
}

console.log("Running force simulation...");
const t0 = performance.now();
simulate();
console.log(`Done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

// bake node data as JSON
const baked = nodes.map(n => ({
  c: n.code, s: n.slug, n: n.name, p: n.prereqStr,
  x: Math.round(n.x * 10) / 10, y: Math.round(n.y * 10) / 10,
  d: n.depth, dc: n.dc, ds: n.ds, dom: n.dom
}));
const bakedJSON = JSON.stringify(baked);

const DOMAIN_COLORS = JSON.stringify([
  "#e06c75", // Early Elementary - soft red
  "#e5c07b", // Late Elementary - warm yellow
  "#98c379", // Pre-Algebra - green
  "#61afef", // Algebra - blue
  "#c678dd", // Geometry & Trig - purple
  "#56b6c2", // Pre-Calculus - cyan
  "#d19a66", // Calculus - orange
]);

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>Khan Academy Knowledge Map</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #000; overflow: hidden; font-family: -apple-system, system-ui, sans-serif; }
canvas { display: block; cursor: grab; }
canvas:active { cursor: grabbing; }
#panel {
  position: fixed; top: 16px; left: 16px; width: 300px; max-height: calc(100vh - 32px);
  background: rgba(0, 0, 0, 0.93); color: #e0e0e0; padding: 16px;
  overflow-y: auto; display: none; z-index: 20;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.6);
}
#panel h2 { font-size: 16px; margin-bottom: 4px; line-height: 1.3; padding-right: 20px; }
#panel .slug { color: #888; font-size: 12px; margin-bottom: 8px; font-family: monospace; }
#panel .meta { color: #999; font-size: 12px; margin-bottom: 12px; line-height: 1.6; }
#panel .meta b { color: #ccc; }
#panel .section { margin-bottom: 12px; }
#panel .section-title { color: #999; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
#panel .prereq-link {
  display: inline-block; background: rgba(255,255,255,0.08); color: #aad;
  padding: 2px 8px; border-radius: 4px; margin: 2px; cursor: pointer;
  font-size: 12px; border: 1px solid rgba(255,255,255,0.06);
  transition: background 0.15s;
}
#panel .prereq-link:hover { background: rgba(255,255,255,0.15); }
#panel .close {
  position: absolute; top: 12px; right: 14px; cursor: pointer;
  color: #888; font-size: 20px; line-height: 1;
}
#panel .close:hover { color: #fff; }
#panel .critical-path { color: #d19a66; font-size: 12px; line-height: 1.8; margin-top: 4px; }
#panel .critical-path span { cursor: pointer; }
#panel .critical-path span:hover { text-decoration: underline; }
#sidebar {
  position: fixed; bottom: 16px; right: 16px; z-index: 15;
  display: flex; flex-direction: column; gap: 8px;
}
#minimap {
  display: block; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;
  background: rgba(0,0,0,0.9); box-shadow: 0 2px 8px rgba(0,0,0,0.4);
}
#legend {
  color: #ccc; font-size: 11px; display: flex; flex-direction: column; gap: 3px;
  padding: 10px 12px; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;
  background: rgba(0,0,0,0.85); box-shadow: 0 2px 8px rgba(0,0,0,0.4);
}
#legend .row { display: flex; align-items: center; gap: 6px; }
#legend .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
#footer {
  position: fixed; top: 16px; right: 20px; z-index: 15;
  text-align: right; line-height: 1.7;
}
#footer .title { color: #ccc; font-size: 16px; font-weight: 600; letter-spacing: 0.5px; }
#footer #stats { color: #666; font-size: 12px; letter-spacing: 0.3px; }
#footer .links { color: #444; font-size: 11px; }
#footer .links a { color: #666; text-decoration: none; }
#footer .links a:hover { color: #bbb; }
@media (max-width: 600px) {
  #panel { left: 8px; right: 8px; width: auto; max-height: 45vh; top: auto; bottom: 8px; }
  #sidebar { display: none; }
  #footer { font-size: 10px; right: 8px; top: 8px; }
  canvas { touch-action: none; }
}
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="panel"></div>
<div id="sidebar">
<div id="legend"></div>
<canvas id="minimap" width="160" height="160"></canvas>
</div>
<div id="footer">
  <div class="title">Math Milestones</div>
  <div id="stats"></div>
  <div class="links"><a href="https://khanacademy.fandom.com/wiki/Knowledge_Map" target="_blank">via Khan Academy</a> · <a href="https://taylor.town" target="_blank">&hearts; taylor.town</a></div>
</div>
<script>
const DATA = ${bakedJSON};
const COLORS = ${DOMAIN_COLORS};
const DOMAINS = ${JSON.stringify(DOMAIN_NAMES)};
const byCode = new Map();
const bySlug = new Map();
const nodes = DATA.map(d => {
  const node = { code: d.c, slug: d.s, name: d.n, prereqStr: d.p, x: d.x, y: d.y, depth: d.d, dc: d.dc, ds: d.ds, dom: d.dom, prereqs: [], dependents: [], color: COLORS[d.dom] };
  byCode.set(d.c, node);
  bySlug.set(d.s, node);
  return node;
});

const edges = [];
for (const node of nodes) {
  if (!node.prereqStr || node.prereqStr === "root") continue;
  for (const tok of node.prereqStr.split(";").map(t => t.trim()).filter(Boolean)) {
    if (tok === "root") continue;
    const resolved = /^\\d+$/.test(tok) ? byCode.get(tok) : bySlug.get(tok);
    if (resolved) {
      node.prereqs.push(resolved);
      resolved.dependents.push(node);
      edges.push([resolved, node]);
    }
  }
}

// world bounds
let worldMinX = Infinity, worldMaxX = -Infinity, worldMinY = Infinity, worldMaxY = -Infinity;
for (const n of nodes) {
  if (n.x < worldMinX) worldMinX = n.x;
  if (n.x > worldMaxX) worldMaxX = n.x;
  if (n.y < worldMinY) worldMinY = n.y;
  if (n.y > worldMaxY) worldMaxY = n.y;
}
const PAD = 150;
worldMinX -= PAD; worldMaxX += PAD; worldMinY -= PAD; worldMaxY += PAD;

const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
let W, H, dpr;
let dirty = true;

function resize() {
  dpr = devicePixelRatio || 1;
  W = innerWidth; H = innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + "px"; canvas.style.height = H + "px";
  dirty = true;
}
resize();
addEventListener("resize", resize);

let scale = Math.min(W / (worldMaxX - worldMinX), H / (worldMaxY - worldMinY)) * 0.9;
let offsetX = (worldMinX + worldMaxX) / 2 - W / scale / 2;
let offsetY = (worldMinY + worldMaxY) / 2 - H / scale / 2;

function worldToScreen(wx, wy) {
  return [(wx - offsetX) * scale, (wy - offsetY) * scale];
}
function screenToWorld(sx, sy) {
  return [sx / scale + offsetX, sy / scale + offsetY];
}

let hovered = null, selected = null;
let dragging = false, dragX = 0, dragY = 0, dragDist = 0;
let criticalPath = [];

canvas.addEventListener("mousedown", e => {
  dragging = true; dragX = e.clientX; dragY = e.clientY; dragDist = 0;
});
addEventListener("mousemove", e => {
  if (dragging) {
    const dx = e.clientX - dragX, dy = e.clientY - dragY;
    dragDist += Math.abs(dx) + Math.abs(dy);
    offsetX -= dx / scale;
    offsetY -= dy / scale;
    dragX = e.clientX; dragY = e.clientY;
    dirty = true;
    return;
  }
  const [wx, wy] = screenToWorld(e.clientX, e.clientY);
  const threshold = 14 / scale;
  let best = null, bestDist = threshold * threshold;
  for (const n of nodes) {
    const dx = n.x - wx, dy = n.y - wy;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist) { bestDist = d2; best = n; }
  }
  if (best !== hovered) { hovered = best; dirty = true; }
  canvas.style.cursor = hovered ? "pointer" : "grab";
});
addEventListener("mouseup", e => {
  const wasDrag = dragDist > 5;
  dragging = false;
  if (wasDrag) return; // don't select after dragging
  // handle click
  const [wx, wy] = screenToWorld(e.clientX, e.clientY);
  const threshold = 14 / scale;
  let best = null, bestDist = threshold * threshold;
  for (const n of nodes) {
    const dx = n.x - wx, dy = n.y - wy;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist) { bestDist = d2; best = n; }
  }
  if (best) {
    selected = best; hovered = best;
    criticalPath = computeCriticalPath(selected);
    dirty = true;
    showPanel(selected);
  } else {
    selected = null; criticalPath = [];
    document.getElementById("panel").style.display = "none";
    dirty = true;
  }
});

canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const [wx, wy] = screenToWorld(e.clientX, e.clientY);
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  scale *= factor;
  scale = Math.max(0.02, Math.min(20, scale));
  offsetX = wx - e.clientX / scale;
  offsetY = wy - e.clientY / scale;
  dirty = true;
}, { passive: false });

// touch support for mobile
let touches = {};
let lastPinchDist = 0;
let touchDragDist = 0;

canvas.addEventListener("touchstart", e => {
  e.preventDefault();
  for (const t of e.changedTouches) touches[t.identifier] = { x: t.clientX, y: t.clientY };
  const ids = Object.keys(touches);
  if (ids.length === 2) {
    const [a, b] = ids.map(id => touches[id]);
    lastPinchDist = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  }
  touchDragDist = 0;
}, { passive: false });

canvas.addEventListener("touchmove", e => {
  e.preventDefault();
  const ids = Object.keys(touches);
  if (ids.length === 1) {
    const t = e.changedTouches[0];
    const prev = touches[t.identifier];
    if (!prev) return;
    const dx = t.clientX - prev.x, dy = t.clientY - prev.y;
    touchDragDist += Math.abs(dx) + Math.abs(dy);
    offsetX -= dx / scale;
    offsetY -= dy / scale;
    touches[t.identifier] = { x: t.clientX, y: t.clientY };
    dirty = true;
  } else if (ids.length === 2) {
    for (const t of e.changedTouches) touches[t.identifier] = { x: t.clientX, y: t.clientY };
    const [a, b] = ids.map(id => touches[id]);
    const dist = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
    if (lastPinchDist > 0) {
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const [wx, wy] = screenToWorld(cx, cy);
      scale *= dist / lastPinchDist;
      scale = Math.max(0.02, Math.min(20, scale));
      offsetX = wx - cx / scale;
      offsetY = wy - cy / scale;
      dirty = true;
    }
    lastPinchDist = dist;
    touchDragDist = 999; // pinch = not a tap
  }
}, { passive: false });

canvas.addEventListener("touchend", e => {
  e.preventDefault();
  for (const t of e.changedTouches) delete touches[t.identifier];
  if (Object.keys(touches).length === 0 && touchDragDist < 15) {
    const t = e.changedTouches[0];
    const [wx, wy] = screenToWorld(t.clientX, t.clientY);
    const threshold = 20 / scale;
    let best = null, bestDist = threshold * threshold;
    for (const n of nodes) {
      const dx = n.x - wx, dy = n.y - wy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist) { bestDist = d2; best = n; }
    }
    if (best) {
      selected = best; hovered = best;
      criticalPath = computeCriticalPath(selected);
      dirty = true;
      showPanel(selected);
    } else {
      selected = null; criticalPath = [];
      document.getElementById("panel").style.display = "none";
      dirty = true;
    }
  }
  lastPinchDist = 0;
}, { passive: false });

// keyboard shortcuts
addEventListener("keydown", e => {
  if (e.key === "Escape") {
    selected = null; criticalPath = [];
    document.getElementById("panel").style.display = "none";
    dirty = true;
  } else if (e.key === "=" || e.key === "+") {
    scale *= 1.2; scale = Math.min(20, scale); dirty = true;
  } else if (e.key === "-") {
    scale /= 1.2; scale = Math.max(0.02, scale); dirty = true;
  } else if (e.key === "ArrowLeft") { offsetX -= 50 / scale; dirty = true; }
  else if (e.key === "ArrowRight") { offsetX += 50 / scale; dirty = true; }
  else if (e.key === "ArrowUp") { offsetY -= 50 / scale; dirty = true; }
  else if (e.key === "ArrowDown") { offsetY += 50 / scale; dirty = true; }
});

// BFS transitive counts
function countUpstream(node) {
  const visited = new Set();
  const q = [...node.prereqs];
  while (q.length) {
    const n = q.pop();
    if (visited.has(n)) continue;
    visited.add(n);
    for (const p of n.prereqs) q.push(p);
  }
  return visited.size;
}
function countDownstream(node) {
  const visited = new Set();
  const q = [...node.dependents];
  while (q.length) {
    const n = q.pop();
    if (visited.has(n)) continue;
    visited.add(n);
    for (const d of n.dependents) q.push(d);
  }
  return visited.size;
}

// Critical path: backtrack from node picking highest-depth prereq
function computeCriticalPath(node) {
  const path = [node];
  let cur = node;
  while (cur.prereqs.length) {
    cur = cur.prereqs.reduce((best, p) => p.depth > best.depth ? p : best);
    path.unshift(cur);
  }
  return path;
}

function navigateTo(node) {
  selected = node; hovered = node;
  criticalPath = computeCriticalPath(node);
  offsetX = node.x - W / scale / 2;
  offsetY = node.y - H / scale / 2;
  dirty = true;
  showPanel(node);
}

function showPanel(node) {
  const panel = document.getElementById("panel");
  panel.style.display = "block";
  const up = countUpstream(node);
  const down = countDownstream(node);
  let html = \`<span class="close" onclick="document.getElementById('panel').style.display='none';selected=null;criticalPath=[];dirty=true;">×</span>\`;
  html += \`<h2>\${node.name}</h2>\`;
  html += \`<div class="slug">\${node.slug}</div>\`;
  html += \`<div class="meta">\`;
  html += \`<b>Domain:</b> \${DOMAINS[node.dom]}<br>\`;
  html += \`<b>Depth:</b> \${node.depth} from root<br>\`;
  html += \`<b>Prerequisites:</b> \${node.prereqs.length} direct · \${up} total upstream<br>\`;
  html += \`<b>Leads to:</b> \${node.dependents.length} direct · \${down} downstream\`;
  html += \`</div>\`;
  if (node.prereqs.length) {
    html += \`<div class="section"><div class="section-title">Prerequisites (\${node.prereqs.length})</div>\`;
    for (const p of node.prereqs) html += \`<span class="prereq-link" data-slug="\${p.slug}">\${p.name}</span>\`;
    html += \`</div>\`;
  }
  if (node.dependents.length) {
    html += \`<div class="section"><div class="section-title">Leads to (\${node.dependents.length})</div>\`;
    for (const d of node.dependents) html += \`<span class="prereq-link" data-slug="\${d.slug}">\${d.name}</span>\`;
    html += \`</div>\`;
  }
  if (criticalPath.length > 1) {
    html += \`<div class="section"><div class="section-title">Critical Path (longest chain)</div>\`;
    html += \`<div class="critical-path">\`;
    html += criticalPath.map(n => \`<span data-slug="\${n.slug}" style="color:\${n === node ? '#fff' : '#d19a66'}">\${n.name}</span>\`).join(\` → \`);
    html += \`</div></div>\`;
  }
  panel.innerHTML = html;
  panel.querySelectorAll(".prereq-link, .critical-path span").forEach(el => {
    el.addEventListener("click", () => {
      const target = bySlug.get(el.dataset.slug);
      if (target) navigateTo(target);
    });
  });
}

// critical path edges set for rendering
const critPathEdges = new Set();
function updateCritPathEdges() {
  critPathEdges.clear();
  for (let i = 0; i < criticalPath.length - 1; i++) {
    critPathEdges.add(criticalPath[i].slug + ">" + criticalPath[i + 1].slug);
  }
}

// find edges on shortest path between selected and hovered (BFS via dependents both ways)
const hoverPathEdges = new Set();
const hoverPathNodes = new Set();
function bfsPath(start, end) {
  // BFS following dependents (forward/downstream direction)
  const parent = new Map();
  const q = [start];
  parent.set(start, null);
  while (q.length) {
    const cur = q.shift();
    if (cur === end) {
      const path = [];
      let n = end;
      while (n) { path.push(n); n = parent.get(n); }
      return path.reverse();
    }
    for (const nb of cur.dependents) {
      if (!parent.has(nb)) { parent.set(nb, cur); q.push(nb); }
    }
  }
  return null;
}
function updateHoverPath() {
  hoverPathEdges.clear();
  hoverPathNodes.clear();
  if (!selected || !hovered || selected === hovered) return;
  // try selected→hovered (hovered is downstream) and hovered→selected (hovered is upstream)
  const path = bfsPath(selected, hovered) || bfsPath(hovered, selected);
  if (!path) return;
  for (let i = 0; i < path.length - 1; i++) {
    hoverPathEdges.add(path[i].slug + ">" + path[i+1].slug);
  }
  for (const n of path) hoverPathNodes.add(n);
}

function render() {
  if (!dirty) { requestAnimationFrame(render); return; }
  dirty = false;
  updateCritPathEdges();
  updateHoverPath();
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  const connectedToSelected = new Set();
  if (selected) {
    for (const p of selected.prereqs) connectedToSelected.add(p);
    for (const d of selected.dependents) connectedToSelected.add(d);
    for (const n of criticalPath) connectedToSelected.add(n);
    for (const n of hoverPathNodes) connectedToSelected.add(n);
  }

  const baseEdgeAlpha = Math.min(0.4, Math.max(0.08, scale * 0.12));

  // Draw edges
  for (const [from, to] of edges) {
    const [x1, y1] = worldToScreen(from.x, from.y);
    const [x2, y2] = worldToScreen(to.x, to.y);
    if (x1 < -50 && x2 < -50 || x1 > W + 50 && x2 > W + 50) continue;
    if (y1 < -50 && y2 < -50 || y1 > H + 50 && y2 > H + 50) continue;

    const edgeKey = from.slug + ">" + to.slug;
    const isCritEdge = critPathEdges.has(edgeKey);
    const isHoverPath = hoverPathEdges.has(edgeKey);
    const isConnected = selected && (from === selected || to === selected);

    if (isHoverPath) {
      ctx.strokeStyle = "rgba(150,220,255,0.85)";
      ctx.lineWidth = 2.5;
    } else if (isCritEdge) {
      ctx.strokeStyle = "rgba(255,215,80,0.85)";
      ctx.lineWidth = 3;
    } else if (isConnected) {
      ctx.strokeStyle = from === selected ? "rgba(100,200,255,0.7)" : "rgba(255,180,100,0.7)";
      ctx.lineWidth = 2;
    } else if (selected) {
      ctx.strokeStyle = \`rgba(255,255,255,0.02)\`;
      ctx.lineWidth = 0.5;
    } else {
      ctx.strokeStyle = \`rgba(255,255,255,\${baseEdgeAlpha})\`;
      ctx.lineWidth = 1;
    }
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const curve = Math.min(len * 0.12, 20);
    const sign = ((+from.code * 7 + (+to.code) * 13) % 3 - 1);
    const cpx = mx + (-dy / len) * curve * sign;
    const cpy = my + (dx / len) * curve * sign;
    ctx.quadraticCurveTo(cpx, cpy, x2, y2);
    ctx.stroke();

    // arrowheads at zoom
    if (scale > 0.3 && (isHoverPath || isCritEdge || isConnected || !selected)) {
      const arrowLen = Math.min(8, 4 + scale * 2);
      const arrowAng = 0.4;
      const t = 0.85;
      const ax = (1-t)*(1-t)*x1 + 2*(1-t)*t*cpx + t*t*x2;
      const ay = (1-t)*(1-t)*y1 + 2*(1-t)*t*cpy + t*t*y2;
      const tx = 2*(1-t)*(cpx-x1) + 2*t*(x2-cpx);
      const ty = 2*(1-t)*(cpy-y1) + 2*t*(y2-cpy);
      const tl = Math.sqrt(tx*tx + ty*ty) || 1;
      const ux = tx/tl, uy = ty/tl;
      ctx.beginPath();
      ctx.moveTo(ax - arrowLen*(ux*Math.cos(arrowAng) - uy*Math.sin(arrowAng)),
                 ay - arrowLen*(uy*Math.cos(arrowAng) + ux*Math.sin(arrowAng)));
      ctx.lineTo(ax, ay);
      ctx.lineTo(ax - arrowLen*(ux*Math.cos(arrowAng) + uy*Math.sin(arrowAng)),
                 ay - arrowLen*(uy*Math.cos(arrowAng) - ux*Math.sin(arrowAng)));
      ctx.stroke();
    }
  }

  // Draw nodes
  const baseR = Math.max(2.5, Math.min(6, scale * 4));
  for (const n of nodes) {
    const [sx, sy] = worldToScreen(n.x, n.y);
    if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) continue;
    const r = baseR * (1 + Math.min(n.dc / 4, 3));
    let alpha = 1;
    if (selected && n !== selected && !connectedToSelected.has(n)) alpha = 0.12;

    ctx.globalAlpha = alpha;

    // glow
    if (r > 3 && alpha > 0.5) {
      ctx.shadowColor = n.color;
      ctx.shadowBlur = r * 2.5;
    }

    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = n.color;
    ctx.fill();
    ctx.shadowBlur = 0;

    if (n === hovered || n === selected) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (criticalPath.includes(n) && selected) {
      ctx.strokeStyle = "rgba(255,215,80,0.8)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Labels on canvas (single pass — no tooltip, no double labels)
  if (scale > 0.1) {
    ctx.textAlign = "center";
    const showAll = scale > 1.5;
    const showImportant = scale > 0.6;
    for (const n of nodes) {
      const isHov = n === hovered;
      // skip nodes that don't qualify for a label
      if (!isHov && !showAll && !(showImportant && n.dc >= 3)) continue;
      if (!isHov && selected && n !== selected && !connectedToSelected.has(n)) continue;
      const [sx, sy] = worldToScreen(n.x, n.y);
      if (sx < -50 || sx > W + 50 || sy < -50 || sy > H + 50) continue;
      const r = baseR * (1 + Math.min(n.dc / 4, 3));
      const fontSize = isHov ? 13 : Math.max(9, Math.min(13, 8 + scale * 2));
      const labelAlpha = isHov ? 1 : Math.min(1, (scale - 0.4) / 0.4);
      ctx.globalAlpha = Math.max(0, labelAlpha);
      ctx.font = \`\${isHov ? 'bold ' : ''}\${fontSize}px -apple-system, system-ui, sans-serif\`;
      const tw = ctx.measureText(n.name).width;
      ctx.fillStyle = isHov ? "rgba(0,0,0,0.8)" : "rgba(0,0,0,0.75)";
      ctx.fillRect(sx - tw / 2 - 3, sy - r - fontSize - 4, tw + 6, fontSize + 4);
      ctx.fillStyle = isHov ? "#fff" : "#eee";
      ctx.fillText(n.name, sx, sy - r - 5);
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();
  renderMinimap();
  requestAnimationFrame(render);
}

const mm = document.getElementById("minimap");
const mmCtx = mm.getContext("2d");
const mmW = 160, mmH = 160;

function renderMinimap() {
  const sx = mmW / (worldMaxX - worldMinX);
  const sy = mmH / (worldMaxY - worldMinY);
  const ms = Math.min(sx, sy);
  const ox = (mmW - (worldMaxX - worldMinX) * ms) / 2;
  const oy = (mmH - (worldMaxY - worldMinY) * ms) / 2;
  mmCtx.fillStyle = "rgba(0,0,0,0.9)";
  mmCtx.fillRect(0, 0, mmW, mmH);
  for (const n of nodes) {
    mmCtx.fillStyle = n === selected ? "#fff" : n.color;
    const sz = n === selected ? 3 : 1.5;
    mmCtx.fillRect(ox + (n.x - worldMinX) * ms, oy + (n.y - worldMinY) * ms, sz, sz);
  }
  const vx = ox + (offsetX - worldMinX) * ms;
  const vy = oy + (offsetY - worldMinY) * ms;
  const vw = (W / scale) * ms;
  const vh = (H / scale) * ms;
  mmCtx.strokeStyle = "rgba(255,255,255,0.6)";
  mmCtx.lineWidth = 1;
  mmCtx.strokeRect(vx, vy, vw, vh);
}

mm.addEventListener("mousedown", e => {
  const rect = mm.getBoundingClientRect();
  const sx = mmW / (worldMaxX - worldMinX);
  const sy = mmH / (worldMaxY - worldMinY);
  const ms = Math.min(sx, sy);
  const ox = (mmW - (worldMaxX - worldMinX) * ms) / 2;
  const oy = (mmH - (worldMaxY - worldMinY) * ms) / 2;
  const pan = ev => {
    offsetX = (ev.clientX - rect.left - ox) / ms + worldMinX - W / scale / 2;
    offsetY = (ev.clientY - rect.top - oy) / ms + worldMinY - H / scale / 2;
    dirty = true;
  };
  pan(e);
  const up = () => { removeEventListener("mousemove", pan); removeEventListener("mouseup", up); };
  addEventListener("mousemove", pan);
  addEventListener("mouseup", up);
});

// legend (reversed so Calculus on top, Early Elem on bottom — matches vertical layout)
const legend = document.getElementById("legend");
const domReversed = DOMAINS.slice().reverse();
const colReversed = COLORS.slice().reverse();
legend.innerHTML = domReversed.map((name, i) => \`<div class="row"><div class="dot" style="background:\${colReversed[i]}"></div>\${name}</div>\`).join("");

document.getElementById("stats").textContent = \`\${nodes.length} exercises · \${edges.length} prerequisites\`;
requestAnimationFrame(render);
</script>
</body>
</html>`;

await Deno.writeTextFile("kakm.html", html);
console.log(`Wrote kakm.html (${(html.length / 1024).toFixed(0)}KB)`);
