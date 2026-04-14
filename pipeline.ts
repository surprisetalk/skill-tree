#!/usr/bin/env -S deno run --allow-all
// Skill-tree pipeline. Monolithic by design.
// Usage: deno run --allow-all pipeline.ts [stage]
// Stages: list, embed, tag, difficulty, prereq, finalize. Default: all.

import { TextLineStream } from "jsr:@std/streams@1/text-line-stream";
// Load .env via `deno run --env-file=.env ...` to populate ANTHROPIC_API_KEY etc.

const BUILD = "build";
await Deno.mkdir(BUILD, { recursive: true });

type Skill = { id: string; title: string; description: string; sources: string[]; tags: string[] };

// ---------- util ----------

const slugify = (s: string) =>
  s.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);

const parseTsv = (text: string): string[][] =>
  text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.length).map((l) => l.split("\t"));

// RFC 4180 CSV parser (handles quotes, embedded commas/newlines)
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c === "\r") { /* skip */ }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

function writeStats(stage: number, stats: Record<string, unknown>) {
  const path = `${BUILD}/${stage}_stats.json`;
  Deno.writeTextFileSync(path, JSON.stringify(stats, null, 2));
  console.log(`[stage ${stage}] stats →`, path);
  console.log(JSON.stringify(stats, null, 2));
}

// ---------- stage 1: list ----------

function stage1List() {
  console.log("[stage 1] reading sources…");
  const summarizeCache = loadSummarizeCache();
  const onetDescCache = loadOnetDescCache();
  console.log(`[stage 1] caches: summarize=${summarizeCache.size}, onet_desc=${onetDescCache.size}`);
  const raw: Skill[] = [];

  // ESCO
  {
    const text = Deno.readTextFileSync("data/esco/skills_en.csv");
    const rows = parseCsv(text);
    const header = rows[0];
    const iLabel = header.indexOf("preferredLabel");
    const iDesc = header.indexOf("description");
    const iDef = header.indexOf("definition");
    const iType = header.indexOf("skillType");
    let n = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r[iLabel]) continue;
      raw.push({
        id: "",
        title: r[iLabel].trim(),
        description: (r[iDesc] || r[iDef] || "").trim(),
        sources: ["esco"],
        tags: r[iType] ? [`esco:${r[iType]}`] : ["esco"],
      });
      n++;
    }
    console.log(`  esco: ${n}`);
  }

  // ONET Skills / Knowledge / Abilities — dedupe by Element ID, label from Content Model Reference
  {
    const cmrText = Deno.readTextFileSync("data/onet/Content Model Reference.txt");
    const cmrRows = parseTsv(cmrText);
    const cmrHdr = cmrRows[0];
    const cmrIdI = cmrHdr.indexOf("Element ID");
    const cmrNameI = cmrHdr.indexOf("Element Name");
    const cmrDescI = cmrHdr.indexOf("Description");
    const cmr = new Map<string, { name: string; desc: string }>();
    for (let i = 1; i < cmrRows.length; i++) {
      const r = cmrRows[i];
      cmr.set(r[cmrIdI], { name: r[cmrNameI], desc: r[cmrDescI] || "" });
    }

    const onetFiles = [
      { path: "data/onet/Skills.txt", tag: "onet:skill" },
      { path: "data/onet/Knowledge.txt", tag: "onet:knowledge" },
      { path: "data/onet/Abilities.txt", tag: "onet:ability" },
    ];
    for (const { path, tag } of onetFiles) {
      const text = Deno.readTextFileSync(path);
      const rows = parseTsv(text);
      const hdr = rows[0];
      const idI = hdr.indexOf("Element ID");
      const seen = new Set<string>();
      let n = 0;
      for (let i = 1; i < rows.length; i++) {
        const eid = rows[i][idI];
        if (!eid || seen.has(eid)) continue;
        seen.add(eid);
        const meta = cmr.get(eid);
        if (!meta) throw new Error(`ONET element ${eid} missing from Content Model Reference`);
        raw.push({
          id: "",
          title: meta.name.trim(),
          description: meta.desc.trim(),
          sources: ["onet"],
          tags: [tag],
        });
        n++;
      }
      console.log(`  ${path}: ${n}`);
    }
  }

  // ONET Tasks (work tasks with descriptions)
  {
    const rows = parseTsv(Deno.readTextFileSync("data/onet/Task Statements.txt"));
    const hdr = rows[0];
    const iTask = hdr.indexOf("Task");
    const iType = hdr.indexOf("Task Type");
    const seen = new Set<string>();
    let n = 0, dup = 0;
    for (let i = 1; i < rows.length; i++) {
      const task = rows[i][iTask]?.trim();
      if (!task) continue;
      const key = task.toLowerCase();
      if (seen.has(key)) { dup++; continue; }
      seen.add(key);
      raw.push({
        id: "",
        title: task,
        description: "",
        sources: ["onet"],
        tags: ["onet:task", rows[i][iType] ? `onet:${rows[i][iType].toLowerCase()}` : "onet:task"],
      });
      n++;
    }
    console.log(`  onet tasks: ${n} (dedup ${dup})`);
  }

  // ONET DWAs (Detailed Work Activities)
  {
    const rows = parseTsv(Deno.readTextFileSync("data/onet/DWA Reference.txt"));
    const hdr = rows[0];
    const iTitle = hdr.indexOf("DWA Title");
    const seen = new Set<string>();
    let n = 0;
    for (let i = 1; i < rows.length; i++) {
      const title = rows[i][iTitle]?.trim();
      if (!title) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      raw.push({ id: "", title, description: "", sources: ["onet"], tags: ["onet:dwa"] });
      n++;
    }
    console.log(`  onet dwas: ${n}`);
  }

  // ONET Technology Skills (specific tools)
  {
    const rows = parseTsv(Deno.readTextFileSync("data/onet/Technology Skills.txt"));
    const hdr = rows[0];
    const iExample = hdr.indexOf("Example");
    const iCat = hdr.indexOf("Commodity Title");
    const iHot = hdr.indexOf("Hot Technology");
    // Dedupe by Example; keep associated commodity category as description/tag
    const seen = new Map<string, { orig: string; desc: string; hot: boolean }>();
    for (let i = 1; i < rows.length; i++) {
      const ex = rows[i][iExample]?.trim();
      if (!ex) continue;
      const cat = rows[i][iCat]?.trim() || "";
      const hot = rows[i][iHot] === "Y";
      const key = ex.toLowerCase();
      const prev = seen.get(key);
      if (!prev || (hot && !prev.hot)) seen.set(key, { orig: ex, desc: cat, hot });
    }
    let n = 0;
    for (const { orig, desc, hot } of seen.values()) {
      raw.push({
        id: "",
        title: orig,
        description: desc,
        sources: ["onet"],
        tags: ["onet:tech", ...(hot ? ["onet:hot"] : []), ...(desc ? [`onet:tech:${slugify(desc)}`] : [])],
      });
      n++;
    }
    console.log(`  onet tech: ${n}`);
  }

  // Lightcast
  {
    const infill = loadInfillCache();
    const j = JSON.parse(Deno.readTextFileSync("data/lightcast/skills.json"));
    let n = 0, infilled = 0;
    for (const s of j.data) {
      if (!s.name) continue;
      const title = s.name.trim();
      const id = slugify(title);
      const desc = infill.get(id) ?? "";
      if (desc) infilled++;
      raw.push({
        id: "",
        title,
        description: desc,
        sources: ["lightcast"],
        tags: s.type?.name ? [`lightcast:${s.type.name}`] : ["lightcast"],
      });
      n++;
    }
    console.log(`  lightcast: ${n} (infilled: ${infilled})`);
  }

  // OpenSALT CFItems — each framework file has CFItems[] with fullStatement
  {
    const SCAFFOLDING = /^(\s*)?(grade|kindergarten|pre-?k|elementary|middle school|high school|[0-9]+(st|nd|rd|th)\s+grade|unit\s+\d|chapter\s+\d|section\s+\d|module\s+\d|standard\s+\d|topic\s+\d|strand|domain)\b/i;
    let n = 0, skipped = 0, scaffolding = 0;
    for (const e of Deno.readDirSync("data/opensalt")) {
      if (!e.name.endsWith(".json") || e.name === "index.json") continue;
      const j = JSON.parse(Deno.readTextFileSync(`data/opensalt/${e.name}`));
      const items = j.CFItems || [];
      const doc = j.CFDocument?.title || "opensalt";
      for (const it of items) {
        const title = (it.fullStatement || "").trim();
        if (!title || title.length > 400) { skipped++; continue; }
        // Drop framework scaffolding (non-skill meta-labels)
        if (SCAFFOLDING.test(title) && title.length < 50) { scaffolding++; continue; }
        if (/^(CFItemType|Course|Subject)\s*:/.test(title)) { scaffolding++; continue; }
        const grade = Array.isArray(it.educationLevel) ? it.educationLevel.join(",") : "";
        raw.push({
          id: "",
          title,
          description: it.humanCodingScheme || "",
          sources: ["opensalt"],
          tags: ["opensalt", `framework:${slugify(doc)}`, ...(grade ? [`grade:${grade}`] : [])],
        });
        n++;
      }
    }
    console.log(`  opensalt: ${n} (skipped ${skipped} oversized, ${scaffolding} scaffolding)`);
  }

  // Apply summarize cache: replace long titles with concise summaries, keep original as description
  let summarized = 0, onetEnriched = 0;
  for (const s of raw) {
    const candidate = slugify(s.title);
    const summary = summarizeCache.get(candidate);
    if (summary && summary.length > 0 && summary.length < s.title.length) {
      const original = s.title;
      s.title = summary;
      if (!s.description) s.description = original;
      summarized++;
    }
    // Apply ONET description enrichment if still missing a description
    if (!s.description && s.sources.includes("onet")) {
      const desc = onetDescCache.get(candidate);
      if (desc) { s.description = desc; onetEnriched++; }
    }
  }
  console.log(`[stage 1] applied ${summarized} summaries, ${onetEnriched} onet descriptions`);

  // Dedupe by fuzzy key
  console.log(`[stage 1] raw rows: ${raw.length}; deduping…`);
  const fuzzyKey = (s: string): string => {
    return s.toLowerCase()
      .replace(/\([^)]*\)/g, " ") // drop parentheticals
      .replace(/[^a-z0-9]+/g, " ") // collapse punctuation (merges "Machine-Learning" ↔ "machine learning")
      .replace(/\b(the|a|an|of|for|and|to|in|on|at|by|with)\b/g, " ") // drop stopwords
      .trim()
      .replace(/\s+/g, " ");
  };
  const byKey = new Map<string, Skill>();
  let collisions = 0;
  for (const s of raw) {
    const key = fuzzyKey(s.title);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      collisions++;
      for (const src of s.sources) if (!existing.sources.includes(src)) existing.sources.push(src);
      for (const t of s.tags) if (!existing.tags.includes(t)) existing.tags.push(t);
      if (!existing.description && s.description) existing.description = s.description;
    } else {
      const slug = slugify(s.title);
      if (!slug) continue; // skip titles that slugify to nothing
      byKey.set(key, { ...s, id: slug });
    }
  }

  // Resolve slug collisions (different titles → same slug) with numeric suffix
  const bySlug = new Map<string, Skill[]>();
  for (const s of byKey.values()) {
    const arr = bySlug.get(s.id) ?? [];
    arr.push(s);
    bySlug.set(s.id, arr);
  }
  let slugCollisions = 0;
  for (const [slug, arr] of bySlug) {
    if (arr.length === 1) continue;
    slugCollisions += arr.length - 1;
    arr.forEach((s, i) => { if (i > 0) s.id = `${slug}-${i + 1}`; });
  }

  // Write
  const out = [...byKey.values()];
  const clean = (c: string) => c.replace(/[\t\n\r]/g, " ").replace(/\s+/g, " ").trim();
  const tsv = ["id\ttitle\tdescription\tsources\ttags"];
  for (const s of out) {
    if (!s.id) throw new Error(`skill with empty id: ${s.title}`);
    tsv.push([s.id, clean(s.title), clean(s.description), s.sources.join(","), s.tags.join(",")].join("\t"));
  }
  Deno.writeTextFileSync(`${BUILD}/1_skills.tsv`, tsv.join("\n") + "\n");

  const titleLens = out.map((s) => s.title.length);
  const stats = {
    total_rows: out.length,
    raw_rows: raw.length,
    dedupe_collisions: collisions,
    slug_collisions: slugCollisions,
    per_source: {
      esco: out.filter((s) => s.sources.includes("esco")).length,
      onet: out.filter((s) => s.sources.includes("onet")).length,
      lightcast: out.filter((s) => s.sources.includes("lightcast")).length,
      opensalt: out.filter((s) => s.sources.includes("opensalt")).length,
    },
    title_len: { p50: pct(titleLens, 0.5), p95: pct(titleLens, 0.95), max: Math.max(...titleLens) },
    empty_description: out.filter((s) => !s.description).length,
  };
  writeStats(1, stats);

  if (out.length < 20000) throw new Error(`stage 1: suspiciously few rows (${out.length})`);
}

// ---------- stage 1b: infill Lightcast descriptions ----------

const CHAT_MODEL = Deno.env.get("CHAT_MODEL") ?? "gpt-oss:20b";
const INFILL_CACHE = `${BUILD}/1b_infill.tsv`;

function loadInfillCache(): Map<string, string> {
  try {
    const text = Deno.readTextFileSync(INFILL_CACHE);
    const m = new Map<string, string>();
    for (const line of text.split("\n")) {
      if (!line) continue;
      const [k, v] = line.split("\t");
      m.set(k, v ?? "");
    }
    return m;
  } catch { return new Map(); }
}

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const CLAUDE_MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-haiku-4-5-20251001";
const PREREQ_MODEL = Deno.env.get("PREREQ_MODEL") ?? "claude-3-haiku-20240307";
const INFILL_SYSTEM = `You define workplace skills in exactly one concise sentence. Be concrete and factual. Output only the definition — no preamble, no "refers to", no quotation marks, no trailing notes. Never repeat the skill name verbatim at the start.`;
const BATCH_STATE = `${BUILD}/1b_batch.json`;
const ANTHROPIC_HEADERS = {
  "content-type": "application/json",
  "x-api-key": ANTHROPIC_KEY ?? "",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "message-batches-2024-09-24",
};

function cleanDef(raw: string): string {
  return raw.trim()
    .replace(/^[\s"'*_-]+|[\s"'*_-]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 400);
}

// Map custom_id ↔ full skill id; custom_id must be ≤64 chars and unique.
async function shortId(fullId: string, idx: number): Promise<string> {
  const h = await sha256(fullId);
  const hex = Array.from(h.slice(0, 8)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `s${idx.toString(36)}_${hex}`;
}

async function submitBatch(todo: { id: string; title: string }[]): Promise<{ batchId: string; idMap: Record<string, string> }> {
  const idMap: Record<string, string> = {};
  const requests = await Promise.all(todo.map(async (t, i) => {
    const cid = await shortId(t.id, i);
    idMap[cid] = t.id;
    return {
      custom_id: cid,
      params: {
        model: CLAUDE_MODEL,
        max_tokens: 120,
        system: [{ type: "text", text: INFILL_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: `Define: ${t.title}` }],
      },
    };
  }));
  const res = await fetch("https://api.anthropic.com/v1/messages/batches", {
    method: "POST",
    headers: ANTHROPIC_HEADERS,
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`batch submit ${res.status}: ${await res.text()}`);
  const j = await res.json();
  console.log(`[stage 1b] batch submitted: ${j.id} (${requests.length} requests)`);
  return { batchId: j.id, idMap };
}

async function pollBatch(id: string): Promise<{ status: string; resultsUrl?: string; counts?: Record<string, number> }> {
  const res = await fetch(`https://api.anthropic.com/v1/messages/batches/${id}`, { headers: ANTHROPIC_HEADERS });
  if (!res.ok) throw new Error(`batch poll ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return { status: j.processing_status, resultsUrl: j.results_url, counts: j.request_counts };
}

async function downloadBatchResults(url: string, idMap: Record<string, string>): Promise<Record<string, string>> {
  const res = await fetch(url, { headers: ANTHROPIC_HEADERS });
  if (!res.ok) throw new Error(`results ${res.status}: ${await res.text()}`);
  const text = await res.text();
  const out: Record<string, string> = {};
  let errs = 0, unmapped = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const j = JSON.parse(line);
    const skillId = idMap[j.custom_id];
    if (!skillId) { unmapped++; continue; }
    if (j.result?.type === "succeeded") {
      out[skillId] = cleanDef(j.result.message.content?.[0]?.text ?? "");
    } else {
      errs++;
    }
  }
  console.log(`[stage 1b] results: ${Object.keys(out).length} succeeded, ${errs} failed, ${unmapped} unmapped`);
  return out;
}

function appendInfill(map: Record<string, string>) {
  const enc = new TextEncoder();
  const fh = Deno.openSync(INFILL_CACHE, { create: true, append: true });
  for (const [id, desc] of Object.entries(map)) {
    fh.writeSync(enc.encode(`${id}\t${desc.replace(/[\t\n\r]/g, " ")}\n`));
  }
  fh.close();
}

async function stage1bInfill() {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  // Identify Lightcast skills needing infill
  const lines = Deno.readTextFileSync(`${BUILD}/1_skills.tsv`).split("\n").filter((l) => l.length);
  const targets: { id: string; title: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    if (c[3].includes("lightcast") && !c[2]) targets.push({ id: c[0], title: c[1] });
  }
  const cache = loadInfillCache();
  const todo = targets.filter((t) => !cache.has(t.id));
  console.log(`[stage 1b] targets: ${targets.length}, cached: ${targets.length - todo.length}, to submit: ${todo.length}`);

  // Check for existing in-flight batch
  let state: { id: string; idMap: Record<string, string> } | null = null;
  try { state = JSON.parse(Deno.readTextFileSync(BATCH_STATE)); } catch { /* none */ }

  // Resume existing batch
  if (state) {
    console.log(`[stage 1b] resuming batch ${state.id}`);
    while (true) {
      const p = await pollBatch(state.id);
      console.log(`  batch ${state.id} status=${p.status} counts=${JSON.stringify(p.counts)}`);
      if (p.status === "ended") {
        if (!p.resultsUrl) throw new Error("batch ended but no results_url");
        const results = await downloadBatchResults(p.resultsUrl, state.idMap);
        appendInfill(results);
        Deno.removeSync(BATCH_STATE);
        writeStats(11, { targets: targets.length, batch_id: state.id, results_count: Object.keys(results).length });
        return;
      }
      await new Promise((r) => setTimeout(r, 30000));
    }
  }

  if (todo.length === 0) {
    console.log("[stage 1b] all targets already cached — nothing to do");
    return;
  }

  // Chunk into batches of up to 90k requests (cap under Anthropic's 100k limit)
  const CHUNK = 90000;
  if (todo.length > CHUNK) {
    console.warn(`[stage 1b] splitting ${todo.length} into chunks of ${CHUNK}; submitting first chunk now, rerun stage to submit next`);
  }
  const chunk = todo.slice(0, CHUNK);

  if (Deno.env.get("INFILL_LIMIT")) {
    chunk.length = Math.min(chunk.length, Number(Deno.env.get("INFILL_LIMIT")));
    console.log(`[stage 1b] INFILL_LIMIT → ${chunk.length}`);
  }

  const { batchId, idMap } = await submitBatch(chunk);
  Deno.writeTextFileSync(BATCH_STATE, JSON.stringify({ id: batchId, idMap }));
  console.log(`[stage 1b] batch submitted. Re-run \`pipeline.ts infill\` to poll for results.`);
}

// ---------- stage 1d: enrich ONET Task/DWA descriptions ----------

const ONET_DESC_CACHE = `${BUILD}/1d_onet_desc.tsv`;
const ONET_DESC_BATCH_STATE = `${BUILD}/1d_batch.json`;
const ONET_DESC_SYSTEM = `Expand the given workplace task into a 1-2 sentence description of what the task involves. Be concrete and factual. No preamble. No quotation marks. Return only the description.`;

function loadOnetDescCache(): Map<string, string> {
  try {
    const text = Deno.readTextFileSync(ONET_DESC_CACHE);
    const m = new Map<string, string>();
    for (const line of text.split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      m.set(line.slice(0, tab), line.slice(tab + 1) || "");
    }
    return m;
  } catch { return new Map(); }
}

function appendOnetDesc(map: Record<string, string>) {
  const enc = new TextEncoder();
  const fh = Deno.openSync(ONET_DESC_CACHE, { create: true, append: true });
  for (const [id, v] of Object.entries(map)) {
    fh.writeSync(enc.encode(`${id}\t${v.replace(/[\t\n\r]/g, " ")}\n`));
  }
  fh.close();
}

async function submitOnetDescBatch(chunk: { id: string; title: string }[]): Promise<{ batchId: string; idMap: Record<string, string> }> {
  const idMap: Record<string, string> = {};
  const requests = await Promise.all(chunk.map(async (t, i) => {
    const cid = await shortId(t.id, i);
    idMap[cid] = t.id;
    return {
      custom_id: cid,
      params: {
        model: CLAUDE_MODEL,
        max_tokens: 80,
        system: [{ type: "text", text: ONET_DESC_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: `Task: ${t.title}` }],
      },
    };
  }));
  const body = JSON.stringify({ requests });
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages/batches", {
        method: "POST",
        headers: ANTHROPIC_HEADERS,
        body,
      });
      if (res.ok) { const j = await res.json(); return { batchId: j.id, idMap }; }
      const txt = await res.text();
      if (res.status === 429 || res.status >= 500) {
        const delay = Math.min(60 * attempt, 300);
        console.warn(`  [retry ${attempt}/8] ${res.status} — sleeping ${delay}s`);
        await new Promise((r) => setTimeout(r, delay * 1000));
        continue;
      }
      throw new Error(`onet-desc submit ${res.status}: ${txt}`);
    } catch (err) {
      const msg = (err as Error).message;
      if (/onet-desc submit [1-4]\d\d/.test(msg)) throw err;
      const delay = Math.min(30 * attempt, 300);
      console.warn(`  [retry ${attempt}/8] network: ${msg.slice(0, 80)} — sleeping ${delay}s`);
      await new Promise((r) => setTimeout(r, delay * 1000));
    }
  }
  throw new Error("onet-desc submit: retries exhausted");
}

async function stage1dOnetDesc() {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const lines = Deno.readTextFileSync(`${BUILD}/1_skills.tsv`).split("\n").filter((l) => l.length);
  const targets: { id: string; title: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    if (c[3] === "onet" && !c[2] && c[1].length < 120) targets.push({ id: c[0], title: c[1] });
  }
  const cache = loadOnetDescCache();

  // Track IDs already in flight
  let state: { batches: { id: string; idMap: Record<string, string> }[] } | null = null;
  try { state = JSON.parse(Deno.readTextFileSync(ONET_DESC_BATCH_STATE)); } catch { /* none */ }
  const inFlight = new Set<string>();
  if (state) for (const b of state.batches) for (const v of Object.values(b.idMap)) inFlight.add(v);

  const buildTodo = () => targets.filter((t) => !cache.has(t.id) && !inFlight.has(t.id));
  let todo = buildTodo();
  console.log(`[stage 1d] targets: ${targets.length}, cached: ${cache.size}, in-flight: ${inFlight.size}, to submit: ${todo.length}`);

  // Poll existing batches
  if (state) {
    const remaining: typeof state.batches = [];
    for (const b of state.batches) {
      const p = await pollBatch(b.id);
      console.log(`  batch ${b.id} status=${p.status} counts=${JSON.stringify(p.counts)}`);
      if (p.status === "ended") {
        if (!p.resultsUrl) { console.warn(`  no results_url for ${b.id}`); continue; }
        const results = await downloadBatchResults(p.resultsUrl, b.idMap);
        appendOnetDesc(results);
        for (const id of Object.keys(results)) cache.set(id, results[id]);
        for (const v of Object.values(b.idMap)) inFlight.delete(v);
      } else remaining.push(b);
    }
    if (remaining.length === 0) {
      try { Deno.removeSync(ONET_DESC_BATCH_STATE); } catch { /* ignore */ }
      state = { batches: [] };
    } else {
      Deno.writeTextFileSync(ONET_DESC_BATCH_STATE, JSON.stringify({ batches: remaining }));
      state = { batches: remaining };
    }
    todo = buildTodo();
  }
  if (todo.length === 0 && (!state || state.batches.length === 0)) {
    writeStats(13, { targets: targets.length, cached: cache.size });
    console.log(`[stage 1d] all done — ${cache.size}/${targets.length} cached`);
    return;
  }

  // Fill parallel submission slots
  const CHUNK = Number(Deno.env.get("ONET_CHUNK") ?? "5000");
  const PARALLEL = Number(Deno.env.get("ONET_PARALLEL") ?? "3");
  const inFlightBatches = state?.batches ?? [];
  const slots = Math.max(0, PARALLEL - inFlightBatches.length);
  const batches = [...inFlightBatches];
  let off = 0;
  for (let n = 0; n < slots && off < todo.length; n++) {
    const chunk = todo.slice(off, off + CHUNK);
    if (Deno.env.get("INFILL_LIMIT")) chunk.length = Math.min(chunk.length, Number(Deno.env.get("INFILL_LIMIT")));
    const b = await submitOnetDescBatch(chunk);
    batches.push({ id: b.batchId, idMap: b.idMap });
    Deno.writeTextFileSync(ONET_DESC_BATCH_STATE, JSON.stringify({ batches }));
    console.log(`[stage 1d] batch ${b.batchId}: ${chunk.length} requests submitted`);
    off += chunk.length;
  }
  console.log(`[stage 1d] ${batches.length} batch(es) in-flight. Rerun to poll + submit next.`);
}

// ---------- stage 1c: summarize long titles ----------

const SUMMARIZE_CACHE = `${BUILD}/1c_summarize.tsv`;
const SUMMARIZE_BATCH_STATE = `${BUILD}/1c_batch.json`;
const SUMMARIZE_SYSTEM = `You extract the core skill from a long workplace/curriculum standard. Output exactly one concise noun phrase (3-7 words) naming the core skill. No preamble, no quotes, no trailing period. Examples:
"Use place value understanding to round multi-digit whole numbers to any place." → Rounding multi-digit whole numbers
"Prepare or present reports concerning activities, expenses, budgets, government statutes or rulings, or other items affecting businesses or program services." → Preparing business reports
"Draw triangles (freehand, with ruler and protractor, and using technology) with given conditions from three measures of angles or sides." → Drawing triangles with given conditions`;

function loadSummarizeCache(): Map<string, string> {
  try {
    const text = Deno.readTextFileSync(SUMMARIZE_CACHE);
    const m = new Map<string, string>();
    for (const line of text.split("\n")) {
      if (!line) continue;
      const [k, v] = line.split("\t");
      m.set(k, v ?? "");
    }
    return m;
  } catch { return new Map(); }
}

function appendSummarize(map: Record<string, string>) {
  const enc = new TextEncoder();
  const fh = Deno.openSync(SUMMARIZE_CACHE, { create: true, append: true });
  for (const [id, v] of Object.entries(map)) {
    fh.writeSync(enc.encode(`${id}\t${v.replace(/[\t\n\r]/g, " ")}\n`));
  }
  fh.close();
}

async function submitSummarizeBatch(todo: { id: string; title: string }[]): Promise<{ batchId: string; idMap: Record<string, string> }> {
  const idMap: Record<string, string> = {};
  const requests = await Promise.all(todo.map(async (t, i) => {
    const cid = await shortId(t.id, i);
    idMap[cid] = t.id;
    return {
      custom_id: cid,
      params: {
        model: CLAUDE_MODEL,
        max_tokens: 60,
        system: [{ type: "text", text: SUMMARIZE_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: t.title }],
      },
    };
  }));
  const res = await fetch("https://api.anthropic.com/v1/messages/batches", {
    method: "POST",
    headers: ANTHROPIC_HEADERS,
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`summarize batch submit ${res.status}: ${await res.text()}`);
  const j = await res.json();
  console.log(`[stage 1c] batch submitted: ${j.id} (${requests.length} requests)`);
  return { batchId: j.id, idMap };
}

async function stage1cSummarize() {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const MAX_LEN = Number(Deno.env.get("SUMMARIZE_MAX_LEN") ?? "120");

  const lines = Deno.readTextFileSync(`${BUILD}/1_skills.tsv`).split("\n").filter((l) => l.length);
  const targets: { id: string; title: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    if (c[1].length > MAX_LEN) targets.push({ id: c[0], title: c[1] });
  }

  const cache = loadSummarizeCache();
  const todo = targets.filter((t) => !cache.has(t.id));
  console.log(`[stage 1c] long-title skills: ${targets.length}, cached: ${targets.length - todo.length}, to submit: ${todo.length}`);

  let state: { id: string; idMap: Record<string, string> } | null = null;
  try { state = JSON.parse(Deno.readTextFileSync(SUMMARIZE_BATCH_STATE)); } catch { /* none */ }

  if (state) {
    console.log(`[stage 1c] resuming batch ${state.id}`);
    while (true) {
      const p = await pollBatch(state.id);
      console.log(`  status=${p.status} counts=${JSON.stringify(p.counts)}`);
      if (p.status === "ended") {
        if (!p.resultsUrl) throw new Error("no results_url");
        const results = await downloadBatchResults(p.resultsUrl, state.idMap);
        appendSummarize(results);
        Deno.removeSync(SUMMARIZE_BATCH_STATE);
        writeStats(12, { targets: targets.length, results: Object.keys(results).length });
        return;
      }
      await new Promise((r) => setTimeout(r, 30000));
    }
  }

  if (todo.length === 0) { console.log("[stage 1c] all cached"); return; }

  const CHUNK = 90000;
  const chunk = todo.slice(0, CHUNK);
  if (Deno.env.get("INFILL_LIMIT")) {
    chunk.length = Math.min(chunk.length, Number(Deno.env.get("INFILL_LIMIT")));
  }
  const { batchId, idMap } = await submitSummarizeBatch(chunk);
  Deno.writeTextFileSync(SUMMARIZE_BATCH_STATE, JSON.stringify({ id: batchId, idMap }));
  console.log(`[stage 1c] batch submitted; re-run \`pipeline.ts summarize\` to poll`);
}

// ---------- stage 2: embed ----------

// Prefer deduped tagged output if present (stage 3b); falls back to stage 3.
function taggedTsvPath(): string {
  try { Deno.statSync(`${BUILD}/3b_tagged_deduped.tsv`); return `${BUILD}/3b_tagged_deduped.tsv`; } catch { return `${BUILD}/3_tagged.tsv`; }
}

const OLLAMA = "http://localhost:11434";
const EMBED_MODEL = "nomic-embed-text";
const EMBED_DIM = 768;
const CACHE_PATH = `${BUILD}/2_cache.bin`;
const CACHE_RECORD_BYTES = 32 + EMBED_DIM * 4;

async function sha256(s: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new Uint8Array(buf);
}

function loadCache(): Map<string, Float32Array> {
  const cache = new Map<string, Float32Array>();
  let data: Uint8Array;
  try { data = Deno.readFileSync(CACHE_PATH); } catch { return cache; }
  if (data.byteLength % CACHE_RECORD_BYTES !== 0) {
    throw new Error(`cache file ${CACHE_PATH} size ${data.byteLength} not multiple of ${CACHE_RECORD_BYTES}; delete to rebuild`);
  }
  const n = data.byteLength / CACHE_RECORD_BYTES;
  for (let i = 0; i < n; i++) {
    const off = i * CACHE_RECORD_BYTES;
    const hash = Array.from(data.slice(off, off + 32)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const vec = new Float32Array(data.buffer.slice(data.byteOffset + off + 32, data.byteOffset + off + CACHE_RECORD_BYTES));
    cache.set(hash, vec);
  }
  console.log(`[stage 2] loaded cache: ${cache.size} vectors`);
  return cache;
}

function appendCache(fh: Deno.FsFile, hashBytes: Uint8Array, vec: Float32Array) {
  const rec = new Uint8Array(CACHE_RECORD_BYTES);
  rec.set(hashBytes, 0);
  rec.set(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength), 32);
  fh.writeSync(rec);
}

async function embedOne(content: string): Promise<Float32Array> {
  const res = await fetch(`${OLLAMA}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: content }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const j = await res.json();
  if (!j.embedding || j.embedding.length !== EMBED_DIM) {
    throw new Error(`bad embedding: length=${j.embedding?.length}, expected ${EMBED_DIM}`);
  }
  return new Float32Array(j.embedding);
}

async function stage2Embed() {
  const tsv = Deno.readTextFileSync(`${BUILD}/1_skills.tsv`);
  const lines = tsv.split("\n").filter((l) => l.length);
  const skills: { id: string; content: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    const content = c[2] ? `${c[1]}\n${c[2]}` : c[1];
    skills.push({ id: c[0], content });
  }
  if (Deno.env.get("SKILL_LIMIT")) {
    skills.length = Math.min(skills.length, Number(Deno.env.get("SKILL_LIMIT")));
    console.log(`[stage 2] SKILL_LIMIT → ${skills.length} skills`);
  }
  console.log(`[stage 2] embedding ${skills.length} skills…`);

  const hashes = await Promise.all(skills.map((s) => sha256(s.content)));
  const hashHex = hashes.map((h) => Array.from(h).map((b) => b.toString(16).padStart(2, "0")).join(""));

  const cache = loadCache();
  const cacheFh = Deno.openSync(CACHE_PATH, { create: true, append: true });

  const concurrency = Number(Deno.env.get("EMBED_CONCURRENCY") ?? "8");
  const missing: number[] = [];
  for (let i = 0; i < skills.length; i++) if (!cache.has(hashHex[i])) missing.push(i);
  console.log(`[stage 2] cached: ${skills.length - missing.length}; to compute: ${missing.length}; concurrency: ${concurrency}`);

  const latencies: number[] = [];
  let done = 0;
  const t0 = performance.now();
  async function worker(queue: number[]) {
    while (queue.length) {
      const idx = queue.shift()!;
      const t = performance.now();
      try {
        const vec = await embedOne(skills[idx].content);
        latencies.push(performance.now() - t);
        cache.set(hashHex[idx], vec);
        appendCache(cacheFh, hashes[idx], vec);
      } catch (err) {
        throw new Error(`embed failed for ${skills[idx].id}: ${(err as Error).message}`);
      }
      done++;
      if (done % 500 === 0) {
        const elapsed = (performance.now() - t0) / 1000;
        const rate = done / elapsed;
        const eta = (missing.length - done) / rate;
        console.log(`  ${done}/${missing.length} (${rate.toFixed(1)}/s, ETA ${eta.toFixed(0)}s)`);
      }
    }
  }
  const queue = [...missing];
  await Promise.all(Array.from({ length: concurrency }, () => worker(queue)));
  cacheFh.close();

  // Write bin + ids in skill order
  const bin = new Float32Array(skills.length * EMBED_DIM);
  let nans = 0;
  const seen = new Map<string, number>();
  let dupes = 0;
  for (let i = 0; i < skills.length; i++) {
    const vec = cache.get(hashHex[i])!;
    if (!vec) throw new Error(`missing vec for ${skills[i].id}`);
    for (let j = 0; j < EMBED_DIM; j++) if (!Number.isFinite(vec[j])) nans++;
    bin.set(vec, i * EMBED_DIM);
    const key = hashHex[i];
    const prev = seen.get(key);
    if (prev !== undefined) dupes++;
    else seen.set(key, i);
  }
  Deno.writeFileSync(`${BUILD}/2_embeddings.bin`, new Uint8Array(bin.buffer));
  Deno.writeTextFileSync(`${BUILD}/2_ids.tsv`, skills.map((s) => s.id).join("\n") + "\n");

  writeStats(2, {
    total: skills.length,
    newly_computed: missing.length,
    cache_hits: skills.length - missing.length,
    dim: EMBED_DIM,
    nan_count: nans,
    duplicate_content: dupes,
    latency_ms: latencies.length
      ? { p50: pct(latencies, 0.5), p95: pct(latencies, 0.95), max: Math.max(...latencies) }
      : null,
    total_seconds: (performance.now() - t0) / 1000,
  });

  if (nans > 0) throw new Error(`stage 2: ${nans} NaN/Inf values in embeddings`);
}

// ---------- stage 3: tag ----------

function parseOccupationRefs(): { label: string; desc: string }[] {
  const refs: { label: string; desc: string }[] = [];
  const seen = new Set<string>();
  const push = (label: string, desc: string) => {
    label = label.trim();
    if (!label) return;
    const k = label.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    refs.push({ label, desc: desc.trim() });
  };

  // ESCO occupations
  const esco = parseCsv(Deno.readTextFileSync("data/esco/occupations_en.csv"));
  const eHdr = esco[0];
  const eLabel = eHdr.indexOf("preferredLabel");
  const eDesc = eHdr.indexOf("description");
  for (let i = 1; i < esco.length; i++) push(esco[i][eLabel] || "", esco[i][eDesc] || "");
  const afterEsco = refs.length;

  // ONET occupations
  const onet = parseTsv(Deno.readTextFileSync("data/onet/Occupation Data.txt"));
  const oHdr = onet[0];
  const oTitle = oHdr.indexOf("Title");
  const oDesc = oHdr.indexOf("Description");
  for (let i = 1; i < onet.length; i++) push(onet[i][oTitle] || "", onet[i][oDesc] || "");

  console.log(`[stage 3] occupation refs: esco=${afterEsco}, onet=${refs.length - afterEsco}, total=${refs.length}`);
  return refs;
}

// Two-pass streaming to control memory: pass 1 = broader in-degree only; pass 2 = labels for top-N URIs.
async function streamLines(cmd: string[], onLine: (line: string) => void) {
  const p = new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "piped", stderr: "null" }).spawn();
  const lines = p.stdout.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream());
  for await (const line of lines) onLine(line);
  await p.status;
}

async function parseTopicSource(name: string, cmd: string[], perSource: number): Promise<{ uri: string; label: string; inDeg: number }[]> {
  const BROADER = "skos/core#broader";
  const PREF = "skos/core#prefLabel";
  const BADCAT = /^(Wikipedia|Lists of|List of|Categories |Redirects|Articles |Stubs|Templates|Commons|Set indices)/i;

  console.log(`[stage 3] ${name}: pass 1 (broader in-degree)`);
  const inDeg = new Map<string, number>();
  let n = 0;
  await streamLines(cmd, (line) => {
    if (line.length < 40 || line[0] === "#") return;
    if (!line.includes(BROADER)) return;
    const m = line.match(/^<[^>]+>\s+<[^>]+>\s+<([^>]+)>\s*\.$/);
    if (m) inDeg.set(m[1], (inDeg.get(m[1]) ?? 0) + 1);
    if (++n % 2000000 === 0) console.log(`  ${name} p1: ${n} lines, ${inDeg.size} targets`);
  });
  console.log(`  ${name}: ${inDeg.size} broader targets`);

  // Keep up to 5× perSource candidates (we'll filter by label quality next, then trim)
  const top = [...inDeg.entries()].sort((a, b) => b[1] - a[1]).slice(0, perSource * 5);
  const topSet = new Map(top.map(([uri, d]) => [uri, d]));
  inDeg.clear();

  console.log(`[stage 3] ${name}: pass 2 (labels for top ${topSet.size})`);
  const labels = new Map<string, string>();
  n = 0;
  await streamLines(cmd, (line) => {
    if (line.length < 40 || line[0] === "#") return;
    if (!line.includes(PREF)) return;
    const m = line.match(/^<([^>]+)>\s+<[^>]+>\s+"((?:[^"\\]|\\.)*)"(?:@en)?\s*\.$/);
    if (!m) return;
    if (!topSet.has(m[1])) return;
    const lbl = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (lbl.length < 2 || lbl.length > 50) return;
    if (BADCAT.test(lbl)) return;
    // Only keep short labels — 1 to 4 words, no parenthetical qualifiers
    const words = lbl.split(/\s+/);
    if (words.length > 4) return;
    if (lbl.includes("(") || lbl.includes(",")) return;
    labels.set(m[1], lbl);
    if (++n % 500000 === 0) console.log(`  ${name} p2: ${n} lines, ${labels.size} labeled`);
  });

  const scored: { uri: string; label: string; inDeg: number }[] = [];
  for (const [uri, label] of labels) scored.push({ uri, label, inDeg: topSet.get(uri)! });
  scored.sort((a, b) => b.inDeg - a.inDeg);
  return scored.slice(0, perSource);
}

async function parseTopicRefs(perSource: number): Promise<{ label: string; desc: string }[]> {
  const topLcsh = await parseTopicSource(
    "lcsh",
    ["sh", "-c", "gunzip -c data/lcsh/subjects.skosrdf.nt.gz"],
    perSource,
  );
  const topDbp = await parseTopicSource(
    "dbpedia",
    ["sh", "-c", "bzcat data/dbpedia/skos_categories_en.ttl.bz2"],
    perSource,
  );

  const refs: { label: string; desc: string }[] = [];
  const seen = new Set<string>();
  for (const r of [...topLcsh, ...topDbp]) {
    const k = r.label.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    refs.push({ label: r.label, desc: "" });
  }
  console.log(`[stage 3] topic refs: ${refs.length} (${topLcsh.length} lcsh + ${topDbp.length} dbp − overlap)`);
  return refs;
}

async function embedRefs(refs: { label: string; desc: string }[]): Promise<Float32Array[]> {
  const cache = loadCache();
  const cacheFh = Deno.openSync(CACHE_PATH, { create: true, append: true });

  // Embed labels only — including generic descriptions causes noise matches.
  const contents = refs.map((r) => r.label);
  const hashes = await Promise.all(contents.map((c) => sha256(c)));
  const hashHex = hashes.map((h) => Array.from(h).map((b) => b.toString(16).padStart(2, "0")).join(""));

  const missing: number[] = [];
  for (let i = 0; i < refs.length; i++) if (!cache.has(hashHex[i])) missing.push(i);
  console.log(`[stage 3] embedding refs: ${refs.length} total, ${missing.length} to compute`);

  const concurrency = Number(Deno.env.get("EMBED_CONCURRENCY") ?? "8");
  let done = 0;
  const t0 = performance.now();
  async function worker(queue: number[]) {
    while (queue.length) {
      const i = queue.shift()!;
      const vec = await embedOne(contents[i]);
      cache.set(hashHex[i], vec);
      appendCache(cacheFh, hashes[i], vec);
      done++;
      if (done % 500 === 0) {
        const elapsed = (performance.now() - t0) / 1000;
        console.log(`  ${done}/${missing.length} (${(done / elapsed).toFixed(1)}/s)`);
      }
    }
  }
  const q = [...missing];
  await Promise.all(Array.from({ length: concurrency }, () => worker(q)));
  cacheFh.close();

  return refs.map((_, i) => cache.get(hashHex[i])!);
}

function normalize(v: Float32Array): Float32Array {
  let sq = 0;
  for (let i = 0; i < v.length; i++) sq += v[i] * v[i];
  const inv = 1 / Math.sqrt(sq || 1);
  const r = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) r[i] = v[i] * inv;
  return r;
}

// Walk ESCO broader hierarchy: child → direct parent label (first broader).
function parseEscoSkillTopics(): Map<string, string[]> {
  const rows = parseCsv(Deno.readTextFileSync("data/esco/broaderRelationsSkillPillar_en.csv"));
  const hdr = rows[0];
  const iChild = hdr.indexOf("conceptLabel");
  const iChildUri = hdr.indexOf("conceptUri");
  const iBroader = hdr.indexOf("broaderLabel");
  const iBroaderUri = hdr.indexOf("broaderUri");
  // Build URI → label map and URI → parents[]
  const label = new Map<string, string>();
  const parents = new Map<string, string[]>();
  for (let i = 1; i < rows.length; i++) {
    const cUri = rows[i][iChildUri], cLbl = rows[i][iChild];
    const pUri = rows[i][iBroaderUri], pLbl = rows[i][iBroader];
    if (cUri && cLbl) label.set(cUri, cLbl);
    if (pUri && pLbl) label.set(pUri, pLbl);
    if (cUri && pUri) {
      const arr = parents.get(cUri) ?? [];
      arr.push(pUri);
      parents.set(cUri, arr);
    }
  }
  // For each concept, walk up to the top and collect ancestor labels (skip generic roots "knowledge"/"skill")
  const GENERIC = new Set(["knowledge", "skill", "generic programmes and qualifications"]);
  const out = new Map<string, string[]>();
  for (const [uri, lbl] of label) {
    const topics: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = uri;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const ps = parents.get(cursor);
      if (!ps || !ps.length) break;
      for (const p of ps) {
        const pl = label.get(p);
        if (pl && !GENERIC.has(pl.toLowerCase()) && topics.indexOf(pl) < 0) topics.push(pl);
      }
      cursor = ps[0];
    }
    if (topics.length) out.set(slugify(lbl), topics);
  }
  console.log(`[stage 3] ESCO direct topics: ${out.size} skills/groups → topics`);
  return out;
}

// Build map slugify(ONET Element Name) → [occupation Title] from ONET's IM-scored occupation×skill matrix.
function parseOnetSkillOccupations(): Map<string, string[]> {
  // Load occupation titles
  const occTitles = new Map<string, string>();
  for (const row of parseTsv(Deno.readTextFileSync("data/onet/Occupation Data.txt")).slice(1)) {
    if (row[0] && row[1]) occTitles.set(row[0], row[1]);
  }
  // CMR for Element ID → Name
  const cmr = new Map<string, string>();
  for (const row of parseTsv(Deno.readTextFileSync("data/onet/Content Model Reference.txt")).slice(1)) {
    if (row[0] && row[1]) cmr.set(row[0], row[1]);
  }
  // Aggregate IM score per (skill element, occupation); pick top-5 occupations per skill
  const perFile = ["Skills.txt", "Knowledge.txt", "Abilities.txt"];
  const bySkill = new Map<string, Map<string, number>>();
  for (const fname of perFile) {
    const rows = parseTsv(Deno.readTextFileSync(`data/onet/${fname}`));
    const hdr = rows[0];
    const iSoc = hdr.indexOf("O*NET-SOC Code");
    const iEl = hdr.indexOf("Element ID");
    const iScale = hdr.indexOf("Scale ID");
    const iVal = hdr.indexOf("Data Value");
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][iScale] !== "IM") continue;
      const name = cmr.get(rows[i][iEl]);
      if (!name) continue;
      const occ = occTitles.get(rows[i][iSoc]);
      if (!occ) continue;
      const v = Number(rows[i][iVal]);
      if (!Number.isFinite(v)) continue;
      const key = slugify(name);
      let m = bySkill.get(key);
      if (!m) { m = new Map(); bySkill.set(key, m); }
      m.set(occ, Math.max(m.get(occ) ?? 0, v));
    }
  }
  const out = new Map<string, string[]>();
  for (const [key, m] of bySkill) {
    const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
    out.set(key, top);
  }
  console.log(`[stage 3] ONET direct occupations: ${out.size} skills → occupations`);
  return out;
}

// Build map slugify(skillLabel) → [occupationLabel] from ESCO's explicit relations.
function parseEscoSkillOccupations(): Map<string, string[]> {
  const rows = parseCsv(Deno.readTextFileSync("data/esco/occupationSkillRelations_en.csv"));
  const hdr = rows[0];
  const iOcc = hdr.indexOf("occupationLabel");
  const iSkill = hdr.indexOf("skillLabel");
  const iType = hdr.indexOf("relationType");
  const m = new Map<string, Set<string>>();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][iType] !== "essential") continue; // drop "optional" — less signal
    const slug = slugify(rows[i][iSkill] || "");
    const occ = rows[i][iOcc];
    if (!slug || !occ) continue;
    let s = m.get(slug);
    if (!s) { s = new Set(); m.set(slug, s); }
    s.add(occ);
  }
  const out = new Map<string, string[]>();
  for (const [k, v] of m) out.set(k, [...v]);
  console.log(`[stage 3] ESCO direct occupations: ${out.size} skills → occupations`);
  return out;
}

async function stage3Tag() {
  // Load stage 1 skills
  const lines1 = Deno.readTextFileSync(`${BUILD}/1_skills.tsv`).split("\n").filter((l) => l.length);
  const skills = lines1.slice(1).map((l) => {
    const c = l.split("\t");
    return { id: c[0], title: c[1], description: c[2], sources: c[3], tags: c[4] };
  });

  // Load stage 2 embeddings
  const ids = Deno.readTextFileSync(`${BUILD}/2_ids.tsv`).split("\n").filter((l) => l.length);
  const bin = Deno.readFileSync(`${BUILD}/2_embeddings.bin`);
  const emb = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
  if (ids.length !== skills.length) throw new Error(`ids (${ids.length}) vs skills (${skills.length}) mismatch`);

  const DIM = EMBED_DIM;
  // Normalize skill embeddings in place
  const skillVecs = new Float32Array(skills.length * DIM);
  for (let i = 0; i < skills.length; i++) {
    const v = emb.subarray(i * DIM, (i + 1) * DIM);
    const n = normalize(v);
    skillVecs.set(n, i * DIM);
  }

  // Build refs
  const occRefs = parseOccupationRefs();
  const topicRefs = await parseTopicRefs(Number(Deno.env.get("TOPIC_PER_SOURCE") ?? "5000"));

  const occVecsRaw = await embedRefs(occRefs);
  const topicVecsRaw = await embedRefs(topicRefs);

  const packNorm = (vecs: Float32Array[]) => {
    const buf = new Float32Array(vecs.length * DIM);
    for (let i = 0; i < vecs.length; i++) buf.set(normalize(vecs[i]), i * DIM);
    return buf;
  };
  const occMat = packNorm(occVecsRaw);
  const topicMat = packNorm(topicVecsRaw);

  const OCC_K = Number(Deno.env.get("OCC_TOP_K") ?? "2");
  const TOPIC_K = Number(Deno.env.get("TOPIC_TOP_K") ?? "3");
  const OCC_THRESHOLD = Number(Deno.env.get("OCC_THRESHOLD") ?? "0.60");
  const TOPIC_THRESHOLD = Number(Deno.env.get("TOPIC_THRESHOLD") ?? "0.62");
  // Drop refs that match more than this fraction of skills — they're non-discriminative
  const IDF_MAX_FRAC = Number(Deno.env.get("IDF_MAX_FRAC") ?? "0.015");

  // One oversampled pass per ref set → prune degenerate refs by IDF → take top-K from survivors.
  const oversamplePass = (refMat: Float32Array, refCount: number, keep: number, thresh: number) => {
    const out: { idx: number; score: number }[][] = new Array(skills.length);
    const refHits = new Int32Array(refCount);
    for (let i = 0; i < skills.length; i++) {
      const sOff = i * DIM;
      const top: { idx: number; score: number }[] = [];
      for (let r = 0; r < refCount; r++) {
        let s = 0;
        const rOff = r * DIM;
        for (let d = 0; d < DIM; d++) s += skillVecs[sOff + d] * refMat[rOff + d];
        if (s < thresh) continue;
        if (top.length < keep) {
          top.push({ idx: r, score: s });
          top.sort((a, b) => a.score - b.score);
        } else if (s > top[0].score) {
          top[0] = { idx: r, score: s };
          top.sort((a, b) => a.score - b.score);
        }
      }
      top.sort((a, b) => b.score - a.score);
      out[i] = top;
      for (const t of top) refHits[t.idx]++;
      if ((i + 1) % 10000 === 0) console.log(`    ${i + 1}/${skills.length}`);
    }
    return { out, refHits };
  };

  const pruneMask = (refHits: Int32Array, refs: { label: string }[], label: string): Uint8Array => {
    const maxHits = Math.floor(skills.length * IDF_MAX_FRAC);
    const mask = new Uint8Array(refs.length);
    let dropped = 0;
    const droppedLabels: string[] = [];
    for (let r = 0; r < refs.length; r++) {
      if (refHits[r] > maxHits) {
        dropped++;
        if (droppedLabels.length < 20) droppedLabels.push(`${refs[r].label}=${refHits[r]}`);
      } else {
        mask[r] = 1;
      }
    }
    console.log(`[stage 3] ${label}: pruned ${dropped}/${refs.length} refs (>${maxHits} hits). Top dropped: ${droppedLabels.slice(0, 10).join(", ")}`);
    return mask;
  };

  const OVERSAMPLE = 5;
  const t0 = performance.now();
  console.log(`[stage 3] matching ${skills.length} × ${occRefs.length} occs (keep ${OCC_K * OVERSAMPLE})…`);
  const occPass = oversamplePass(occMat, occRefs.length, OCC_K * OVERSAMPLE, OCC_THRESHOLD);
  const occMask = pruneMask(occPass.refHits, occRefs, "occ");
  console.log(`[stage 3] matching ${skills.length} × ${topicRefs.length} topics (keep ${TOPIC_K * OVERSAMPLE})…`);
  const topicPass = oversamplePass(topicMat, topicRefs.length, TOPIC_K * OVERSAMPLE, TOPIC_THRESHOLD);
  const topicMask = pruneMask(topicPass.refHits, topicRefs, "topic");

  const finalize = (pass: { out: { idx: number; score: number }[][] }, mask: Uint8Array, k: number): number[][] =>
    pass.out.map((row) => row.filter((r) => mask[r.idx]).slice(0, k).map((r) => r.idx));

  // For occupations: after picking top-k, drop occupations that are semantically distant from each other
  // (cosine between them < OCC_PAIR_MIN). Weeds out bizarre pairings like plumbers+hairdressers.
  const OCC_PAIR_MIN = Number(Deno.env.get("OCC_PAIR_MIN") ?? "0.5");
  const occFinalizeWithPairFilter = (pass: { out: { idx: number; score: number }[][] }, mask: Uint8Array, k: number): number[][] => {
    const results: number[][] = [];
    let droppedByPair = 0;
    for (const row of pass.out) {
      const kept = row.filter((r) => mask[r.idx]);
      if (kept.length <= 1) { results.push(kept.slice(0, k).map((r) => r.idx)); continue; }
      // Keep top-1 always; for each subsequent, check cosine against all already-kept
      const finalIdxs: number[] = [kept[0].idx];
      for (let j = 1; j < kept.length && finalIdxs.length < k; j++) {
        const rj = kept[j].idx;
        let minCos = 1;
        for (const ki of finalIdxs) {
          let sc = 0;
          for (let d = 0; d < DIM; d++) sc += occMat[rj * DIM + d] * occMat[ki * DIM + d];
          if (sc < minCos) minCos = sc;
        }
        if (minCos >= OCC_PAIR_MIN) finalIdxs.push(rj);
        else droppedByPair++;
      }
      results.push(finalIdxs);
    }
    console.log(`[stage 3] occ pair filter: dropped ${droppedByPair} distant-pair occupations`);
    return results;
  };

  const occFinal = occFinalizeWithPairFilter(occPass, occMask, OCC_K);
  const topicFinal = finalize(topicPass, topicMask, TOPIC_K);

  const directEsco = parseEscoSkillOccupations();
  const directOnet = parseOnetSkillOccupations();
  const directEscoTopics = parseEscoSkillTopics();
  const DIRECT_OCC_CAP = Number(Deno.env.get("DIRECT_OCC_CAP") ?? "3");
  const DIRECT_TOPIC_CAP = Number(Deno.env.get("DIRECT_TOPIC_CAP") ?? "3");

  // Extract a framework-derived topic from OpenSALT tags (e.g. "framework:common-core-math-standards" → "math-standards")
  const frameworkTopic = (tagString: string): string | null => {
    const m = tagString.match(/framework:([^,]+)/);
    if (!m) return null;
    const raw = m[1];
    // Strip leading source/jurisdiction tokens — keep the content token(s)
    const simplified = raw.replace(/^(ui-|gcps-aks-|pcg-|ccs-|chicago-public-schools-illinois-|western-and-northern-canadian-protocol-)/, "");
    return simplified;
  };

  const rows: string[] = ["id\ttitle\tdescription\tsources\ttags\toccupations\ttopics"];
  const occCount = new Map<string, number>();
  const topicCount = new Map<string, number>();
  const occPerSkill: number[] = [];
  const topicPerSkill: number[] = [];
  let directOccHits = 0, directTopicHits = 0, frameworkHits = 0;
  for (let i = 0; i < skills.length; i++) {
    const s = skills[i];
    let occSlugs = occFinal[i].map((r) => slugify(occRefs[r].label)).filter((x) => x);
    let topicSlugs = topicFinal[i].map((r) => slugify(topicRefs[r].label)).filter((x) => x);

    if (s.sources.includes("esco")) {
      const dOcc = directEsco.get(s.id);
      if (dOcc?.length) {
        directOccHits++;
        const direct = dOcc.slice(0, DIRECT_OCC_CAP).map(slugify).filter((x) => x);
        occSlugs = [...new Set([...direct, ...occSlugs])].slice(0, DIRECT_OCC_CAP);
      }
      const dTopic = directEscoTopics.get(s.id);
      if (dTopic?.length) {
        directTopicHits++;
        const direct = dTopic.slice(0, DIRECT_TOPIC_CAP).map(slugify).filter((x) => x);
        topicSlugs = [...new Set([...direct, ...topicSlugs])].slice(0, DIRECT_TOPIC_CAP);
      }
    }
    if (s.sources.includes("onet")) {
      const dOcc = directOnet.get(s.id);
      if (dOcc?.length) {
        directOccHits++;
        const direct = dOcc.slice(0, DIRECT_OCC_CAP).map(slugify).filter((x) => x);
        occSlugs = [...new Set([...direct, ...occSlugs])].slice(0, DIRECT_OCC_CAP);
      }
    }
    if (s.sources.includes("opensalt")) {
      const ft = frameworkTopic(s.tags);
      if (ft) {
        frameworkHits++;
        topicSlugs = [...new Set([ft, ...topicSlugs])].slice(0, DIRECT_TOPIC_CAP);
      }
    }

    for (const x of occSlugs) occCount.set(x, (occCount.get(x) ?? 0) + 1);
    for (const x of topicSlugs) topicCount.set(x, (topicCount.get(x) ?? 0) + 1);
    occPerSkill.push(occSlugs.length);
    topicPerSkill.push(topicSlugs.length);
    rows.push([s.id, s.title, s.description, s.sources, s.tags, occSlugs.join(","), topicSlugs.join(",")].join("\t"));
  }
  console.log(`[stage 3] direct tags: ${directOccHits} esco-occ, ${directTopicHits} esco-topic, ${frameworkHits} opensalt-framework`);
  Deno.writeTextFileSync(`${BUILD}/3_tagged.tsv`, rows.join("\n") + "\n");
  // Stage 3b output, if it exists, is now stale — remove so stages 4+ reread from stage 3 until dedupe re-runs
  try { Deno.removeSync(`${BUILD}/3b_tagged_deduped.tsv`); } catch { /* ignore */ }

  const topN = (counts: Map<string, number>, n: number) =>
    [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  writeStats(3, {
    skills: skills.length,
    occ_refs: occRefs.length,
    topic_refs: topicRefs.length,
    occ_threshold: OCC_THRESHOLD,
    topic_threshold: TOPIC_THRESHOLD,
    occ_top_k: OCC_K,
    topic_top_k: TOPIC_K,
    occ_per_skill: { p50: pct(occPerSkill, 0.5), p95: pct(occPerSkill, 0.95), max: Math.max(...occPerSkill), mean: occPerSkill.reduce((a, b) => a + b, 0) / occPerSkill.length },
    topic_per_skill: { p50: pct(topicPerSkill, 0.5), p95: pct(topicPerSkill, 0.95), max: Math.max(...topicPerSkill), mean: topicPerSkill.reduce((a, b) => a + b, 0) / topicPerSkill.length },
    untagged_occupation: occPerSkill.filter((n) => n === 0).length,
    untagged_topic: topicPerSkill.filter((n) => n === 0).length,
    top_occupations: topN(occCount, 20),
    top_topics: topN(topicCount, 20),
    total_seconds: (performance.now() - t0) / 1000,
  });
}

// ---------- stage 4: difficulty ----------

// Map a grade token to a difficulty in [0, 15]. 0 = pre-K; 1 = kindergarten; then grades 1-12 map to 2-13; post-secondary tokens → 14-15.
function gradeToDifficulty(token: string): number | null {
  const t = token.toUpperCase().trim();
  if (t === "PK" || t === "PR" || t === "PRE-K" || t === "EC") return 0;
  if (t === "KG" || t === "K") return 1;
  const m = t.match(/^0?(\d{1,2})$/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 12) return n + 1;
  }
  if (t === "IT" || t === "CTE") return 14;
  if (/AP|COLLEGE|UG|UNDERGRAD/.test(t)) return 15;
  return null;
}

function stage4Difficulty() {
  const lines = Deno.readTextFileSync(taggedTsvPath()).split("\n").filter((l) => l.length);
  const hdr = lines[0].split("\t");
  const iTags = hdr.indexOf("tags");
  const iSources = hdr.indexOf("sources");
  const iTopics = hdr.indexOf("topics");
  const skills = lines.slice(1).map((l) => {
    const c = l.split("\t");
    return { id: c[0], title: c[1], sources: c[iSources], tags: c[iTags], topics: c[iTopics] };
  });

  const ids = Deno.readTextFileSync(`${BUILD}/2_ids.tsv`).split("\n").filter((l) => l.length);
  const bin = Deno.readFileSync(`${BUILD}/2_embeddings.bin`);
  const emb = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
  const idToEmbIdx = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) idToEmbIdx.set(ids[i], i);

  const DIM = EMBED_DIM;
  const vecs = new Float32Array(skills.length * DIM);
  for (let i = 0; i < skills.length; i++) {
    const ei = idToEmbIdx.get(skills[i].id);
    if (ei === undefined) throw new Error(`no embedding for ${skills[i].id}`);
    vecs.set(normalize(emb.subarray(ei * DIM, (ei + 1) * DIM)), i * DIM);
  }

  // Anchor difficulty per skill: OpenSALT grade > ONET default > unset (NaN)
  const anchor = new Float32Array(skills.length);
  anchor.fill(Number.NaN);
  let gradeAnchored = 0;
  for (let i = 0; i < skills.length; i++) {
    const s = skills[i];
    // Parse `grade:XX` tokens; if multiple grades, use the max (most-advanced encountered)
    const matches = [...s.tags.matchAll(/grade:([^,]+)/g)];
    const grades: number[] = [];
    for (const m of matches) {
      for (const part of m[1].split(".")) {
        const d = gradeToDifficulty(part);
        if (d !== null) grades.push(d);
      }
    }
    if (grades.length) {
      anchor[i] = Math.max(...grades);
      gradeAnchored++;
    }
  }
  const unanchored = skills.length - gradeAnchored;
  console.log(`[stage 4] anchors: grade=${gradeAnchored}, unanchored=${unanchored}`);

  // Collect anchor indices
  const anchorIdxs: number[] = [];
  for (let i = 0; i < skills.length; i++) if (!Number.isNaN(anchor[i])) anchorIdxs.push(i);
  console.log(`[stage 4] total anchors: ${anchorIdxs.length}`);

  // For each skill (including anchors, for consistency/smoothing), compute difficulty as kNN weighted mean of anchor difficulties.
  const K = Number(Deno.env.get("KNN_K") ?? "15");
  const t0 = performance.now();

  // Build topic → anchor set
  const topicToAnchors = new Map<string, number[]>();
  for (let a = 0; a < anchorIdxs.length; a++) {
    const ai = anchorIdxs[a];
    for (const topic of skills[ai].topics.split(",")) {
      if (!topic) continue;
      let arr = topicToAnchors.get(topic);
      if (!arr) { arr = []; topicToAnchors.set(topic, arr); }
      arr.push(a);
    }
  }
  console.log(`[stage 4] topic-to-anchor index: ${topicToAnchors.size} topics`);

  const candidates = (i: number): number[] => {
    const seen = new Set<number>();
    for (const topic of skills[i].topics.split(",")) {
      if (!topic) continue;
      const arr = topicToAnchors.get(topic);
      if (!arr) continue;
      for (const a of arr) seen.add(a);
    }
    return seen.size ? [...seen] : []; // empty → fall back to global kNN
  };
  let out: Float32Array;
  try {
    const cached = Deno.readFileSync(`${BUILD}/4_raw.bin`);
    if (cached.byteLength === skills.length * 4) {
      out = new Float32Array(cached.buffer, cached.byteOffset, skills.length);
      console.log(`[stage 4] loaded cached raw scores from 4_raw.bin — skipping kNN`);
    } else {
      throw new Error("size mismatch");
    }
  } catch {
    out = new Float32Array(skills.length);
  }
  let withinTopicHits = 0, globalFallbacks = 0;
  if (out.every((v) => v === 0)) {
  // Pack anchor vectors contiguously for cache-friendly inner loop
  const anchorMat = new Float32Array(anchorIdxs.length * DIM);
  const anchorDiff = new Float32Array(anchorIdxs.length);
  for (let a = 0; a < anchorIdxs.length; a++) {
    const ai = anchorIdxs[a];
    anchorMat.set(vecs.subarray(ai * DIM, (ai + 1) * DIM), a * DIM);
    anchorDiff[a] = anchor[ai];
  }

  for (let i = 0; i < skills.length; i++) {
    const sOff = i * DIM;
    const top: { score: number; a: number }[] = [];
    let pool: number[] | null = candidates(i);
    if (!pool.length) pool = null; // fall back to all anchors
    if (pool) withinTopicHits++; else globalFallbacks++;
    const iter = pool ?? null;
    const n = iter ? iter.length : anchorIdxs.length;
    for (let k = 0; k < n; k++) {
      const a = iter ? iter[k] : k;
      let sc = 0;
      const aOff = a * DIM;
      for (let d = 0; d < DIM; d++) sc += vecs[sOff + d] * anchorMat[aOff + d];
      if (top.length < K) {
        top.push({ score: sc, a });
        if (top.length === K) top.sort((x, y) => x.score - y.score);
      } else if (sc > top[0].score) {
        top[0] = { score: sc, a };
        top.sort((x, y) => x.score - y.score);
      }
    }
    // Weighted mean by score² (softmax-ish; higher similarity dominates)
    let num = 0, den = 0;
    for (const { score, a } of top) {
      const w = Math.max(0, score) ** 2;
      num += w * anchorDiff[a];
      den += w;
    }
    out[i] = den > 0 ? num / den : (Number.isNaN(anchor[i]) ? 10 : anchor[i]);
    if ((i + 1) % 5000 === 0) {
      const el = (performance.now() - t0) / 1000;
      console.log(`  ${i + 1}/${skills.length} (${((i + 1) / el).toFixed(0)}/s)`);
    }
  }
  } // end kNN guard

  // Tie-break equal raw values using embedding-based diversity + source priority so quantile bins split cleanly
  // Add small random jitter seeded by id hash so ties resolve deterministically but distribute
  const sorted = [...out].sort((a, b) => a - b);
  const rawMin = sorted[0], rawMax = sorted[sorted.length - 1];
  const jittered = new Float32Array(skills.length);
  for (let i = 0; i < skills.length; i++) {
    // Deterministic jitter based on id (simple hash), scaled by 1% of range
    let h = 0;
    for (let k = 0; k < skills[i].id.length; k++) h = ((h * 31) + skills[i].id.charCodeAt(k)) | 0;
    const jit = ((h >>> 0) % 1000) / 1000; // [0,1)
    jittered[i] = out[i] + (jit - 0.5) * 0.001; // tiny tie-break
  }

  // Non-OpenSALT skills get a bonus so workplace content lands higher than K-12 curriculum.
  // Apply bonus to JITTERED raw, then quantile-bin directly (no separate stretch — avoids pile-up).
  const biased = new Float32Array(skills.length);
  for (let i = 0; i < skills.length; i++) {
    biased[i] = jittered[i] + (skills[i].sources.includes("opensalt") ? 0 : 3);
  }

  // 20 equal-sized quantile bins over biased scores → guaranteed even distribution
  const idxOrder = [...Array(skills.length).keys()].sort((a, b) => biased[a] - biased[b]);
  const band = new Int32Array(skills.length);
  const bandCounts = new Array(20).fill(0);
  const bandSize = skills.length / 20;
  for (let rank = 0; rank < skills.length; rank++) {
    const i = idxOrder[rank];
    const b = Math.min(20, Math.floor(rank / bandSize) + 1);
    band[i] = b;
    bandCounts[b - 1]++;
  }
  const bands = Array.from({ length: 19 }, (_, i) => biased[idxOrder[Math.floor(skills.length * (i + 1) / 20)]]);
  void rawMin; void rawMax; void bands; // retained for stats compat

  // Write
  const rows = ["id\tdifficulty\tdifficulty_raw"];
  for (let i = 0; i < skills.length; i++) rows.push(`${skills[i].id}\t${band[i]}\t${out[i].toFixed(4)}`);
  Deno.writeTextFileSync(`${BUILD}/4_difficulty.tsv`, rows.join("\n") + "\n");
  // Cache raw scores so we can re-bin without rerunning kNN
  Deno.writeFileSync(`${BUILD}/4_raw.bin`, new Uint8Array(out.buffer));

  // Kendall-τ between grade-anchor ordering and final band, on grade-anchored subset
  let concordant = 0, discordant = 0;
  const sample: { raw: number; a: number }[] = [];
  for (let i = 0; i < skills.length; i++) if (!Number.isNaN(anchor[i]) && anchor[i] < 14) sample.push({ raw: out[i], a: anchor[i] });
  sample.length = Math.min(sample.length, 2000);
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      const ds = Math.sign(sample[i].raw - sample[j].raw);
      const da = Math.sign(sample[i].a - sample[j].a);
      if (ds === 0 || da === 0) continue;
      if (ds === da) concordant++; else discordant++;
    }
  }
  const tau = concordant + discordant ? (concordant - discordant) / (concordant + discordant) : 0;

  writeStats(4, {
    skills: skills.length,
    anchors: { grade: gradeAnchored, total: anchorIdxs.length, unanchored },
    within_topic: withinTopicHits,
    global_fallbacks: globalFallbacks,
    raw_stats: { p05: pct([...out], 0.05), p50: pct([...out], 0.5), p95: pct([...out], 0.95), min: sorted[0], max: sorted[sorted.length - 1] },
    band_distribution: bandCounts,
    kendall_tau_vs_anchor: tau,
    total_seconds: (performance.now() - t0) / 1000,
  });

  if (bandCounts.some((c) => c < skills.length * 0.01)) {
    console.warn(`[stage 4] warning: some bands have <1% of skills: ${bandCounts.join(", ")}`);
  }
}

// ---------- stage 5: prereq ----------

const PREREQ_CANDIDATES_CACHE = `${BUILD}/5_candidates.tsv`;
const PREREQ_BATCH_STATE = `${BUILD}/5_batch.json`;
const PREREQ_CACHE = `${BUILD}/5_prereqs.tsv`;
const PREREQ_SYSTEM = `You identify true prerequisites for a skill. Given a skill and a numbered list of candidate prerequisites (all from easier/earlier material), return the numbers of candidates that MUST be understood first before learning the skill. Be strict — only include genuinely foundational dependencies, not merely related or adjacent topics. Return ONLY a comma-separated list of numbers (e.g. "2,5,9") or the word "none". No explanation.`;

function parseSkillsWithDifficulty(): { skills: { id: string; title: string; description: string; topics: string }[]; diff: Int32Array; raw: Float32Array } {
  const tagged = Deno.readTextFileSync(taggedTsvPath()).split("\n").filter((l) => l.length);
  const taggedHdr = tagged[0].split("\t");
  const iTitle = taggedHdr.indexOf("title");
  const iDesc = taggedHdr.indexOf("description");
  const iTopics = taggedHdr.indexOf("topics");
  const skills = tagged.slice(1).map((l) => {
    const c = l.split("\t");
    return { id: c[0], title: c[iTitle], description: c[iDesc], topics: c[iTopics] };
  });

  const diffLines = Deno.readTextFileSync(`${BUILD}/4_difficulty.tsv`).split("\n").filter((l) => l.length).slice(1);
  const diffMap = new Map<string, { band: number; raw: number }>();
  for (const l of diffLines) { const c = l.split("\t"); diffMap.set(c[0], { band: Number(c[1]), raw: Number(c[2]) }); }
  const diff = new Int32Array(skills.length);
  const raw = new Float32Array(skills.length);
  for (let i = 0; i < skills.length; i++) {
    const e = diffMap.get(skills[i].id);
    if (!e) throw new Error(`no difficulty for ${skills[i].id}`);
    diff[i] = e.band;
    raw[i] = e.raw;
  }
  return { skills, diff, raw };
}

function loadPrereqCandidates(): Map<string, number[]> {
  try {
    const text = Deno.readTextFileSync(PREREQ_CANDIDATES_CACHE);
    const m = new Map<string, number[]>();
    for (const line of text.split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const id = line.slice(0, tab);
      const idxStr = line.slice(tab + 1);
      m.set(id, idxStr ? idxStr.split(",").map(Number).filter((n) => Number.isFinite(n)) : []);
    }
    return m;
  } catch { return new Map(); }
}

function computePrereqCandidates(): Map<string, number[]> {
  const { skills, raw } = parseSkillsWithDifficulty();
  const ids = Deno.readTextFileSync(`${BUILD}/2_ids.tsv`).split("\n").filter((l) => l.length);
  const bin = Deno.readFileSync(`${BUILD}/2_embeddings.bin`);
  const emb = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
  const idToEmbIdx = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) idToEmbIdx.set(ids[i], i);
  const DIM = EMBED_DIM;
  const vecs = new Float32Array(skills.length * DIM);
  for (let i = 0; i < skills.length; i++) {
    const ei = idToEmbIdx.get(skills[i].id);
    if (ei === undefined) throw new Error(`no embedding for ${skills[i].id}`);
    vecs.set(normalize(emb.subarray(ei * DIM, (ei + 1) * DIM)), i * DIM);
  }

  // topic → indexes (with difficulty)
  const topicIdx = new Map<string, number[]>();
  for (let i = 0; i < skills.length; i++) {
    for (const t of skills[i].topics.split(",")) {
      if (!t) continue;
      let arr = topicIdx.get(t);
      if (!arr) { arr = []; topicIdx.set(t, arr); }
      arr.push(i);
    }
  }

  const K = Number(Deno.env.get("PREREQ_K") ?? "15");
  const MIN_DIFF = Number(Deno.env.get("PREREQ_MIN_DIFF_DELTA") ?? "0.3"); // require strictly lower raw difficulty
  const ANCESTOR_K = Number(Deno.env.get("PREREQ_ANCESTOR_K") ?? "5"); // of the K slots, reserve for low-diff ancestors
  const out = new Map<string, number[]>();
  const outLines: string[] = [];

  const t0 = performance.now();
  for (let i = 0; i < skills.length; i++) {
    // Pool: within-topic skills with strictly lower raw difficulty (peer candidates)
    const pool = new Set<number>();
    for (const t of skills[i].topics.split(",")) {
      if (!t) continue;
      const arr = topicIdx.get(t);
      if (!arr) continue;
      for (const j of arr) if (raw[j] + MIN_DIFF <= raw[i]) pool.add(j);
    }
    // Fallback: global easier skills if pool is small
    let candidates: number[];
    if (pool.size >= K) {
      candidates = [...pool];
    } else {
      candidates = [];
      for (let j = 0; j < skills.length; j++) if (raw[j] + MIN_DIFF <= raw[i]) candidates.push(j);
    }

    // Ancestor seed: reserve ANCESTOR_K slots for much-lower-difficulty skills in same top-topic.
    // Catches foundational prereqs (e.g. "programming fundamentals" for "javascript").
    const ancestorSet = new Set<number>();
    const topics = skills[i].topics.split(",").filter((t) => t);
    if (topics.length > 0 && ANCESTOR_K > 0) {
      const ancestorMaxDiff = raw[i] - 2; // require ≥2 raw units lower
      for (const t of topics) {
        const arr = topicIdx.get(t);
        if (!arr) continue;
        // Sort arr by raw difficulty ascending, pick lowest few
        const sorted = [...arr].sort((a, b) => raw[a] - raw[b]);
        for (let k = 0; k < sorted.length && ancestorSet.size < ANCESTOR_K; k++) {
          if (raw[sorted[k]] <= ancestorMaxDiff) ancestorSet.add(sorted[k]);
          else break;
        }
        if (ancestorSet.size >= ANCESTOR_K) break;
      }
    }

    // Top (K - ancestorSet.size) by cosine similarity among candidates (exclude ancestors we'll add directly)
    const sOff = i * DIM;
    const top: { idx: number; score: number }[] = [];
    const remainingK = Math.max(1, K - ancestorSet.size);
    for (const j of candidates) {
      if (ancestorSet.has(j)) continue;
      let sc = 0;
      const aOff = j * DIM;
      for (let d = 0; d < DIM; d++) sc += vecs[sOff + d] * vecs[aOff + d];
      if (top.length < remainingK) {
        top.push({ idx: j, score: sc });
        if (top.length === remainingK) top.sort((a, b) => a.score - b.score);
      } else if (sc > top[0].score) {
        top[0] = { idx: j, score: sc };
        top.sort((a, b) => a.score - b.score);
      }
    }
    top.sort((a, b) => b.score - a.score);
    const idxs = [...ancestorSet, ...top.map((t) => t.idx)].slice(0, K);
    out.set(skills[i].id, idxs);
    outLines.push(`${skills[i].id}\t${idxs.join(",")}`);
    if ((i + 1) % 5000 === 0) {
      const el = (performance.now() - t0) / 1000;
      console.log(`  candidates ${i + 1}/${skills.length} (${((i + 1) / el).toFixed(0)}/s)`);
    }
  }
  Deno.writeTextFileSync(PREREQ_CANDIDATES_CACHE, outLines.join("\n") + "\n");
  return out;
}

function formatPrereqPrompt(s: { title: string; description: string }, candTitles: string[]): string {
  const desc = s.description ? `\nDescription: ${s.description.slice(0, 200)}` : "";
  const cands = candTitles.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return `Skill: ${s.title}${desc}\n\nCandidates:\n${cands}\n\nPrerequisite numbers (or "none"):`;
}

function parsePrereqResponse(text: string, numCandidates: number): number[] {
  const t = text.trim().toLowerCase();
  if (t === "none" || t === "" || t === "n/a") return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const m of t.matchAll(/\d+/g)) {
    const n = Number(m[0]);
    if (n >= 1 && n <= numCandidates && !seen.has(n)) {
      seen.add(n);
      out.push(n - 1); // convert to 0-based
    }
  }
  return out.slice(0, 5); // cap at 5 prereqs per skill
}

function loadPrereqCache(): Map<string, string> {
  try {
    const text = Deno.readTextFileSync(PREREQ_CACHE);
    const m = new Map<string, string>();
    for (const line of text.split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      m.set(line.slice(0, tab), line.slice(tab + 1));
    }
    return m;
  } catch { return new Map(); }
}

async function submitPrereqBatch(batch: { id: string; title: string; description: string; candTitles: string[] }[]): Promise<{ batchId: string; idMap: Record<string, string> }> {
  const idMap: Record<string, string> = {};
  const requests = await Promise.all(batch.map(async (b, i) => {
    const cid = await shortId(b.id, i);
    idMap[cid] = b.id;
    return {
      custom_id: cid,
      params: {
        model: PREREQ_MODEL,
        max_tokens: 40,
        system: [{ type: "text", text: PREREQ_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: formatPrereqPrompt(b, b.candTitles) }],
      },
    };
  }));
  const body = JSON.stringify({ requests });
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages/batches", {
        method: "POST",
        headers: ANTHROPIC_HEADERS,
        body,
      });
      if (res.ok) {
        const j = await res.json();
        return { batchId: j.id, idMap };
      }
      const txt = await res.text();
      if (res.status === 429 || res.status >= 500) {
        const delay = Math.min(60 * attempt, 300);
        console.warn(`  [submit retry ${attempt}/8] ${res.status}: ${txt.slice(0, 150)} — sleeping ${delay}s`);
        await new Promise((r) => setTimeout(r, delay * 1000));
        continue;
      }
      throw new Error(`prereq batch submit ${res.status}: ${txt}`);
    } catch (err) {
      const msg = (err as Error).message;
      if (/prereq batch submit [1-4]\d\d/.test(msg)) throw err; // non-5xx from above
      const delay = Math.min(30 * attempt, 300);
      console.warn(`  [submit retry ${attempt}/8] network err: ${msg} — sleeping ${delay}s`);
      await new Promise((r) => setTimeout(r, delay * 1000));
    }
  }
  throw new Error("prereq batch submit: exhausted retries");
}

async function stage5Prereq() {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const { skills } = parseSkillsWithDifficulty();

  // Step 1: build or load candidates
  let candidates = loadPrereqCandidates();
  if (candidates.size !== skills.length) {
    console.log(`[stage 5] computing candidates for ${skills.length} skills…`);
    candidates = computePrereqCandidates();
  } else {
    console.log(`[stage 5] loaded ${candidates.size} cached candidate lists`);
  }

  // also track candidate ids already in any in-flight batch (prevents double-submission after download)
  const inFlightIds = new Set<string>();
  {
    try {
      const s: { batches: { id: string; idMap: Record<string, string> }[] } = JSON.parse(Deno.readTextFileSync(PREREQ_BATCH_STATE));
      for (const b of s.batches) for (const v of Object.values(b.idMap)) inFlightIds.add(v);
    } catch { /* none */ }
  }

  const buildTodo = () => {
    const cache = loadPrereqCache();
    const out: { id: string; title: string; description: string; candTitles: string[] }[] = [];
    for (const s of skills) {
      if (cache.has(s.id)) continue;
      if (inFlightIds.has(s.id)) continue;
      const cands = candidates.get(s.id);
      if (!cands || cands.length === 0) continue;
      out.push({
        id: s.id,
        title: s.title,
        description: s.description,
        candTitles: cands.map((j) => skills[j].title),
      });
    }
    return out;
  };
  let todo = buildTodo();
  console.log(`[stage 5] targets: ${skills.length}, in-flight: ${inFlightIds.size}, to submit: ${todo.length}`);

  // Step 2: resume existing batch(es) if any
  let state: { batches: { id: string; idMap: Record<string, string> }[] } | null = null;
  try { state = JSON.parse(Deno.readTextFileSync(PREREQ_BATCH_STATE)); } catch { /* none */ }

  if (state) {
    console.log(`[stage 5] resuming ${state.batches.length} batch(es)`);
    const skillOrder = skills.map((s) => s.id);
    const remaining: typeof state.batches = [];
    for (const b of state.batches) {
      const p = await pollBatch(b.id);
      console.log(`  batch ${b.id} status=${p.status} counts=${JSON.stringify(p.counts)}`);
      if (p.status === "ended") {
        if (!p.resultsUrl) throw new Error("no results_url");
        const res = await fetch(p.resultsUrl, { headers: ANTHROPIC_HEADERS });
        if (!res.ok) throw new Error(`results ${res.status}`);
        const text = await res.text();
        const fh = Deno.openSync(PREREQ_CACHE, { create: true, append: true });
        const enc = new TextEncoder();
        let ok = 0, err = 0;
        for (const line of text.split("\n")) {
          if (!line) continue;
          const j = JSON.parse(line);
          const skillId = b.idMap[j.custom_id];
          if (!skillId) continue;
          if (j.result?.type !== "succeeded") { err++; continue; }
          const raw = (j.result.message.content?.[0]?.text ?? "").replace(/[\t\n\r]/g, " ");
          // Resolve positional indexes to prereq ids so responses survive skill-array reorders (e.g. from dedupe)
          const cands = candidates.get(skillId) ?? [];
          const picks = parsePrereqResponse(raw, cands.length);
          const resolved = picks.map((p) => skillOrder[cands[p]]).filter((x) => x).join(",");
          fh.writeSync(enc.encode(`${skillId}\t${resolved}\n`));
          ok++;
        }
        fh.close();
        console.log(`  wrote ${ok} successful, ${err} errored`);
      } else {
        remaining.push(b);
      }
    }
    // Any batch that ended has had its responses downloaded — rebuild todo so we don't resubmit them.
    todo = buildTodo();
    if (remaining.length === 0) {
      try { Deno.removeSync(PREREQ_BATCH_STATE); } catch { /* ignore */ }
      console.log(`[stage 5] all batches complete`);
      state = { batches: [] };
    } else {
      Deno.writeTextFileSync(PREREQ_BATCH_STATE, JSON.stringify({ batches: remaining }));
      console.log(`[stage 5] ${remaining.length} batch(es) still processing — will top up to parallel cap`);
      state = { batches: remaining };
    }
  }

  if (todo.length === 0) {
    // Write final prereqs.tsv edge list
    const cacheFinal = loadPrereqCache();
    console.log(`[stage 5] writing edges from ${cacheFinal.size} responses`);
    const skillIds = new Set(skills.map((s) => s.id));
    const edgeFh = Deno.openSync(`${BUILD}/5_edges.tsv`, { create: true, write: true, truncate: true });
    const enc = new TextEncoder();
    edgeFh.writeSync(enc.encode("skill_id\tprereq_id\n"));
    let edges = 0, orphans = 0;
    for (const s of skills) {
      const resp = cacheFinal.get(s.id);
      if (!resp || resp === "none") { orphans++; continue; }
      // Detect format: resolved-ids (contain hyphens/letters) vs legacy positional
      const isResolved = /[a-z]|-/.test(resp);
      if (isResolved) {
        let n = 0;
        for (const pid of resp.split(",")) {
          if (!pid || !skillIds.has(pid)) continue;
          edgeFh.writeSync(enc.encode(`${s.id}\t${pid}\n`));
          edges++; n++;
        }
        if (n === 0) orphans++;
      } else {
        const cands = candidates.get(s.id) ?? [];
        if (!cands.length) { orphans++; continue; }
        const picks = parsePrereqResponse(resp, cands.length);
        if (picks.length === 0) { orphans++; continue; }
        for (const p of picks) {
          const prereq = skills[cands[p]];
          if (prereq) { edgeFh.writeSync(enc.encode(`${s.id}\t${prereq.id}\n`)); edges++; }
        }
      }
    }
    edgeFh.close();
    writeStats(5, {
      skills: skills.length,
      responses: cacheFinal.size,
      edges,
      orphans,
      orphan_rate: orphans / skills.length,
    });
    return;
  }

  // Step 3: submit multiple batches to fill the processing pipeline
  const CHUNK = Number(Deno.env.get("PREREQ_CHUNK") ?? "20000");
  const PARALLEL_BATCHES = Number(Deno.env.get("PREREQ_PARALLEL") ?? "3");
  const inFlight = state?.batches ?? [];
  const slots = Math.max(0, PARALLEL_BATCHES - inFlight.length);
  const batches = [...inFlight];
  let off = 0;
  for (let n = 0; n < slots && off < todo.length; n++) {
    const chunk = todo.slice(off, off + CHUNK);
    if (Deno.env.get("PREREQ_LIMIT")) {
      chunk.length = Math.min(chunk.length, Number(Deno.env.get("PREREQ_LIMIT")));
    }
    const b = await submitPrereqBatch(chunk);
    batches.push({ id: b.batchId, idMap: b.idMap });
    console.log(`[stage 5] batch ${b.batchId}: ${chunk.length} requests submitted`);
    Deno.writeTextFileSync(PREREQ_BATCH_STATE, JSON.stringify({ batches })); // save after each
    off += chunk.length;
  }
  console.log(`[stage 5] ${batches.length} batch(es), ${off}/${todo.length} queued. Re-run to poll + submit next.`);
}

// ---------- stage 6: post-process prereqs ----------

function stage6PostProc() {
  const tagLines = Deno.readTextFileSync(taggedTsvPath()).split("\n").filter((l) => l.length);
  const hdr = tagLines[0].split("\t");
  const iTitle = hdr.indexOf("title");
  const iTags = hdr.indexOf("tags");
  const iTopics = hdr.indexOf("topics");
  const order: string[] = tagLines.slice(1).map((l) => l.split("\t")[0]);
  const skill = new Map<string, { title: string; tags: string; topics: Set<string> }>();
  for (let i = 1; i < tagLines.length; i++) {
    const c = tagLines[i].split("\t");
    skill.set(c[0], {
      title: c[iTitle],
      tags: c[iTags],
      topics: new Set(c[iTopics].split(",").filter((t) => t)),
    });
  }
  const diffLines = Deno.readTextFileSync(`${BUILD}/4_difficulty.tsv`).split("\n").filter((l) => l.length);
  const rawDiff = new Map<string, number>();
  for (let i = 1; i < diffLines.length; i++) {
    const c = diffLines[i].split("\t");
    rawDiff.set(c[0], Number(c[2]));
  }
  const candLines = Deno.readTextFileSync(`${BUILD}/5_candidates.tsv`).split("\n").filter((l) => l.length);
  const candidates = new Map<string, number[]>();
  for (const line of candLines) {
    const tab = line.indexOf("\t");
    const id = line.slice(0, tab);
    const rest = line.slice(tab + 1);
    candidates.set(id, rest ? rest.split(",").map(Number) : []);
  }

  // Dedupe prereqs cache (file may have retry duplicates — keep last value per id)
  const prereqLines = Deno.readTextFileSync(`${BUILD}/5_prereqs.tsv`).split("\n").filter((l) => l.length);
  const pick = new Map<string, string>();
  for (const line of prereqLines) {
    const tab = line.indexOf("\t");
    pick.set(line.slice(0, tab), line.slice(tab + 1));
  }

  // Build raw edge list. Detect format: resolved-ids (contains hyphens) vs legacy positional (digits only).
  let raw: [string, string][] = [];
  for (const [id, resp] of pick) {
    if (!resp || resp === "none") continue;
    const isResolved = /-/.test(resp) || /[a-z]/.test(resp);
    if (isResolved) {
      for (const pid of resp.split(",")) if (pid) raw.push([id, pid]);
    } else {
      const cands = candidates.get(id) ?? [];
      const picks = parsePrereqResponse(resp, cands.length);
      for (const p of picks) {
        const prereqId = order[cands[p]];
        if (prereqId) raw.push([id, prereqId]);
      }
    }
  }
  // Apply dedupe alias if exists
  try {
    const aliasLines = Deno.readTextFileSync(`${BUILD}/3b_aliases.tsv`).split("\n").filter((l) => l.length);
    const alias = new Map<string, string>();
    for (let i = 1; i < aliasLines.length; i++) {
      const [d, c] = aliasLines[i].split("\t");
      alias.set(d, c);
    }
    raw = raw.map(([s, p]) => [alias.get(s) ?? s, alias.get(p) ?? p] as [string, string])
      .filter(([s, p]) => s !== p);
    console.log(`[stage 6] applied ${alias.size} aliases`);
  } catch { /* no dedupe */ }
  const beforeTotal = raw.length;
  console.log(`[stage 6] raw edges: ${beforeTotal}`);

  // --- Filter 0: drop band-inverted edges (prereq.band > skill.band) ---
  // These occur when the non-OpenSALT +3 bonus crosses a grade-anchor boundary.
  // Raw-diff ordering was preserved in stage 5, but band-level ordering can invert.
  const diffLines2 = Deno.readTextFileSync(`${BUILD}/4_difficulty.tsv`).split("\n").filter((l) => l.length);
  const band = new Map<string, number>();
  for (let i = 1; i < diffLines2.length; i++) {
    const c = diffLines2[i].split("\t");
    band.set(c[0], Number(c[1]));
  }
  const beforeBandFilter = raw.length;
  raw = raw.filter(([s, p]) => (band.get(p) ?? 0) <= (band.get(s) ?? 20));
  console.log(`[stage 6] dropped ${beforeBandFilter - raw.length} band-inverted edges`);

  // --- Filter 1: drop onet:tech prereqs that are cross-domain noise ---
  // Keep if: skill itself is onet:tech (tech→tech), OR prereq slug appears in skill's topics.
  // Preserve at least one prereq per skill — fall back to best remaining if filter would empty all.
  const bySkill = new Map<string, string[]>();
  for (const [s, p] of raw) { const arr = bySkill.get(s) ?? []; arr.push(p); bySkill.set(s, arr); }
  let droppedTech = 0;
  const filtered: [string, string][] = [];
  for (const [s, prereqs] of bySkill) {
    const ssk = skill.get(s);
    const kept = prereqs.filter((p) => {
      const psk = skill.get(p);
      if (!psk) return true;
      if (!psk.tags.includes("onet:tech")) return true;
      if (ssk?.tags.includes("onet:tech")) return true; // tech→tech OK
      if (ssk?.topics.has(p)) return true; // product is one of skill's topics
      return false;
    });
    // If filter emptied skill's prereqs, keep the first original prereq as fallback
    const final = kept.length ? kept : (prereqs.length ? [prereqs[0]] : []);
    droppedTech += prereqs.length - final.length;
    for (const p of final) filtered.push([s, p]);
  }
  raw = filtered;
  console.log(`[stage 6] dropped ${droppedTech} cross-domain onet:tech edges`);

  // --- Filter 2: cap fan-out per prereq ---
  const HUB_CAP = Number(Deno.env.get("HUB_CAP") ?? "50");
  const downstreamOfPrereq = new Map<string, [string, string][]>();
  for (const e of raw) {
    const arr = downstreamOfPrereq.get(e[1]) ?? []; arr.push(e); downstreamOfPrereq.set(e[1], arr);
  }
  let droppedHub = 0;
  const keep = new Set<string>();
  for (const [prereqId, edges] of downstreamOfPrereq) {
    if (edges.length <= HUB_CAP) {
      for (const e of edges) keep.add(e[0] + "\t" + e[1]);
      continue;
    }
    const pRaw = rawDiff.get(prereqId) ?? 0;
    // Prefer edges where skill's raw difficulty is closest to prereq's (immediate prereqs)
    edges.sort((a, b) => Math.abs((rawDiff.get(a[0]) ?? 0) - pRaw) - Math.abs((rawDiff.get(b[0]) ?? 0) - pRaw));
    for (let i = 0; i < HUB_CAP; i++) keep.add(edges[i][0] + "\t" + edges[i][1]);
    droppedHub += edges.length - HUB_CAP;
  }
  console.log(`[stage 6] dropped ${droppedHub} hub-excess edges (cap ${HUB_CAP})`);

  const final: [string, string][] = raw.filter((e) => keep.has(e[0] + "\t" + e[1]));

  // --- Final: ensure every non-orphan skill keeps at least one prereq ---
  // (already preserved since we filter by edge, not by skill — but log skills that got all their edges removed)
  const skillsWithFinalPrereqs = new Set(final.map((e) => e[0]));
  const skillsWithRawPrereqs = new Set<string>();
  for (const [id, resp] of pick) {
    const cands = candidates.get(id) ?? [];
    if (parsePrereqResponse(resp, cands.length).length > 0) skillsWithRawPrereqs.add(id);
  }
  let lostAll = 0;
  for (const id of skillsWithRawPrereqs) if (!skillsWithFinalPrereqs.has(id)) lostAll++;

  // Write final edges
  const enc = new TextEncoder();
  const fh = Deno.openSync(`${BUILD}/6_edges.tsv`, { create: true, write: true, truncate: true });
  fh.writeSync(enc.encode("skill_id\tprereq_id\n"));
  for (const [s, p] of final) fh.writeSync(enc.encode(`${s}\t${p}\n`));
  fh.close();

  // Rebuild hub report
  const finalHubs = new Map<string, number>();
  for (const [, p] of final) finalHubs.set(p, (finalHubs.get(p) ?? 0) + 1);
  const topHubs = [...finalHubs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

  writeStats(6, {
    before_edges: beforeTotal,
    dropped_tech: droppedTech,
    dropped_hub: droppedHub,
    final_edges: final.length,
    skills_with_prereqs: skillsWithFinalPrereqs.size,
    skills_lost_all_prereqs: lostAll,
    orphan_rate: 1 - skillsWithFinalPrereqs.size / skill.size,
    top_hubs_after: topHubs.map(([id, n]) => [id, n, skill.get(id)?.title.slice(0, 60)]),
  });
}

// ---------- stage 7: finalize skills.tsv ----------

function stage7Finalize() {
  const taggedLines = Deno.readTextFileSync(taggedTsvPath()).split("\n").filter((l) => l.length);
  const thdr = taggedLines[0].split("\t");
  const iTitle = thdr.indexOf("title");
  const iDesc = thdr.indexOf("description");
  const iOcc = thdr.indexOf("occupations");
  const iTop = thdr.indexOf("topics");
  const skills = taggedLines.slice(1).map((l) => {
    const c = l.split("\t");
    return { id: c[0], title: c[iTitle], description: c[iDesc], occupations: c[iOcc], topics: c[iTop] };
  });

  const diffLines = Deno.readTextFileSync(`${BUILD}/4_difficulty.tsv`).split("\n").filter((l) => l.length);
  const diff = new Map<string, number>();
  for (let i = 1; i < diffLines.length; i++) {
    const c = diffLines[i].split("\t");
    diff.set(c[0], Number(c[1]));
  }

  const edgeLines = Deno.readTextFileSync(`${BUILD}/6_edges.tsv`).split("\n").filter((l) => l.length).slice(1);
  const prereqs = new Map<string, string[]>();
  for (const l of edgeLines) {
    const [s, p] = l.split("\t");
    const arr = prereqs.get(s) ?? []; arr.push(p); prereqs.set(s, arr);
  }

  // Emit
  const rows = ["id\ttitle\tdescription\tdifficulty\tprereqs\toccupations\ttopics\tcerts"];
  for (const s of skills) {
    const d = diff.get(s.id);
    if (d === undefined) throw new Error(`skill ${s.id} missing from difficulty.tsv`);
    const ps = (prereqs.get(s.id) ?? []).join(",");
    rows.push([s.id, s.title, s.description, d.toString(), ps, s.occupations, s.topics, ""].join("\t"));
  }
  Deno.writeTextFileSync("skills.tsv", rows.join("\n") + "\n");

  // gzip (keep original)
  new Deno.Command("gzip", { args: ["-kf", "skills.tsv"] }).outputSync();
  const src = Deno.readFileSync("skills.tsv");

  // Reachability BFS from lowest-difficulty anchors
  const adj = new Map<string, string[]>();
  for (const l of edgeLines) {
    const [s, p] = l.split("\t");
    // prereq p → skill s edge (learning order: prereq before skill)
    const arr = adj.get(p) ?? []; arr.push(s); adj.set(p, arr);
  }
  const roots = skills.filter((s) => !prereqs.has(s.id)).map((s) => s.id);
  const visited = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of adj.get(u) ?? []) if (!visited.has(v)) { visited.add(v); queue.push(v); }
  }

  writeStats(7, {
    skills_emitted: skills.length,
    edges: edgeLines.length,
    skills_with_prereqs: prereqs.size,
    orphan_skills: skills.length - prereqs.size,
    roots: roots.length,
    reachable_from_roots: visited.size,
    unreachable: skills.length - visited.size,
    file_bytes: src.byteLength,
  });
}

// ---------- stage 3b: dedupe near-identical skills (runs after tag, before difficulty) ----------

// One-time migration: convert 5_prereqs.tsv from positional indexes to resolved prereq ids.
// Old format: skill_id \t "1,3,5"  New format: skill_id \t prereq_id1,prereq_id2,prereq_id3
function migratePrereqsToResolvedIds() {
  const path = `${BUILD}/5_prereqs.tsv`;
  let text: string;
  try { text = Deno.readTextFileSync(path); } catch { return; }
  const lines = text.split("\n").filter((l) => l.length);
  if (!lines.length) return;
  // Detect format: if any non-none response starts with non-digit or contains hyphen → already resolved
  const sample = lines.slice(0, 50).map((l) => l.split("\t")[1] || "");
  const looksResolved = sample.some((s) => s && s !== "none" && /-/.test(s));
  if (looksResolved) return; // already migrated

  console.log(`[migration] converting ${lines.length} prereq responses to resolved-id format`);
  // Need: skill id order and candidates
  const taggedLines = Deno.readTextFileSync(`${BUILD}/3_tagged.tsv`).split("\n").filter((l) => l.length);
  const order: string[] = taggedLines.slice(1).map((l) => l.split("\t")[0]);
  const candLines = Deno.readTextFileSync(`${BUILD}/5_candidates.tsv`).split("\n").filter((l) => l.length);
  const candidates = new Map<string, number[]>();
  for (const line of candLines) {
    const tab = line.indexOf("\t");
    const id = line.slice(0, tab);
    const rest = line.slice(tab + 1);
    candidates.set(id, rest ? rest.split(",").map(Number) : []);
  }

  const resolved = new Map<string, string>();
  for (const line of lines) {
    const tab = line.indexOf("\t");
    const id = line.slice(0, tab);
    const resp = line.slice(tab + 1);
    const cands = candidates.get(id) ?? [];
    const picks = parsePrereqResponse(resp, cands.length);
    const prereqIds = picks.map((p) => order[cands[p]]).filter((x) => x);
    resolved.set(id, prereqIds.join(","));
  }
  const out = [...resolved.entries()].map(([id, v]) => `${id}\t${v}`).join("\n") + "\n";
  Deno.writeTextFileSync(path + ".bak", text);
  Deno.writeTextFileSync(path, out);
  console.log(`[migration] migrated ${resolved.size} rows; backup at ${path}.bak`);
}

function stage3bDedupe() {
  migratePrereqsToResolvedIds();
  const lines = Deno.readTextFileSync(`${BUILD}/3_tagged.tsv`).split("\n").filter((l) => l.length);
  const hdrCols = lines[0].split("\t");
  type Row = { id: string; title: string; description: string; sources: string; tags: string; occupations: string; topics: string };
  const rows: Row[] = lines.slice(1).map((l) => {
    const c = l.split("\t");
    return { id: c[0], title: c[1], description: c[2], sources: c[3], tags: c[4], occupations: c[5], topics: c[6] };
  });

  // Load embeddings
  const ids = Deno.readTextFileSync(`${BUILD}/2_ids.tsv`).split("\n").filter((l) => l.length);
  const bin = Deno.readFileSync(`${BUILD}/2_embeddings.bin`);
  const emb = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
  const DIM = EMBED_DIM;
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) idToIdx.set(ids[i], i);
  const vecs = new Float32Array(rows.length * DIM);
  for (let i = 0; i < rows.length; i++) {
    const embIdx = idToIdx.get(rows[i].id);
    if (embIdx === undefined) throw new Error(`no embedding for ${rows[i].id}`);
    vecs.set(normalize(emb.subarray(embIdx * DIM, (embIdx + 1) * DIM)), i * DIM);
  }

  const DEDUPE_COSINE = Number(Deno.env.get("DEDUPE_COSINE") ?? "0.96");

  // Bucket by top-topic (pre-difficulty) — catches duplicates at any difficulty
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const topic = rows[i].topics.split(",")[0] || "_notopic";
    const arr = buckets.get(topic) ?? []; arr.push(i); buckets.set(topic, arr);
  }
  console.log(`[stage 3b] ${buckets.size} buckets, largest=${Math.max(...[...buckets.values()].map((a) => a.length))}`);

  // Merge map: idx → canonical idx
  const parent = new Int32Array(rows.length);
  for (let i = 0; i < rows.length; i++) parent[i] = i;
  function find(i: number): number { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  function union(a: number, b: number) {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    // Canonical = shortest title (prefer well-formed ids: lowercase + hyphens only)
    const keep = rows[ra].title.length <= rows[rb].title.length ? ra : rb;
    const drop = keep === ra ? rb : ra;
    parent[drop] = keep;
  }

  // Jaccard similarity of title word sets — prevents merging semantically-close but lexically-unrelated items
  const wordSet = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const w of s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
      if (w.length >= 2 && !/^(the|a|an|of|for|and|to|in|on|at|by|with|is|are|be|or)$/.test(w)) out.add(w);
    }
    return out;
  };
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  };
  const JACCARD_MIN = Number(Deno.env.get("DEDUPE_JACCARD") ?? "0.7");
  const wordSets = rows.map((r) => wordSet(r.title));

  let merged = 0, rejectedByJaccard = 0, skippedHuge = 0;
  for (const [, idxs] of buckets) {
    if (idxs.length < 2) continue;
    if (idxs.length > 1500) { skippedHuge++; continue; } // huge generic topics: skip to stay quadratic-tractable
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        // quick Jaccard gate before cosine (cheaper)
        const j = jaccard(wordSets[idxs[a]], wordSets[idxs[b]]);
        if (j < JACCARD_MIN) continue;
        let sc = 0;
        const oa = idxs[a] * DIM, ob = idxs[b] * DIM;
        for (let d = 0; d < DIM; d++) sc += vecs[oa + d] * vecs[ob + d];
        if (sc < DEDUPE_COSINE) continue;
        union(idxs[a], idxs[b]);
        merged++;
      }
    }
  }
  console.log(`[stage 3b] skipped ${skippedHuge} oversize buckets`);
  void rejectedByJaccard;
  console.log(`[stage 3b] ${merged} union-merges`);

  // Build id → canonical_id alias map (preserves stable survivors)
  const alias = new Map<string, string>();
  let survivors = 0, dropped = 0;
  for (let i = 0; i < rows.length; i++) {
    const canonical = find(i);
    if (canonical === i) survivors++;
    else { alias.set(rows[i].id, rows[canonical].id); dropped++; }
  }
  console.log(`[stage 3b] survivors=${survivors}, dropped=${dropped}`);

  // Write deduped tagged.tsv with merged ext_ids + unioned occupations/topics from merged skills
  const groupBy = new Map<number, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const c = find(i);
    const arr = groupBy.get(c) ?? []; arr.push(i); groupBy.set(c, arr);
  }
  const outLines = [hdrCols.join("\t")];
  for (const [canonicalIdx, groupIdxs] of groupBy) {
    const canonical = rows[canonicalIdx];
    // Union occupation/topic tags from the group
    const occs = new Set<string>();
    const topics = new Set<string>();
    const allTags = new Set<string>(canonical.tags.split(","));
    for (const i of groupIdxs) {
      for (const o of rows[i].occupations.split(",").filter((x) => x)) occs.add(o);
      for (const t of rows[i].topics.split(",").filter((x) => x)) topics.add(t);
      for (const tg of rows[i].tags.split(",").filter((x) => x)) allTags.add(tg);
    }
    outLines.push([
      canonical.id, canonical.title, canonical.description,
      canonical.sources, [...allTags].join(","),
      [...occs].slice(0, 3).join(","), [...topics].slice(0, 3).join(","),
    ].join("\t"));
  }
  Deno.writeTextFileSync(`${BUILD}/3b_tagged_deduped.tsv`, outLines.join("\n") + "\n");

  // Write alias file (both directions)
  const aliasLines = ["dropped_id\tcanonical_id"];
  for (const [drop, keep] of alias) aliasLines.push(`${drop}\t${keep}`);
  Deno.writeTextFileSync(`${BUILD}/3b_aliases.tsv`, aliasLines.join("\n") + "\n");

  writeStats(35, {
    before: rows.length,
    dropped,
    after: survivors,
    reduction_pct: 100 * dropped / rows.length,
    buckets: buckets.size,
    skipped_huge_buckets: skippedHuge,
    dedupe_cosine: DEDUPE_COSINE,
    jaccard_min: JACCARD_MIN,
  });
}

// ---------- dispatch ----------

const stages: Record<string, () => void | Promise<void>> = {
  list: stage1List,
  infill: stage1bInfill,
  summarize: stage1cSummarize,
  "onet-desc": stage1dOnetDesc,
  embed: stage2Embed,
  tag: stage3Tag,
  dedupe: stage3bDedupe,
  difficulty: stage4Difficulty,
  prereq: stage5Prereq,
  postproc: stage6PostProc,
  finalize: stage7Finalize,
};

const arg = Deno.args[0];
if (arg) {
  const fn = stages[arg];
  if (!fn) throw new Error(`unknown stage: ${arg}. known: ${Object.keys(stages).join(", ")}`);
  await fn();
} else {
  for (const [name, fn] of Object.entries(stages)) {
    console.log(`\n=== ${name} ===`);
    await fn();
  }
}
