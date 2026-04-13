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
    let n = 0, skipped = 0;
    for (const e of Deno.readDirSync("data/opensalt")) {
      if (!e.name.endsWith(".json") || e.name === "index.json") continue;
      const j = JSON.parse(Deno.readTextFileSync(`data/opensalt/${e.name}`));
      const items = j.CFItems || [];
      const doc = j.CFDocument?.title || "opensalt";
      for (const it of items) {
        const title = (it.fullStatement || "").trim();
        if (!title || title.length > 400) { skipped++; continue; }
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
    console.log(`  opensalt: ${n} (skipped ${skipped} oversized/empty)`);
  }

  // Dedupe by fuzzy key (alphanumeric lower-case, stopwords removed, stable word order) — merges "Machine Learning" / "machine learning" / "ML"… (kept distinct), "machine learning (ML)" / "Machine-Learning" / "machine_learning" (merged)
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

// ---------- stage 2: embed ----------

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
  const OCC_THRESHOLD = Number(Deno.env.get("OCC_THRESHOLD") ?? "0.58");
  const TOPIC_THRESHOLD = Number(Deno.env.get("TOPIC_THRESHOLD") ?? "0.58");
  // Drop refs that match more than this fraction of skills — they're non-discriminative
  const IDF_MAX_FRAC = Number(Deno.env.get("IDF_MAX_FRAC") ?? "0.03");

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

  const occFinal = finalize(occPass, occMask, OCC_K);
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
  const lines = Deno.readTextFileSync(`${BUILD}/3_tagged.tsv`).split("\n").filter((l) => l.length);
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
  if (ids.length !== skills.length) throw new Error(`ids (${ids.length}) vs skills (${skills.length}) mismatch`);

  const DIM = EMBED_DIM;
  const vecs = new Float32Array(skills.length * DIM);
  for (let i = 0; i < skills.length; i++) vecs.set(normalize(emb.subarray(i * DIM, (i + 1) * DIM)), i * DIM);

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

  // Non-grade skills (ESCO/ONET/Lightcast) get a maturity bonus — they're workplace-level, not curriculum.
  // Raw range 0..13 from grades; stretch to 1..17 and add +3 for non-OpenSALT sources so they land 4..20.
  const sorted = [...out].sort((a, b) => a - b);
  const rawMin = sorted[0], rawMax = sorted[sorted.length - 1];
  const stretched = new Float32Array(skills.length);
  for (let i = 0; i < skills.length; i++) {
    const r = out[i];
    const norm = rawMax > rawMin ? (r - rawMin) / (rawMax - rawMin) : 0.5;
    let v = 1 + norm * 16; // 1..17
    const src = skills[i].sources;
    if (!src.includes("opensalt")) v += 3; // workplace sources push to 4..20
    stretched[i] = v;
  }

  // Final quantile bin over stretched scores
  const stSorted = [...stretched].sort((a, b) => a - b);
  const bands = Array.from({ length: 19 }, (_, i) => stSorted[Math.floor(stSorted.length * (i + 1) / 20)]);
  const toBand = (x: number) => {
    for (let b = 0; b < 19; b++) if (x <= bands[b]) return b + 1;
    return 20;
  };
  const band = new Int32Array(skills.length);
  const bandCounts = new Array(20).fill(0);
  for (let i = 0; i < skills.length; i++) {
    band[i] = toBand(stretched[i]);
    bandCounts[band[i] - 1]++;
  }

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

// ---------- dispatch ----------

const stages: Record<string, () => void | Promise<void>> = {
  list: stage1List,
  infill: stage1bInfill,
  embed: stage2Embed,
  tag: stage3Tag,
  difficulty: stage4Difficulty,
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
