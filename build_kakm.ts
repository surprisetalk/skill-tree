const tsv = await Deno.readTextFile("data/khanacademy/khandata.tsv");
const lines = tsv.split("\n").filter((l, i) => i > 1 && l.trim());

// parse
type Node = { code: string; slug: string; name: string; prereqStr: string; origH: number | null; origV: number | null; x: number; y: number; vx: number; vy: number; prereqs: Node[]; dependents: Node[]; color: string };
const nodes: Node[] = [];
const byCode = new Map<string, Node>();
const bySlug = new Map<string, Node>();

for (const line of lines) {
  const [code, slug, prereqStr, hStr, vStr, displayName] = line.split("\t");
  if (!slug) continue;
  const h = hStr === "x" ? null : +hStr;
  const v = vStr === "x" ? null : +vStr;
  const node: Node = { code, slug, name: (displayName || slug).replace(/\\/g, '"'), prereqStr: prereqStr || "", origH: h, origV: v, x: 0, y: 0, vx: 0, vy: 0, prereqs: [], dependents: [], color: "" };
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

// initialize positions from rank-based layout
const positioned = nodes.filter(n => n.origH !== null);
const unpositioned = nodes.filter(n => n.origH === null);
const uniqueH = [...new Set(positioned.map(n => n.origH!))].sort((a, b) => a - b);
const uniqueV = [...new Set(positioned.map(n => n.origV!))].sort((a, b) => a - b);
const hRank = new Map<number, number>(); uniqueH.forEach((h, i) => hRank.set(h, i));
const vRank = new Map<number, number>(); uniqueV.forEach((v, i) => vRank.set(v, i));
const minH = uniqueH[0], maxH = uniqueH[uniqueH.length - 1];

const INIT_SX = 60, INIT_SY = 60;
for (const n of positioned) {
  n.x = hRank.get(n.origH!)! * INIT_SX;
  n.y = vRank.get(n.origV!)! * INIT_SY;
}

// place unpositioned near prereqs — iterate multiple passes so chains resolve
const unposSet = new Set(unpositioned);
for (let pass = 0; pass < 3; pass++) {
  for (const n of unpositioned) {
    const allNeighbors = [...n.prereqs, ...n.dependents].filter(p => !unposSet.has(p) || pass > 0);
    if (allNeighbors.length) {
      let sx = 0, sy = 0;
      for (const p of allNeighbors) { sx += p.x; sy += p.y; }
      n.x = sx / allNeighbors.length + (Math.random() - 0.5) * 100;
      n.y = sy / allNeighbors.length + (Math.random() - 0.5) * 100;
    } else if (pass === 0) {
      n.x = uniqueH.length * INIT_SX + Math.random() * 400;
      n.y = uniqueV.length * INIT_SY / 2 + (Math.random() - 0.5) * 600;
    }
  }
}

// save anchor positions — unpositioned nodes get weak anchors (marked with flag)
const isUnpositioned = new Set(unpositioned);
const anchors = nodes.map(n => ({ x: n.x, y: n.y, weak: isUnpositioned.has(n) }));

// force-directed simulation
const IDEAL_LEN = 50;
const ITERATIONS = 800;
const N = nodes.length;

function simulate() {
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const alpha = 1 - iter / ITERATIONS;
    const step = 0.3 * alpha + 0.05;
    const repulseRadius = 80;

    for (const n of nodes) { n.vx = 0; n.vy = 0; }

    // spatial grid for repulsion
    const cellSize = repulseRadius;
    const grid = new Map<string, Node[]>();
    for (const n of nodes) {
      const key = Math.floor(n.x / cellSize) + "," + Math.floor(n.y / cellSize);
      const cell = grid.get(key);
      if (cell) cell.push(n); else grid.set(key, [n]);
    }

    const repulseStrength = 400;
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

    // strong springs on edges — pull connected nodes together
    const springK = 0.8;
    for (const [a, b] of edges) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.1;
      const f = springK * (d - IDEAL_LEN) / d;
      const fx = dx * f, fy = dy * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }

    // anchor to preserve structure — much weaker for unpositioned nodes
    for (let i = 0; i < N; i++) {
      const w = anchors[i].weak ? 0.005 : 0.08;
      const wy = anchors[i].weak ? 0.005 : 0.03;
      nodes[i].vx += (anchors[i].x - nodes[i].x) * w;
      nodes[i].vy += (anchors[i].y - nodes[i].y) * wy;
    }

    for (const n of nodes) {
      const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (speed > 15) { n.vx = n.vx / speed * 15; n.vy = n.vy / speed * 15; }
      n.x += n.vx * step;
      n.y += n.vy * step;
    }

    if (iter % 200 === 0) console.log(`  iter ${iter}/${ITERATIONS}, alpha=${alpha.toFixed(2)}`);
  }
}

console.log("Running force simulation...");
const t0 = performance.now();
simulate();
console.log(`Done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

// compute colors — unpositioned nodes inherit from their neighbors' average H
const hRange = maxH - minH || 1;
for (const n of unpositioned) {
  const neighbors = [...n.prereqs, ...n.dependents].filter(p => p.origH !== null);
  if (neighbors.length) {
    n.origH = neighbors.reduce((s, p) => s + p.origH!, 0) / neighbors.length;
  }
}
for (const n of nodes) {
  const t = Math.max(0, Math.min(1, ((n.origH ?? maxH) - minH) / hRange));
  const hue = 220 - t * 280;
  n.color = `hsl(${((hue % 360) + 360) % 360}, 65%, 55%)`;
}

// bake node data as JSON
const baked = nodes.map(n => ({
  c: n.code, s: n.slug, n: n.name, p: n.prereqStr,
  x: Math.round(n.x * 10) / 10, y: Math.round(n.y * 10) / 10,
  h: n.origH, v: n.origV, cl: n.color
}));
const bakedJSON = JSON.stringify(baked);

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Khan Academy Knowledge Map</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #0f0f1a; overflow: hidden; font-family: -apple-system, system-ui, sans-serif; }
canvas { display: block; cursor: grab; }
canvas:active { cursor: grabbing; }
#tooltip {
  position: fixed; pointer-events: none; display: none;
  background: rgba(20, 20, 40, 0.95); color: #e0e0e0; padding: 6px 10px;
  border-radius: 6px; font-size: 13px; max-width: 300px;
  border: 1px solid rgba(255,255,255,0.15); z-index: 10;
  box-shadow: 0 4px 12px rgba(0,0,0,0.5);
}
#tooltip .code { color: #888; font-size: 11px; }
#panel {
  position: fixed; top: 0; right: 0; width: 320px; height: 100%;
  background: rgba(15, 15, 30, 0.97); color: #e0e0e0; padding: 20px;
  overflow-y: auto; display: none; z-index: 20;
  border-left: 1px solid rgba(255,255,255,0.1);
  box-shadow: -4px 0 20px rgba(0,0,0,0.4);
}
#panel h2 { font-size: 18px; margin-bottom: 4px; line-height: 1.3; }
#panel .slug { color: #888; font-size: 12px; margin-bottom: 12px; font-family: monospace; }
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
#panel .pos { color: #777; font-size: 12px; }
#minimap {
  position: fixed; bottom: 16px; right: 16px; z-index: 15;
  border: 1px solid rgba(255,255,255,0.15); border-radius: 6px;
  background: rgba(15, 15, 30, 0.9);
  box-shadow: 0 2px 8px rgba(0,0,0,0.4);
}
#legend {
  position: fixed; bottom: 16px; left: 16px; z-index: 15;
  color: #999; font-size: 11px; display: flex; align-items: center; gap: 6px;
}
#legend canvas { border-radius: 3px; }
#stats {
  position: fixed; top: 12px; left: 16px; z-index: 15;
  color: #666; font-size: 12px;
}
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="tooltip"></div>
<div id="panel"></div>
<canvas id="minimap" width="240" height="140"></canvas>
<div id="legend"><canvas id="legendbar" width="200" height="10"></canvas><span>K &rarr; Calculus</span></div>
<div id="stats"></div>
<script>
const DATA = ${bakedJSON};
const byCode = new Map();
const bySlug = new Map();
const nodes = DATA.map(d => {
  const node = { code: d.c, slug: d.s, name: d.n, prereqStr: d.p, origH: d.h, origV: d.v, x: d.x, y: d.y, prereqs: [], dependents: [], color: d.cl };
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
const PAD = 100;
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
let dragging = false, dragX = 0, dragY = 0;

canvas.addEventListener("mousedown", e => {
  dragging = true; dragX = e.clientX; dragY = e.clientY;
});
addEventListener("mousemove", e => {
  if (dragging) {
    offsetX -= (e.clientX - dragX) / scale;
    offsetY -= (e.clientY - dragY) / scale;
    dragX = e.clientX; dragY = e.clientY;
    dirty = true;
    return;
  }
  const [wx, wy] = screenToWorld(e.clientX, e.clientY);
  const threshold = 12 / scale;
  let best = null, bestDist = threshold * threshold;
  for (const n of nodes) {
    const dx = n.x - wx, dy = n.y - wy;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist) { bestDist = d2; best = n; }
  }
  if (best !== hovered) { hovered = best; dirty = true; }
  const tip = document.getElementById("tooltip");
  if (hovered) {
    tip.style.display = "block";
    tip.innerHTML = \`<b>\${hovered.name}</b><br><span class="code">#\${hovered.code} &middot; \${hovered.slug}</span>\`;
    let tx = e.clientX + 14, ty = e.clientY + 14;
    if (tx + 300 > W) tx = e.clientX - 300;
    if (ty + 60 > H) ty = e.clientY - 60;
    tip.style.left = tx + "px"; tip.style.top = ty + "px";
    canvas.style.cursor = "pointer";
  } else {
    tip.style.display = "none";
    canvas.style.cursor = dragging ? "grabbing" : "grab";
  }
});
addEventListener("mouseup", () => { dragging = false; });

canvas.addEventListener("click", e => {
  if (!hovered) { selected = null; document.getElementById("panel").style.display = "none"; dirty = true; return; }
  selected = hovered;
  dirty = true;
  showPanel(selected);
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

function showPanel(node) {
  const panel = document.getElementById("panel");
  panel.style.display = "block";
  let html = \`<span class="close" onclick="document.getElementById('panel').style.display='none';selected=null;dirty=true;">&times;</span>\`;
  html += \`<h2>\${node.name}</h2>\`;
  html += \`<div class="slug">\${node.slug}</div>\`;
  html += \`<div class="pos">Code #\${node.code}</div>\`;
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
  panel.innerHTML = html;
  panel.querySelectorAll(".prereq-link").forEach(el => {
    el.addEventListener("click", () => {
      const target = bySlug.get(el.dataset.slug);
      if (target) {
        selected = target; hovered = target;
        offsetX = target.x - W / scale / 2;
        offsetY = target.y - H / scale / 2;
        dirty = true;
        showPanel(target);
      }
    });
  });
}

function render() {
  if (!dirty) { requestAnimationFrame(render); return; }
  dirty = false;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#0f0f1a";
  ctx.fillRect(0, 0, W, H);

  const connectedToSelected = new Set();
  if (selected) {
    for (const p of selected.prereqs) connectedToSelected.add(p);
    for (const d of selected.dependents) connectedToSelected.add(d);
  }

  const edgeAlpha = Math.min(0.35, Math.max(0.04, scale * 0.08));
  ctx.lineWidth = 1;
  for (const [from, to] of edges) {
    const [x1, y1] = worldToScreen(from.x, from.y);
    const [x2, y2] = worldToScreen(to.x, to.y);
    if (x1 < -50 && x2 < -50 || x1 > W + 50 && x2 > W + 50) continue;
    if (y1 < -50 && y2 < -50 || y1 > H + 50 && y2 > H + 50) continue;

    if (selected && (from === selected || to === selected)) {
      ctx.strokeStyle = from === selected ? "rgba(100,200,255,0.7)" : "rgba(255,180,100,0.7)";
      ctx.lineWidth = 2;
    } else if (selected) {
      ctx.strokeStyle = \`rgba(255,255,255,\${edgeAlpha * 0.3})\`;
      ctx.lineWidth = 0.5;
    } else {
      ctx.strokeStyle = \`rgba(255,255,255,\${edgeAlpha})\`;
      ctx.lineWidth = 1;
    }
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const curve = Math.min(len * 0.15, 25);
    const sign = ((+from.code * 7 + (+to.code) * 13) % 3 - 1);
    ctx.quadraticCurveTo(mx + (-dy / len) * curve * sign, my + (dx / len) * curve * sign, x2, y2);
    ctx.stroke();
  }

  const r = Math.max(2, Math.min(7, scale * 4));
  for (const n of nodes) {
    const [sx, sy] = worldToScreen(n.x, n.y);
    if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) continue;
    let alpha = 1;
    if (selected && n !== selected && !connectedToSelected.has(n)) alpha = 0.15;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = n.color;
    ctx.fill();
    if (n === hovered || n === selected) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  if (hovered && scale > 0.15) {
    const [sx, sy] = worldToScreen(hovered.x, hovered.y);
    ctx.font = \`bold \${Math.max(11, Math.min(14, 10 / scale))}px -apple-system, system-ui, sans-serif\`;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    const tw = ctx.measureText(hovered.name).width;
    ctx.fillRect(sx - tw / 2 - 4, sy - r - 22, tw + 8, 18);
    ctx.fillStyle = "#fff";
    ctx.fillText(hovered.name, sx, sy - r - 8);
  }

  ctx.restore();
  renderMinimap();
  requestAnimationFrame(render);
}

const mm = document.getElementById("minimap");
const mmCtx = mm.getContext("2d");
const mmW = 240, mmH = 140;

function renderMinimap() {
  const sx = mmW / (worldMaxX - worldMinX);
  const sy = mmH / (worldMaxY - worldMinY);
  const ms = Math.min(sx, sy);
  mmCtx.fillStyle = "rgba(15,15,30,0.9)";
  mmCtx.fillRect(0, 0, mmW, mmH);
  for (const n of nodes) {
    mmCtx.fillStyle = n === selected ? "#fff" : n.color;
    mmCtx.fillRect((n.x - worldMinX) * ms, (n.y - worldMinY) * ms, 1.5, 1.5);
  }
  const vx = (offsetX - worldMinX) * ms;
  const vy = (offsetY - worldMinY) * ms;
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
  const pan = ev => {
    offsetX = (ev.clientX - rect.left) / ms + worldMinX - W / scale / 2;
    offsetY = (ev.clientY - rect.top) / ms + worldMinY - H / scale / 2;
    dirty = true;
  };
  pan(e);
  const up = () => { removeEventListener("mousemove", pan); removeEventListener("mouseup", up); };
  addEventListener("mousemove", pan);
  addEventListener("mouseup", up);
});

const lb = document.getElementById("legendbar");
const lbCtx = lb.getContext("2d");
for (let i = 0; i < 200; i++) {
  const t = i / 199;
  const hue = 220 - t * 280;
  lbCtx.fillStyle = \`hsl(\${((hue % 360) + 360) % 360}, 65%, 55%)\`;
  lbCtx.fillRect(i, 0, 1, 10);
}

document.getElementById("stats").textContent = \`\${nodes.length} exercises \u00b7 \${edges.length} prerequisites\`;
requestAnimationFrame(render);
</script>
</body>
</html>`;

await Deno.writeTextFile("kakm.html", html);
console.log(`Wrote kakm.html (${(html.length / 1024).toFixed(0)}KB)`);
