// deno run --allow-read --allow-write spine_html.ts
// Render spine_skills.tsv + spine_prereqs.tsv as a single-file interactive HTML.
// Layout: x-axis = grade band, y-axis = depth in topological order.
// Canvas for edges, positioned DOM for searchable/hoverable nodes.

type Skill = {
  id: string; label: string; source: string; tags: string;
  gs: number; ge: number; depth: number;
};

const sLines = (await Deno.readTextFile("spine_skills.tsv")).split("\n").filter(x => x);
const sH = sLines[0].split("\t");
const col = (n: string) => sH.indexOf(n);
const iId = col("id"), iLabel = col("label"), iSrc = col("source"),
  iTags = col("tags"), iGs = col("grade_start"), iGe = col("grade_end");

const skills = new Map<string, Skill>();
for (let i = 1; i < sLines.length; i++) {
  const r = sLines[i].split("\t");
  const gs = r[iGs] === "" ? NaN : +r[iGs];
  const ge = r[iGe] === "" ? NaN : +r[iGe];
  const mid = isNaN(gs) ? (isNaN(ge) ? 13 : ge) : (isNaN(ge) ? gs : (gs + ge) / 2);
  skills.set(r[iId], {
    id: r[iId], label: r[iLabel] ?? "", source: r[iSrc] ?? "",
    tags: r[iTags] ?? "", gs: isNaN(gs) ? mid : gs, ge: isNaN(ge) ? mid : ge, depth: 0,
  });
}

const pLines = (await Deno.readTextFile("spine_prereqs.tsv")).split("\n").filter(x => x);
type Edge = { from: string; to: string; source: string; type: string };
const edges: Edge[] = [];
const depthInEdges = new Map<string, string[]>(); // prerequisite-only, for depth
for (let i = 1; i < pLines.length; i++) {
  const [prereq, skill, src, type] = pLines[i].split("\t");
  if (!skills.has(prereq) || !skills.has(skill)) continue;
  edges.push({ from: prereq, to: skill, source: src, type });
  if (type === "prerequisite" && src !== "junyi_logs" && src !== "assistments_logs") {
    (depthInEdges.get(skill) ?? depthInEdges.set(skill, []).get(skill)!).push(prereq);
  }
}

// Longest-path depth (DAG is guaranteed cycle-free by prior pipeline).
const memo = new Map<string, number>();
function depth(id: string, stack = new Set<string>()): number {
  if (memo.has(id)) return memo.get(id)!;
  if (stack.has(id)) return 0; // defensive
  stack.add(id);
  let d = 0;
  for (const p of depthInEdges.get(id) ?? []) d = Math.max(d, depth(p, stack) + 1);
  stack.delete(id);
  memo.set(id, d);
  return d;
}
for (const [id, s] of skills) s.depth = depth(id);

const maxDepth = Math.max(...[...skills.values()].map(s => s.depth));
console.log(`skills: ${skills.size}, edges: ${edges.length}, max depth: ${maxDepth}`);

// Compact payload
const nodePayload = [...skills.values()].map(s => ({
  i: s.id, l: s.label, s: s.source, g: (s.gs + s.ge) / 2, d: s.depth, t: s.tags,
}));
const edgePayload = edges.map(e => ({ f: e.from, t: e.to, s: e.source }));

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>skill-tree spine (${skills.size} skills, ${edges.length} edges)</title>
<style>
  html,body{margin:0;height:100%;background:#0e0e12;color:#ddd;font:13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;overflow:hidden}
  #top{position:fixed;top:0;left:0;right:0;padding:8px 12px;background:#000a;z-index:10;display:flex;gap:12px;align-items:center}
  #top input{background:#222;border:1px solid #444;color:#ddd;padding:4px 8px;width:260px;border-radius:4px}
  #top .stat{color:#888;font-size:12px}
  #legend{display:flex;gap:10px;flex-wrap:wrap}
  .chip{padding:2px 6px;border-radius:3px;font-size:11px}
  #canvas-wrap{position:absolute;top:40px;left:0;right:0;bottom:0;overflow:auto}
  canvas{display:block;position:absolute;top:0;left:0}
  #nodes{position:absolute;top:0;left:0}
  .node{position:absolute;width:10px;height:10px;border-radius:50%;transform:translate(-50%,-50%);cursor:pointer;border:1px solid #0008}
  .node.hit{width:14px;height:14px;border:2px solid #fff;z-index:5}
  #tip{position:fixed;background:#000d;border:1px solid #444;padding:6px 10px;max-width:320px;border-radius:4px;pointer-events:none;display:none;z-index:20;font-size:12px}
  #tip .t{color:#fff;font-weight:600;margin-bottom:4px}
  #tip .m{color:#999;font-size:11px}
</style></head>
<body>
<div id="top">
  <input id="q" placeholder="search label…">
  <span class="stat" id="stat"></span>
  <div id="legend"></div>
</div>
<div id="canvas-wrap"><canvas id="edges"></canvas><div id="nodes"></div></div>
<div id="tip"></div>
<script>
const NODES = ${JSON.stringify(nodePayload)};
const EDGES = ${JSON.stringify(edgePayload)};
const COLS = {khan:"#4f8",metacademy:"#f84",alcpl:"#fa4",mooccubex:"#4af",junyi:"#84f",assistments:"#fc4",ngss:"#4fa",onet:"#faa",asn:"#a8f",fos:"#aaf",wikidata:"#888"};
const W_PER_GRADE=60, H_PER_DEPTH=18, PAD_X=80, PAD_Y=40;
const MIN_G = Math.min(...NODES.map(n=>n.g)), MAX_G = Math.max(...NODES.map(n=>n.g));
const MAX_D = Math.max(...NODES.map(n=>n.d));
const W = PAD_X*2 + (MAX_G-MIN_G+1)*W_PER_GRADE*4;
const H = PAD_Y*2 + (MAX_D+1)*H_PER_DEPTH;

// assign x,y. stack within same (grade, depth) horizontally.
const bucket = new Map();
for(const n of NODES){
  const gx = Math.round(n.g*2);
  const key = gx+":"+n.d;
  const b = bucket.get(key) ?? []; b.push(n); bucket.set(key,b);
}
const pos = new Map();
for(const [key,ns] of bucket){
  const [gx,d] = key.split(":").map(Number);
  ns.sort((a,b)=>a.l.localeCompare(b.l));
  for(let i=0;i<ns.length;i++){
    const jitter = (i - (ns.length-1)/2) * 4;
    const x = PAD_X + ((gx/2)-MIN_G)*W_PER_GRADE*4 + jitter;
    const y = PAD_Y + d*H_PER_DEPTH;
    pos.set(ns[i].i, {x,y,n:ns[i]});
  }
}

const wrap = document.getElementById("canvas-wrap");
const cvs = document.getElementById("edges"); cvs.width=W; cvs.height=H;
const nodesEl = document.getElementById("nodes");
nodesEl.style.width=W+"px"; nodesEl.style.height=H+"px";
const ctx = cvs.getContext("2d");
ctx.lineWidth=0.3; ctx.strokeStyle="#fff2";
for(const e of EDGES){
  const a=pos.get(e.f), b=pos.get(e.t); if(!a||!b) continue;
  ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
}

const byId = new Map();
for(const [id,p] of pos){
  const d = document.createElement("div");
  d.className="node"; d.style.left=p.x+"px"; d.style.top=p.y+"px";
  d.style.background = COLS[p.n.s] ?? "#666";
  d.dataset.id = id;
  nodesEl.appendChild(d);
  byId.set(id, d);
}

const tip = document.getElementById("tip");
nodesEl.addEventListener("mousemove", ev => {
  const t = ev.target.closest(".node"); if(!t){ tip.style.display="none"; return; }
  const p = pos.get(t.dataset.id);
  tip.innerHTML = '<div class="t">'+p.n.l+'</div><div class="m">'+p.n.s+' · grade '+p.n.g.toFixed(1)+' · depth '+p.n.d+'</div><div class="m">'+p.n.i+'</div>';
  tip.style.left=(ev.clientX+12)+"px"; tip.style.top=(ev.clientY+12)+"px"; tip.style.display="block";
});
nodesEl.addEventListener("mouseleave", ()=>tip.style.display="none");

document.getElementById("stat").textContent = NODES.length.toLocaleString()+' skills · '+EDGES.length.toLocaleString()+' edges';
const leg = document.getElementById("legend");
const counts = {}; for(const n of NODES) counts[n.s]=(counts[n.s]??0)+1;
for(const [s,n] of Object.entries(counts).sort((a,b)=>b[1]-a[1])){
  const c = document.createElement("span"); c.className="chip";
  c.style.background = (COLS[s] ?? "#666")+"33"; c.style.color = COLS[s] ?? "#aaa";
  c.textContent = s+" "+n;
  leg.appendChild(c);
}

const q = document.getElementById("q");
q.addEventListener("input", () => {
  const s = q.value.toLowerCase().trim();
  for(const [id,d] of byId){
    const p = pos.get(id);
    const hit = s && p.n.l.toLowerCase().includes(s);
    d.classList.toggle("hit", hit);
    d.style.opacity = s && !hit ? 0.15 : 1;
  }
});
</script></body></html>`;

await Deno.writeTextFile("spine.html", html);
const stat = await Deno.stat("spine.html");
console.log(`spine.html: ${(stat.size / 1024).toFixed(0)} KB`);
