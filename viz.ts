#!/usr/bin/env -S deno run --allow-read --allow-write
// Render skills.tsv as an interactive HTML ladder grouped by difficulty band.
// Usage:
//   viz.ts                              → top-2000 most-connected skills (25MB, fast)
//   viz.ts <seed>                       → seed skill + 3-hop neighborhood
//   viz.ts <seed|--all> <out.html>      → custom output path
//   viz.ts --all skills-full.html       → full 101k graph (~64MB, slow to render)

const arg0 = Deno.args[0] ?? "";
const out = Deno.args[1] ?? (arg0 && arg0 !== "--all" ? `skills-${arg0}.html` : "skills.html");
const mode = arg0 === "--all" ? "all" : arg0 ? "seed" : "top";
const seed = mode === "seed" ? arg0 : "";
const TOP_N = 2000;

type Row = { id: string; title: string; description: string; difficulty: number; prereqs: string[]; occupations: string; topics: string };
const lines = Deno.readTextFileSync("skills.tsv").split("\n").filter((l) => l.length);
const rows: Row[] = lines.slice(1).map((l) => {
  const c = l.split("\t");
  return { id: c[0], title: c[1], description: c[2], difficulty: Number(c[3]), prereqs: c[4] ? c[4].split(",") : [], occupations: c[5], topics: c[6] };
});
const byId = new Map(rows.map((r) => [r.id, r] as const));

// Optional neighborhood selection
let keepIds: Set<string>;
if (mode === "top") {
  // Top-N most-connected skills: sum of incoming edges (descendants use this) + outgoing (has these prereqs)
  const inDeg = new Map<string, number>();
  for (const r of rows) for (const p of r.prereqs) inDeg.set(p, (inDeg.get(p) ?? 0) + 1);
  const scored = rows.map((r) => ({ id: r.id, score: (inDeg.get(r.id) ?? 0) + r.prereqs.length }));
  scored.sort((a, b) => b.score - a.score);
  keepIds = new Set(scored.slice(0, TOP_N).map((s) => s.id));
  console.log(`[viz] top-${TOP_N} most-connected skills selected`);
} else if (mode === "seed") {
  const seedRow = byId.get(seed);
  if (!seedRow) throw new Error(`seed not found: ${seed}`);
  const children = new Map<string, string[]>();
  for (const r of rows) for (const p of r.prereqs) {
    const arr = children.get(p) ?? []; arr.push(r.id); children.set(p, arr);
  }
  keepIds = new Set<string>([seed]);
  const expand = (start: string, hops: number, neighbors: (id: string) => string[]) => {
    let frontier = [start];
    for (let h = 0; h < hops; h++) {
      const next: string[] = [];
      for (const u of frontier) for (const v of neighbors(u)) if (!keepIds.has(v)) { keepIds.add(v); next.push(v); }
      frontier = next;
    }
  };
  expand(seed, 3, (u) => byId.get(u)?.prereqs ?? []);
  expand(seed, 3, (u) => children.get(u) ?? []);
  console.log(`[viz] seed=${seed} neighborhood size=${keepIds.size}`);
} else {
  keepIds = new Set(rows.map((r) => r.id));
}

const visible = rows.filter((r) => keepIds.has(r.id));

// Group by band
const byBand = new Map<number, Row[]>();
for (const r of visible) {
  const arr = byBand.get(r.difficulty) ?? []; arr.push(r); byBand.set(r.difficulty, arr);
}
for (const [, arr] of byBand) arr.sort((a, b) => a.title.localeCompare(b.title));

// Build edge list for drawing
const edges: { src: string; dst: string }[] = [];
for (const r of visible) for (const p of r.prereqs) if (keepIds.has(p)) edges.push({ src: p, dst: r.id });

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Skill Tree${seed ? ` · ${seed}` : ""}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 0; background: #0a0a0a; color: #eee; }
  header { position: sticky; top: 0; background: #111; border-bottom: 1px solid #333; padding: 10px 20px; z-index: 10; }
  header h1 { margin: 0; font-size: 14px; font-weight: normal; color: #aaa; }
  header input { background: #222; color: #eee; border: 1px solid #444; padding: 4px 8px; font-size: 13px; width: 300px; }
  main { padding: 20px; }
  .band { margin-bottom: 16px; }
  .band h2 { font-size: 12px; color: #888; margin: 0 0 6px; padding-bottom: 4px; border-bottom: 1px solid #222; }
  .skills { display: flex; flex-wrap: wrap; gap: 4px; }
  .skill { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; transition: background 0.1s; max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .skill:hover { background: #2a2a2a; border-color: #555; }
  .skill.highlighted { background: #2d4a2d; border-color: #5a8a5a; }
  .skill.prereq-of-hover { background: #2d3a5a; border-color: #5a7acc; }
  .skill.descendant-of-hover { background: #5a2d3a; border-color: #cc5a7a; }
  aside { position: fixed; right: 20px; top: 80px; width: 320px; max-height: 70vh; overflow: auto; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 16px; font-size: 12px; display: none; }
  aside.shown { display: block; }
  aside h3 { margin: 0 0 8px; font-size: 13px; }
  aside .meta { color: #888; font-size: 10px; margin-bottom: 8px; }
  aside section { margin-top: 10px; }
  aside section h4 { font-size: 11px; color: #aaa; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  aside a { color: #6af; text-decoration: none; display: block; padding: 2px 0; }
  aside a:hover { text-decoration: underline; }
  .stats { color: #666; font-size: 11px; margin-left: 20px; }
</style>
</head>
<body>
<header>
  <h1>Skill Tree <span class="stats">${visible.length} skills · ${edges.length} edges${seed ? ` · focus: ${seed}` : ""}</span></h1>
  <input id="search" placeholder="search title or id…" autofocus>
</header>
<main>
${Array.from(byBand.entries()).sort(([a], [b]) => a - b).map(([band, skills]) => `
<section class="band" data-band="${band}">
  <h2>band ${band} · ${skills.length} skills</h2>
  <div class="skills">
    ${skills.map((s) => `<div class="skill" data-id="${s.id}">${escape(s.title)}</div>`).join("")}
  </div>
</section>
`).join("")}
</main>
<aside id="detail"></aside>
<script>
const DATA = ${JSON.stringify(Object.fromEntries(visible.map((r) => [r.id, { title: r.title, description: r.description, difficulty: r.difficulty, prereqs: r.prereqs.filter((p) => keepIds.has(p)), occupations: r.occupations, topics: r.topics }])))};
const CHILDREN = {};
for (const [id, row] of Object.entries(DATA)) for (const p of row.prereqs) { (CHILDREN[p] ||= []).push(id); }

const detail = document.getElementById("detail");
const search = document.getElementById("search");

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function clearHighlights() {
  document.querySelectorAll(".skill").forEach((el) => el.classList.remove("highlighted", "prereq-of-hover", "descendant-of-hover"));
}

function showDetail(id) {
  const row = DATA[id];
  if (!row) return;
  const prereqLinks = row.prereqs.map((p) => DATA[p] ? '<a href="#" data-id="' + p + '">b' + DATA[p].difficulty + ' ' + esc(DATA[p].title) + '</a>' : '').join("");
  const childLinks = (CHILDREN[id] || []).map((c) => '<a href="#" data-id="' + c + '">b' + DATA[c].difficulty + ' ' + esc(DATA[c].title) + '</a>').join("");
  detail.innerHTML = '<h3>' + esc(row.title) + '</h3>' +
    '<div class="meta">b' + row.difficulty + ' · ' + esc(id) + '</div>' +
    (row.description ? '<div>' + esc(row.description) + '</div>' : '') +
    (row.topics ? '<section><h4>Topics</h4><div>' + esc(row.topics) + '</div></section>' : '') +
    (row.occupations ? '<section><h4>Occupations</h4><div>' + esc(row.occupations) + '</div></section>' : '') +
    (prereqLinks ? '<section><h4>Prereqs (' + row.prereqs.length + ')</h4>' + prereqLinks + '</section>' : '<section><h4>Prereqs</h4><div style="color:#666">none</div></section>') +
    (childLinks ? '<section><h4>Children (' + (CHILDREN[id] || []).length + ')</h4>' + childLinks + '</section>' : '');
  detail.classList.add("shown");
  clearHighlights();
  document.querySelectorAll('[data-id="' + id + '"]').forEach((el) => el.classList.add("highlighted"));
  for (const p of row.prereqs) document.querySelectorAll('.skill[data-id="' + p + '"]').forEach((el) => el.classList.add("prereq-of-hover"));
  for (const c of (CHILDREN[id] || [])) document.querySelectorAll('.skill[data-id="' + c + '"]').forEach((el) => el.classList.add("descendant-of-hover"));
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-id]");
  if (el) { e.preventDefault(); showDetail(el.dataset.id); }
});

search.addEventListener("input", () => {
  const q = search.value.toLowerCase();
  document.querySelectorAll(".skill").forEach((el) => {
    el.style.display = q === "" || el.dataset.id.includes(q) || el.textContent.toLowerCase().includes(q) ? "" : "none";
  });
});
</script>
</body>
</html>`;

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

Deno.writeTextFileSync(out, html);
const sz = Deno.statSync(out).size;
console.log(`[viz] wrote ${out} (${(sz / 1024 / 1024).toFixed(1)}MB, ${visible.length} skills, ${edges.length} edges)`);
