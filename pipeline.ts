#!/usr/bin/env -S deno run --allow-all
// Skill-tree pipeline. Monolithic Deno script. Ollama-only.
// Usage: deno run --allow-all pipeline.ts [stage]
// Stages: list, enrich, trees, seed-edges, embed, tag, dedupe, difficulty, prereq, postproc, finalize.

import { TextLineStream } from "jsr:@std/streams@1/text-line-stream";

const BUILD = "build";
await Deno.mkdir(BUILD, { recursive: true });

type Skill = { id: string; title: string; description: string; sources: string[]; tags: string[] };

// ---------- util ----------

const NAMED_ENTITY: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', sbquo: ",", bdquo: '"',
  ndash: "-", mdash: "-", hellip: "…", middot: "·", bull: "•",
  acirc: "â", aacute: "á", agrave: "à", auml: "ä", atilde: "ã", aring: "å", aelig: "æ",
  ecirc: "ê", eacute: "é", egrave: "è", euml: "ë",
  icirc: "î", iacute: "í", igrave: "ì", iuml: "ï",
  ocirc: "ô", oacute: "ó", ograve: "ò", ouml: "ö", otilde: "õ", oslash: "ø",
  ucirc: "û", uacute: "ú", ugrave: "ù", uuml: "ü",
  ccedil: "ç", ntilde: "ñ", szlig: "ß", yacute: "ý", yuml: "ÿ",
  Acirc: "Â", Aacute: "Á", Agrave: "À", Auml: "Ä", Atilde: "Ã", Aring: "Å", AElig: "Æ",
  Ecirc: "Ê", Eacute: "É", Egrave: "È", Euml: "Ë",
  Icirc: "Î", Iacute: "Í", Igrave: "Ì", Iuml: "Ï",
  Ocirc: "Ô", Oacute: "Ó", Ograve: "Ò", Ouml: "Ö", Otilde: "Õ", Oslash: "Ø",
  Ucirc: "Û", Uacute: "Ú", Ugrave: "Ù", Uuml: "Ü",
  Ccedil: "Ç", Ntilde: "Ñ", Yacute: "Ý",
  copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±", times: "×", divide: "÷",
};
const decodeEntities = (s: string) => s
  .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITY[name] ?? m)
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

const normalizeText = (s: string): string => {
  if (!s) return "";
  let t = decodeEntities(s);
  t = t.replace(/<\/?[a-z][^>]*>/gi, "");
  t = t.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  t = t.replace(/[\u2010\u2011\u2012\u2013\u2014]/g, "-");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/Â\s*/g, " ");
  t = t.replace(/â€[\u0090-\u009F\u200B-\u200F]*/g, "");
  t = t.replace(/Ã[\u0080-\u00BF]/g, (m) => {
    try { return new TextDecoder().decode(new Uint8Array([...m].map((c) => c.charCodeAt(0)))); }
    catch { return m; }
  });
  t = t.replace(/\s+/g, " ").trim();
  return t;
};

const denoiseTitle = (s: string): string => {
  if (!s) return "";
  let t = s;
  t = t.replace(/\s*\((?:e\.g\.|i\.e\.)[^)]*\)/gi, "");
  t = t.replace(/\s*\([^)]{60,}\)/g, "");
  t = t.replace(/,?\s+such as\b[^.]*\.?$/i, ".");
  t = t.replace(/^(perform|conduct|provide|ensure|coordinate)\s+(the|an?|of)\s+/i, "$1 ");
  t = t.replace(/[\s:;\-–—]+$/g, "");
  t = t.replace(/^[•▪►■◆]\s*/, "");
  t = t.replace(/^\d+\.\s+/, "");
  t = t.replace(/\s+\([A-Z]\)$/g, "");
  t = t.replace(/\s+\(Supplemental\)$/gi, "");
  t = t.replace(/\.$/g, "");
  t = t.replace(/;?\s+and$/i, "");
  t = t.replace(/\$([^$]+)\$/g, "$1");
  t = t.replace(/\\bmod\b/g, "mod").replace(/\\small\b\s*/g, "");
  t = t.replace(/\s+/g, " ").trim();
  return t;
};

const sentenceCase = (s: string): string => {
  if (!s) return s;
  if (s[0] === s[0].toUpperCase() && s[0] !== s[0].toLowerCase()) return s;
  return s[0].toUpperCase() + s.slice(1);
};

const stripStudentPrefix = (s: string): string => {
  if (!s) return s;
  const t = s.replace(/^(the\s+)?students?\s+will\s+(be\s+able\s+to\s+)?/i, "")
           .replace(/^students?\s+can\s+/i, "")
           .replace(/^by\s+the\s+end\s+of[^,.]+,\s*/i, "")
           .replace(/^upon\s+completion[^,.]+,\s*/i, "")
           .replace(/^(tswbat|swbat)[:\s]+/i, "")
           .trim();
  if (!t) return s;
  return t[0].toUpperCase() + t.slice(1);
};

function h32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

const slugify = (s: string) => {
  const base = decodeEntities(s).toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  if (base.length <= 80) return base;
  const hash = h32(base).toString(16).padStart(8, "0").slice(0, 6);
  let out = "";
  for (const tok of base.split("-")) {
    if (out.length + 1 + tok.length + 7 > 80) break;
    out += (out ? "-" : "") + tok;
  }
  return out ? `${out}-${hash}` : base.slice(0, 73) + "-" + hash;
};

const parseTsv = (text: string, tag?: string): string[][] => {
  const rows = text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.length).map((l) => l.split("\t"));
  if (rows.length < 2) return rows;
  const expected = rows[0].length;
  let mismatched = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].length !== expected) {
      if (mismatched < 3) console.warn(`[parseTsv${tag ? ` ${tag}` : ""}] row ${i} has ${rows[i].length} cols, header has ${expected} — embedded newline/tab?`);
      mismatched++;
    }
  }
  if (mismatched > 0) console.warn(`[parseTsv${tag ? ` ${tag}` : ""}] ${mismatched}/${rows.length - 1} rows have mismatched column count`);
  return rows;
};

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

function writeStats(stage: string | number, stats: Record<string, unknown>) {
  const path = `${BUILD}/${stage}_stats.json`;
  Deno.writeTextFileSync(path, JSON.stringify(stats, null, 2));
  console.log(`[stage ${stage}] stats → ${path}`);
}

function loadTsvCache(...paths: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const path of paths) {
    try {
      for (const line of Deno.readTextFileSync(path).split("\n")) {
        if (!line) continue;
        const tab = line.indexOf("\t");
        if (tab < 0) continue;
        if (!m.has(line.slice(0, tab))) m.set(line.slice(0, tab), line.slice(tab + 1));
      }
    } catch { /* missing */ }
  }
  return m;
}

function appendTsvCache(path: string, entries: Record<string, string>) {
  const enc = new TextEncoder();
  const fh = Deno.openSync(path, { create: true, append: true });
  for (const [k, v] of Object.entries(entries))
    fh.writeSync(enc.encode(`${k}\t${v.replace(/[\t\n\r]/g, " ")}\n`));
  fh.close();
}

function forEachLine(path: string, fn: (line: string) => void) {
  try {
    for (const l of Deno.readTextFileSync(path).split("\n")) if (l) fn(l);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) console.warn(`[forEachLine] WARN: ${path} — ${(e as Error).message}`);
  }
}

async function streamLines(cmd: string[], onLine: (line: string) => void) {
  const p = new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "piped", stderr: "null" }).spawn();
  const lines = p.stdout.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream());
  for await (const line of lines) onLine(line);
  await p.status;
}

async function sha256(s: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new Uint8Array(buf);
}

// ---------- ollama ----------

const OLLAMA = Deno.env.get("OLLAMA_HOST") ?? "http://localhost:11434";
const EMBED_MODEL = "nomic-embed-text";
const EMBED_DIM = 768;

// Pass 11 T1/T3: centralized junk-topic regexes.
// Applied in stage dedupe backfill (LCSH/DBpedia ancestors) AND stage finalize.
// Previously these existed only at finalize, letting junk leak through dedupe.
const FRAMEWORK_RE = /-standards|-20\d\d|^sced-|^content-khan|^ccss$|^ngss$|next-generation-science|k-5-mathematics|adult-basic-education|cte-standards|curriculum|course-codes|^skills$|^content$|^learning-stage-|\d{4}-\d{4}|\d{2}-\d{2}-updates|scope-and-sequence|-sy\d{4}|-effective-starting|early-childhood-standards/;
const WIKI_CAT_RE = /-officials-and-employees$|-by-country$|-by-region$|-by-type$|-by-year$|-by-nationality$|-introduced-in-|-established-in-|-disestablished-in-|-founded-in-|-born-in-|-died-in-|-set-in-|^people-in-|-people$|-in-history$|^wikiproject-|-templates$|^years-in-|^decades-in-|^centuries-in-|-matches$|-aircraft$|-records$|-(judges|officials|employees|members|persons)$/;
const YEAR_RE = /(^|-)(19|20)\d\d(-|$)|^\d+$/;
const isJunkTopic = (t: string): boolean => FRAMEWORK_RE.test(t) || WIKI_CAT_RE.test(t) || YEAR_RE.test(t);

const GEN_MODEL = Deno.env.get("OLLAMA_GEN_MODEL") ?? "gpt-oss:20b";
const CACHE_PATH = `${BUILD}/2_cache.bin`;
const CACHE_RECORD_BYTES = 32 + EMBED_DIM * 4;

async function embedOne(content: string): Promise<Float32Array> {
  const res = await fetch(`${OLLAMA}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: content }),
  });
  if (!res.ok) throw new Error(`ollama embed ${res.status}: ${await res.text()}`);
  const j = await res.json();
  if (!j.embedding || j.embedding.length !== EMBED_DIM) {
    throw new Error(`bad embedding: length=${j.embedding?.length}`);
  }
  return new Float32Array(j.embedding);
}

async function generateOne(prompt: string, numPredict = 120): Promise<string> {
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    body: JSON.stringify({
      model: GEN_MODEL, prompt, stream: false,
      options: { temperature: 0.1, num_predict: numPredict },
    }),
  });
  if (!res.ok) throw new Error(`ollama gen ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return (j.response || "").replace(/[\t\n\r]/g, " ").trim();
}

const REFUSAL_RE = /(cannot|unable to|not familiar with|not (?:able|aware|sure)|do(?:n't| not) have|no (?:recognized |clear |standard )?(?:definition|meaning)|without (?:more |further |additional )?(?:context|information)|could you (?:provide|clarify|specify)|recognized definition|clear workplace skill)/i;

function cleanDef(raw: string): string {
  const trimmed = raw.trim()
    .replace(/^[\s"'*_-]+|[\s"'*_-]+$/g, "")
    .replace(/\s+/g, " ");
  if (!trimmed) return "";
  if (REFUSAL_RE.test(trimmed)) return "";
  if (/^skip$/i.test(trimmed)) return "";
  if (trimmed.length <= 400) return trimmed;
  const head = trimmed.slice(0, 400);
  const lastSent = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  if (lastSent > 200) return head.slice(0, lastSent + 1).trim();
  const lastSpace = head.lastIndexOf(" ");
  return (lastSpace > 200 ? head.slice(0, lastSpace) : head).trim() + "…";
}

async function resumableOllama<T extends { id: string }>(
  label: string,
  cachePath: string,
  targets: T[],
  promptFn: (t: T) => string,
  opts: { numPredict?: number; concurrency?: number; clean?: (raw: string) => string } = {},
): Promise<void> {
  const cache = new Set<string>();
  try {
    for (const line of Deno.readTextFileSync(cachePath).split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab > 0) cache.add(line.slice(0, tab));
    }
  } catch { /* fresh */ }
  const todo = targets.filter((t) => !cache.has(t.id));
  console.log(`[${label}] targets=${targets.length} cached=${cache.size} todo=${todo.length} → ${cachePath}`);
  if (!todo.length) return;

  const concurrency = Number(Deno.env.get("OLLAMA_CONCURRENCY") ?? opts.concurrency ?? 4);
  const limit = Deno.env.get("OLLAMA_LIMIT") ? Number(Deno.env.get("OLLAMA_LIMIT")) : todo.length;
  const queue = todo.slice(0, limit);
  const fh = Deno.openSync(cachePath, { create: true, append: true });
  const enc = new TextEncoder();
  const cleanFn = opts.clean ?? cleanDef;
  const t0 = performance.now();
  let done = 0, errs = 0;
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      if (!item) break;
      try {
        const raw = await generateOne(promptFn(item), opts.numPredict);
        const cleaned = cleanFn(raw);
        if (cleaned) fh.writeSync(enc.encode(`${item.id}\t${cleaned}\n`));
      } catch (e) {
        errs++;
        if (errs < 5) console.warn(`[${label}] err ${item.id}: ${(e as Error).message.slice(0, 80)}`);
      }
      done++;
      if (done % 200 === 0) {
        const dt = (performance.now() - t0) / 1000;
        const rate = done / dt;
        console.log(`  ${done}/${queue.length + done} (${rate.toFixed(1)}/s, eta ${(queue.length / rate / 60).toFixed(1)}min, errs=${errs})`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  fh.close();
  console.log(`[${label}] done ${done} (errs=${errs}) in ${((performance.now() - t0) / 1000).toFixed(0)}s`);
}

function taggedTsvPath(): string {
  try { Deno.statSync(`${BUILD}/3b_tagged_deduped.tsv`); return `${BUILD}/3b_tagged_deduped.tsv`; } catch { return `${BUILD}/3_tagged.tsv`; }
}

// Pass 10 S3-5: transitive alias collapse — follow chains to terminal canonical.
// Stage 3b may re-merge an already-canonical target, leaving stale pointers.
function loadAliasesCollapsed(): Map<string, string> {
  const raw = new Map<string, string>();
  try {
    const aLines = Deno.readTextFileSync(`${BUILD}/3b_aliases.tsv`).split("\n").filter((l) => l.length);
    for (let i = 1; i < aLines.length; i++) {
      const [d, c] = aLines[i].split("\t");
      if (d && c) raw.set(d, c);
    }
  } catch { return raw; }
  const collapsed = new Map<string, string>();
  for (const [d] of raw) {
    let cur = d;
    const seen = new Set<string>([cur]);
    for (let hops = 0; hops < 64; hops++) {
      const next = raw.get(cur);
      if (!next || seen.has(next)) break;
      seen.add(next);
      cur = next;
    }
    if (cur !== d) collapsed.set(d, cur);
  }
  return collapsed;
}

function loadEmbCache(): Map<string, Float32Array> {
  const cache = new Map<string, Float32Array>();
  let data: Uint8Array;
  try { data = Deno.readFileSync(CACHE_PATH); } catch { return cache; }
  if (data.byteLength % CACHE_RECORD_BYTES !== 0) {
    throw new Error(`cache ${CACHE_PATH} size ${data.byteLength} not multiple of ${CACHE_RECORD_BYTES}; delete to rebuild`);
  }
  const n = data.byteLength / CACHE_RECORD_BYTES;
  for (let i = 0; i < n; i++) {
    const off = i * CACHE_RECORD_BYTES;
    const hash = Array.from(data.slice(off, off + 32)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const vec = new Float32Array(data.buffer.slice(data.byteOffset + off + 32, data.byteOffset + off + CACHE_RECORD_BYTES));
    cache.set(hash, vec);
  }
  return cache;
}

function appendEmbCache(fh: Deno.FsFile, hashBytes: Uint8Array, vec: Float32Array) {
  const rec = new Uint8Array(CACHE_RECORD_BYTES);
  rec.set(hashBytes, 0);
  rec.set(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength), 32);
  fh.writeSync(rec);
}

async function embedBatch(contents: string[], label: string): Promise<Float32Array[]> {
  const cache = loadEmbCache();
  const fh = Deno.openSync(CACHE_PATH, { create: true, append: true });
  const hashes = await Promise.all(contents.map((c) => sha256(c)));
  const hashHex = hashes.map((h) => Array.from(h).map((b) => b.toString(16).padStart(2, "0")).join(""));
  const missing: number[] = [];
  for (let i = 0; i < contents.length; i++) if (!cache.has(hashHex[i])) missing.push(i);
  console.log(`[${label}] embedding ${contents.length} (${missing.length} new)`);
  const concurrency = Number(Deno.env.get("EMBED_CONCURRENCY") ?? "8");
  let done = 0;
  const t0 = performance.now();
  const queue = [...missing];
  async function worker() {
    while (queue.length) {
      const i = queue.shift()!;
      const vec = await embedOne(contents[i]);
      cache.set(hashHex[i], vec);
      appendEmbCache(fh, hashes[i], vec);
      done++;
      if (done % 500 === 0) {
        const el = (performance.now() - t0) / 1000;
        console.log(`  ${done}/${missing.length} (${(done / el).toFixed(1)}/s)`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  fh.close();
  return contents.map((_, i) => cache.get(hashHex[i])!);
}

function normalize(v: Float32Array): Float32Array {
  let sq = 0;
  for (let i = 0; i < v.length; i++) sq += v[i] * v[i];
  const inv = 1 / Math.sqrt(sq || 1);
  const r = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) r[i] = v[i] * inv;
  return r;
}

function loadRawEmbeddings(): { ids: string[]; emb: Float32Array; idToEmbIdx: Map<string, number> } {
  const ids = Deno.readTextFileSync(`${BUILD}/2_ids.tsv`).split("\n").filter((l) => l.length);
  const bin = Deno.readFileSync(`${BUILD}/2_embeddings.bin`);
  const emb = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
  const idToEmbIdx = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) idToEmbIdx.set(ids[i], i);
  return { ids, emb, idToEmbIdx };
}

function normalizedEmbeddingsForSkills(skillIds: string[]): Float32Array {
  const { emb, idToEmbIdx } = loadRawEmbeddings();
  const vecs = new Float32Array(skillIds.length * EMBED_DIM);
  for (let i = 0; i < skillIds.length; i++) {
    const ei = idToEmbIdx.get(skillIds[i]);
    if (ei === undefined) throw new Error(`no embedding for ${skillIds[i]}`);
    vecs.set(normalize(emb.subarray(ei * EMBED_DIM, (ei + 1) * EMBED_DIM)), i * EMBED_DIM);
  }
  return vecs;
}

// ---------- stage list ----------

const INFILL_CACHE = `${BUILD}/1b_infill.tsv`;
const SUMMARIZE_CACHE = `${BUILD}/1c_summarize.tsv`;
const ONET_DESC_CACHE = `${BUILD}/1d_onet_desc.tsv`;
const OPENSALT_DESC_CACHE_PATH = `${BUILD}/1e_opensalt_desc.tsv`;

const SHORT_TECH_WHITELIST = new Set([
  "r", "go", "c#", "c++", "ada", "apl", "awk", "css", "db2", "git", "ios", "jet",
  "lua", "mdx", "mmx", "php", "qml", "sql", "tcl", "xml", "yml", "vim", "tex", "rsa",
]);

function stageList() {
  console.log("[list] reading sources…");
  const infill = loadTsvCache(INFILL_CACHE);
  const summarize = loadTsvCache(SUMMARIZE_CACHE);
  const onetDesc = loadTsvCache(ONET_DESC_CACHE);
  const opensaltDesc = loadTsvCache(OPENSALT_DESC_CACHE_PATH);
  console.log(`[list] caches: infill=${infill.size} summarize=${summarize.size} onet_desc=${onetDesc.size} opensalt_desc=${opensaltDesc.size}`);
  const raw: Skill[] = [];

  // ESCO
  {
    const rows = parseCsv(Deno.readTextFileSync("data/esco/skills_en.csv"));
    const h = rows[0];
    const iLabel = h.indexOf("preferredLabel"), iDesc = h.indexOf("description"),
          iDef = h.indexOf("definition"), iType = h.indexOf("skillType");
    let n = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r[iLabel]) continue;
      raw.push({
        id: "", title: sentenceCase(r[iLabel].trim()), description: (r[iDesc] || r[iDef] || "").trim(),
        sources: ["esco"], tags: r[iType] ? [`esco:${r[iType]}`] : ["esco"],
      });
      n++;
    }
    console.log(`  esco: ${n}`);
  }

  // O*NET Skills/Knowledge/Abilities
  {
    const cmrRows = parseTsv(Deno.readTextFileSync("data/onet/Content Model Reference.txt"));
    const ch = cmrRows[0];
    const ci = ch.indexOf("Element ID"), cn = ch.indexOf("Element Name"), cd = ch.indexOf("Description");
    const cmr = new Map<string, { name: string; desc: string }>();
    for (let i = 1; i < cmrRows.length; i++) {
      const r = cmrRows[i];
      cmr.set(r[ci], { name: r[cn], desc: r[cd] || "" });
    }
    for (const { path, tag } of [
      { path: "data/onet/Skills.txt", tag: "onet:skill" },
      { path: "data/onet/Knowledge.txt", tag: "onet:knowledge" },
      { path: "data/onet/Abilities.txt", tag: "onet:ability" },
    ]) {
      const rows = parseTsv(Deno.readTextFileSync(path));
      const idI = rows[0].indexOf("Element ID");
      const seen = new Set<string>();
      let n = 0;
      for (let i = 1; i < rows.length; i++) {
        const eid = rows[i][idI];
        if (!eid || seen.has(eid)) continue;
        seen.add(eid);
        const m = cmr.get(eid);
        if (!m) throw new Error(`ONET element ${eid} missing from CMR`);
        raw.push({ id: "", title: m.name.trim(), description: m.desc.trim(), sources: ["onet"], tags: [tag] });
        n++;
      }
      console.log(`  ${path}: ${n}`);
    }
  }

  // O*NET Tasks
  {
    const rows = parseTsv(Deno.readTextFileSync("data/onet/Task Statements.txt"));
    const h = rows[0];
    const iTask = h.indexOf("Task"), iType = h.indexOf("Task Type");
    const seen = new Set<string>();
    let n = 0, dup = 0, naDropped = 0;
    for (let i = 1; i < rows.length; i++) {
      const task = rows[i][iTask]?.trim();
      if (!task) continue;
      const taskType = rows[i][iType]?.trim() || "";
      if (!taskType) { naDropped++; continue; }
      const key = task.toLowerCase();
      if (seen.has(key)) { dup++; continue; }
      seen.add(key);
      raw.push({ id: "", title: task, description: "", sources: ["onet"], tags: ["onet:task", `onet:${taskType.toLowerCase()}`] });
      n++;
    }
    console.log(`  onet tasks: ${n} (dup=${dup}, n/a=${naDropped})`);
  }

  // O*NET DWAs
  {
    const rows = parseTsv(Deno.readTextFileSync("data/onet/DWA Reference.txt"));
    const iTitle = rows[0].indexOf("DWA Title");
    const seen = new Set<string>();
    let n = 0;
    for (let i = 1; i < rows.length; i++) {
      const title = rows[i][iTitle]?.trim();
      if (!title) continue;
      const k = title.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      raw.push({ id: "", title, description: "", sources: ["onet"], tags: ["onet:dwa"] });
      n++;
    }
    console.log(`  onet dwas: ${n}`);
  }

  // O*NET Tech
  {
    const TECH_MODE = Deno.env.get("ONET_TECH_MODE") ?? "hot";
    const BRAND_RE = /^[!\d]|\b(Inc|LLC|Corp|Corporation|Ltd|GmbH|Co\.)\b|\bSoftware\s+\d/;
    const rows = parseTsv(Deno.readTextFileSync("data/onet/Technology Skills.txt"));
    const h = rows[0];
    const iEx = h.indexOf("Example"), iCat = h.indexOf("Commodity Title"), iHot = h.indexOf("Hot Technology");
    const seen = new Map<string, { orig: string; desc: string; hot: boolean }>();
    for (let i = 1; i < rows.length; i++) {
      const ex = rows[i][iEx]?.trim();
      if (!ex) continue;
      const cat = rows[i][iCat]?.trim() || "";
      const hot = rows[i][iHot] === "Y";
      const key = ex.toLowerCase();
      const prev = seen.get(key);
      if (!prev || (hot && !prev.hot)) seen.set(key, { orig: ex, desc: cat, hot });
    }
    let n = 0, modeDropped = 0, brandDropped = 0;
    for (const { orig, desc, hot } of seen.values()) {
      if (TECH_MODE === "hot" && !hot) { modeDropped++; continue; }
      if (BRAND_RE.test(orig)) { brandDropped++; continue; }
      raw.push({
        id: "", title: orig, description: desc ? `${orig} — ${desc}` : "",
        sources: ["onet"],
        // Pass 12 TG5: drop onet:hot (redundant with onet:tech:* subtypes)
        tags: ["onet:tech", ...(desc ? [`onet:tech:${slugify(desc)}`] : [])],
      });
      n++;
    }
    console.log(`  onet tech: ${n} (mode=${TECH_MODE}, mode_dropped=${modeDropped}, brand_dropped=${brandDropped})`);
  }

  // Lightcast
  {
    const j = JSON.parse(Deno.readTextFileSync("data/lightcast/skills.json"));
    let n = 0, infilled = 0, placeholdered = 0, certsDropped = 0;
    const missingIds: string[] = [];
    const certs: { id: string; title: string; type: string; category: string }[] = [];
    for (const s of j.data) {
      if (!s.name) continue;
      const title = s.name.trim();
      const id = slugify(title);
      const typeName = s.type?.name ?? "";
      const category = s.category?.name ?? s.subcategory?.name ?? "";
      if (typeName === "Certification") {
        certs.push({ id, title, type: typeName, category });
        certsDropped++;
        continue;
      }
      let desc = infill.get(id) ?? "";
      const tags = typeName ? [`lightcast:${typeName}`] : ["lightcast"];
      if (desc && desc.trim() !== typeName) infilled++;
      else {
        desc = "";
        if (category) { desc = `${title} — ${category}`; placeholdered++; }
        tags.push("desc:placeholder");
        missingIds.push(id);
      }
      raw.push({ id: "", title, description: desc, sources: ["lightcast"], tags });
      n++;
    }
    Deno.writeTextFileSync(`${BUILD}/1_lightcast_missing.tsv`, missingIds.join("\n") + "\n");
    if (certs.length) {
      const lines = ["id\ttitle\ttype\tcategory",
        ...certs.map((c) => `${c.id}\t${c.title}\t${c.type}\t${c.category}`)];
      Deno.writeTextFileSync(`${BUILD}/1_certifications.tsv`, lines.join("\n") + "\n");
    }
    console.log(`  lightcast: ${n} (infilled=${infilled}, placeholder=${placeholdered}, certs=${certsDropped})`);
  }

  // Pass 16 MF1: synthesized foundations. These hub concepts (addition, fractions,
  // python, loops, area, …) are often missing as atomic skills — OpenSALT fragments
  // them into 284+ grade-specific variants, leaving no convergence point. Seed them
  // as first-class skills with curated descriptions.
  {
    try {
      const f = JSON.parse(Deno.readTextFileSync("data/_foundations.json"));
      let n = 0;
      for (const fd of f.foundations || []) {
        if (!fd.id || !fd.title) continue;
        const tags = ["foundation", `foundation:${fd.id}`];
        if (Number.isFinite(fd.grade_start)) tags.push(`grade:${fd.grade_start === 0 ? "K" : fd.grade_start === -1 ? "PK" : String(fd.grade_start)}`);
        if (Number.isFinite(fd.grade_end) && fd.grade_end !== fd.grade_start) tags.push(`grade:${fd.grade_end === 0 ? "K" : fd.grade_end === -1 ? "PK" : String(fd.grade_end)}`);
        raw.push({ id: "", title: fd.title, description: fd.description || "", sources: ["foundation"], tags });
        n++;
      }
      console.log(`  foundations: ${n}`);
    } catch (e) { console.warn(`[list] foundations skipped: ${(e as Error).message}`); }
  }

  // OpenSALT CFItems
  {
    const SCAFFOLDING_TYPES = new Set([
      "Grade Level","Domain","Strand","Course","Topic","Cluster",
      "Component","Section","Module","Chapter","Unit",
      // Pass 15 OT1 extension — non-learnable framework scaffolding nodes
      "Sub-Domain","Category","Connection","Grade","Grade Band","Quarter",
      "Section Heading","Pathway","Subject","Dimension","Cognitive Complexity",
      "Performance Level","Assignment","Lesson","Job Role","Employee",
      "Team Leader","People Leader","Senior Leader",
    ]);
    const SCAFFOLDING_RE = /^(\s*)?(grade|kindergarten|pre-?k|elementary|middle school|high school|[0-9]+(st|nd|rd|th)\s+grade|unit\s+\d|chapter\s+\d|section\s+\d|module\s+\d|standard\s+\d|topic\s+\d|strand|domain)\b/i;
    const SCAFFOLDING_SIMPLE_RE = new RegExp([
      /^DEPRECATED\b/,
      /^(?:Use the (?:clock|timer)|Click the|Press the|Drag the|Open the app)/,
      /^(?:Constructed Response|Hook Activity|Background Information|Vocabulary Activity|Document Analysis)\s*:/,
      /^(?:Sample Problem|Example)\s*:/,
      /^Particular Topics in /,
      /^(?:CFItemType|Course|Subject)\s*:/,
      /\?\s*(?:Hook Activity|Background Information|Vocabulary Activity|Document Analysis|Writing)$/,
      /\s+(?:Hook Activity|Writing Activity|Vocabulary Activity|Assessment Activity)$/,
      // Pass 15 EC1: metadata-prefix titles
      /^(?:Unit|Lesson|Chapter|Benchmark|Standard)\s+[\d.]*/,
      // Pass 9 R5: scaffolding/student-directive prefixes
      /^with\s+(?:prompting|guidance|support)\b/,
      /^by\s+(?:date|the\s+end\s+of)\b/,
      /^(?:train|instruct|teach)\s+\w+s?\s+to\b/,
    ].map((r) => r.source).join("|"), "i");
    // Pass 15 OS1/OS2/OS3/OS5: framework-level drops
    const FRAMEWORK_BLOCKLIST = new Set([
      "pcg-georgia-s-k-12-mathematics-standards-implementation-sy2023-2024-2",
      "florida-math-scope-and-sequence",
      "florida-science-scope-and-sequence-grade-3",
      "florida-social-studies-scope-and-sequence",
      "al-ela-alabama-ela-test",
      "al-mth-alabama-math-test",
      "al-sc-alabama-science-test",
      "al-ss-alabama-social-studies-test",
      "normalized-data-schema",
      "scope-and-sequence-framework-template",
      "norm-webb-s-depth-of-knowledge-dok-levels-of-cognitive-difficulty",
      "florida-ela-standards-best-3rd-grade",
      "florida-ela-standards-lafs-3rd-grade",
      "florida-science-standards-grade-3",
      "florida-social-studies-standards-grade-3",
      "gcps-aks-language-arts-2021-2022",
      "gcps-aks-mathematics-2022-2023",
      "indiana-academic-standards-for-mathematics-2020",
      "mathematics-b-e-s-t",
    ]);
    // Pass 12 TG1: CASE educationLevel uses "KG" (and rare "TK"); difficulty stage expects "K".
    const normGrade = (g: string): string => {
      const u = g.trim().toUpperCase();
      if (u === "KG" || u === "TK") return "K";
      if (u === "PR" || u === "PRE-K" || u === "PRE-KINDERGARTEN") return "PK";
      return u;
    };
    const truncTitle = (t: string, cap: number): string => {
      if (t.length <= cap) return t;
      const head = t.slice(0, cap);
      const lastDot = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
      if (lastDot > cap * 0.5) return head.slice(0, lastDot + 1).trim();
      const lastSpace = head.lastIndexOf(" ");
      return (lastSpace > cap * 0.5 ? head.slice(0, lastSpace) : head).trim() + "…";
    };
    let n = 0, scaffType = 0, scaffPat = 0, truncated = 0, perFrameDup = 0, stuPrefix = 0, pureVerb = 0, frameDropped = 0;
    for (const e of Deno.readDirSync("data/opensalt")) {
      if (!e.name.endsWith(".json") || e.name === "index.json") continue;
      const j = JSON.parse(Deno.readTextFileSync(`data/opensalt/${e.name}`));
      const items = j.CFItems || [];
      const docSlug = slugify(j.CFDocument?.title || "opensalt");
      if (FRAMEWORK_BLOCKLIST.has(docSlug)) { frameDropped += items.length; continue; }
      const isSced = docSlug.startsWith("sced-");
      const seenInFrame = new Set<string>();
      for (const it of items) {
        if (it.CFItemType && SCAFFOLDING_TYPES.has(it.CFItemType)) { scaffType++; continue; }
        const fullStmt = (it.fullStatement || "").trim();
        const abbrev = (it.abbreviatedStatement || "").trim();
        const notes = (it.notes || "").trim();
        if (!fullStmt && !abbrev) { scaffPat++; continue; }
        const CODE_RE = /^[A-Z0-9\u2013\u2014–-][\w.\u2013\u2014–-]*$/;
        let title: string, description: string;
        if (abbrev && (!fullStmt || abbrev.length < fullStmt.length) && !(abbrev.length <= 20 && CODE_RE.test(abbrev))) {
          title = abbrev;
          description = fullStmt && fullStmt !== abbrev ? fullStmt : notes;
        } else {
          title = fullStmt;
          description = notes && notes !== fullStmt ? notes : "";
        }
        title = title.replace(/^[•▪►■◆]\s*/, "").replace(/^\d+\.\s+/, "");
        const before = title;
        title = stripStudentPrefix(title);
        // Pass 15 EC2: strip question/command prefixes
        title = title.replace(/^(Can|Could|Should|How to|What is|Why does)\s+/i, (_m, _g, _off, _s) => "");
        if (title && title[0] === title[0].toLowerCase()) title = title[0].toUpperCase() + title.slice(1);
        if (title !== before) stuPrefix++;
        title = title.replace(/^(Benchmark|Standard|Indicator)\s+[\d.]+\s*:\s*/i, "").trim();
        if (title.length > 300) { title = truncTitle(title, 300); truncated++; }
        if (title.length <= 2 || (title.length <= 20 && CODE_RE.test(title))) { scaffPat++; continue; }
        if (SCAFFOLDING_SIMPLE_RE.test(title)) { scaffPat++; continue; }
        if (/^(Essential|Proficient|Advanced|Intermediate|Beginning|Emerging|Developing|Extending|Exceeding|Level)\s+[IVX0-9]+/i.test(title) && title.length < 30) { scaffPat++; continue; }
        if (/^You\s+[a-z]/i.test(title) && title.length > 20) { scaffPat++; continue; }
        // Pass 9 R7: extend single-token drop from <20 to <30 (kills bare acronyms like "WCAG", "GPS", "IoT", "HMI")
        if (!/\s/.test(title) && title.length < 30) { scaffPat++; continue; }
        if (SCAFFOLDING_RE.test(title) && title.length < 50 && !it.CFItemType) { scaffPat++; continue; }
        if (/^(understand|recognize|demonstrate|apply|identify|know|explain|describe)\s+(the|how|that|what|why|when|where|a|an)\s/i.test(title)
            && title.length < 60 && !it.CFItemType) { pureVerb++; continue; }
        // Pass 12 DESC3: strip pedagogical filler prefixes from description
        description = description.replace(/^(Students?\s+(will|demonstrate)|The student|This unit|Module \d+|The course|Courses)\s[^.]*?\.\s+/i, "");
        const localKey = title.toLowerCase();
        if (seenInFrame.has(localKey)) { perFrameDup++; continue; }
        seenInFrame.add(localKey);

        // Pass 12 TG3: drop framework:* tag (no downstream consumer; noise). Keep source marker.
        // Pass 9 R1: tag SCED catalog entries so stage prereq can exclude them from candidate pools.
        const tags: string[] = ["opensalt"];
        if (isSced) tags.push("sced:catalog");
        if (Array.isArray(it.educationLevel)) {
          for (const g of it.educationLevel) {
            const gv = normGrade(String(g));  // Pass 12 TG1: KG→K etc.
            if (gv) tags.push(`grade:${gv}`);
          }
        }
        if (Array.isArray(it.conceptKeywords)) {
          for (const kw of it.conceptKeywords) {
            const kwSlug = slugify(String(kw));
            if (kwSlug) tags.push(`topic:${kwSlug}`);
          }
        }
        // Pass 12 TG2: only emit code:* when it actually encodes a framework code
        // (≥4 chars AND contains uppercase/dot). Blocks single-letter humanCodingScheme
        // sub-item labels that were corrupting deriveDisplay() fallback.
        if (it.humanCodingScheme) {
          const code = String(it.humanCodingScheme).trim().replace(/^Khan\s+/i, "");
          if (code.length >= 4 && (/[A-Z]/.test(code) || /\./.test(code))) tags.push(`code:${code}`);
        }
        if (it.CFItemType) tags.push(`opensalt:${slugify(it.CFItemType)}`);

        raw.push({ id: "", title, description, sources: ["opensalt"], tags });
        n++;
      }
    }
    console.log(`  opensalt: ${n} (scaff_type=${scaffType}, scaff_pat=${scaffPat}, pure_verb=${pureVerb}, stu_prefix=${stuPrefix}, trunc=${truncated}, dup=${perFrameDup}, framework_dropped=${frameDropped})`);
  }

  // Normalize + denoise
  let normalized = 0, denoised = 0;
  for (const s of raw) {
    const t0 = s.title, d0 = s.description;
    s.title = normalizeText(s.title);
    s.description = normalizeText(s.description);
    if (/^The SCED provides a series of unused codes/i.test(s.description)) s.description = "";
    if (/We took this down/i.test(s.description)) s.description = "";
    if (/^\*\*(See |Standards (related|that))/i.test(s.description)) s.description = "";
    if (/^(\*\*)?Big Idea:/i.test(s.description)) s.description = "";
    if (/^Modeling is best interpreted not as a collection/i.test(s.description)) s.description = "";
    if (/On the state assessment, items measuring/i.test(s.description)) s.description = "";
    if (/^Students need not use formal/i.test(s.description)) s.description = "";
    if (/^Examples may include but are not limited/i.test(s.description)) s.description = "";
    if (/^\d\.$/.test(s.description)) s.description = "";
    s.description = s.description.replace(/^(Progression|Clarification|Note|Sample|Sample Problem)\s*:\s*/i, "");
    s.title = s.title.replace(/\s*:$/g, "");
    if (s.title !== t0 || s.description !== d0) normalized++;
    const before = s.title;
    const after = denoiseTitle(before);
    if (after && after !== before) {
      denoised++;
      if (!s.description && (before.length - after.length) / before.length > 0.3) s.description = before;
      s.title = after;
    }
  }
  console.log(`[list] normalized=${normalized}, denoised=${denoised}`);

  // Apply summarize + onet-desc + opensalt-desc caches
  let summarized = 0, onetEnriched = 0, opensaltEnriched = 0;
  for (const s of raw) {
    const k = slugify(s.title);
    const sum = summarize.get(k);
    if (sum && sum.length > 0 && sum.length < s.title.length) {
      const orig = s.title;
      s.title = sum;
      if (!s.description) s.description = orig;
      summarized++;
    }
    if (!s.description && s.sources.includes("onet")) {
      const d = onetDesc.get(k);
      if (d) { s.description = d; onetEnriched++; }
    }
    if (!s.description && s.sources.includes("opensalt")) {
      const d = opensaltDesc.get(k);
      if (d) { s.description = d; opensaltEnriched++; }
    }
  }
  console.log(`[list] applied ${summarized} summaries, ${onetEnriched} onet descs, ${opensaltEnriched} opensalt descs`);

  // Long-title drop: anything that would overflow an 80-char slug and
  // require a hex-suffix hash is a compliance statement, not a skill.
  let longTitleDropped = 0, slugOverflowDropped = 0;
  const survivors: Skill[] = [];
  for (const s of raw) {
    if (/^DEPRECATED\b/i.test(s.title)) { longTitleDropped++; continue; }
    const fromOpensalt = s.sources.includes("opensalt");
    const fromOnetTask = s.tags.some((t) => t === "onet:task");
    const wc = s.title.split(/\s+/).filter(Boolean).length;
    if ((fromOpensalt || fromOnetTask) && (wc > 12 || s.title.length > 100)) {
      longTitleDropped++;
      continue;
    }
    if (fromOpensalt) {
      const slugBase = decodeEntities(s.title).toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ").trim().replace(/\s+/g, "-").replace(/-+/g, "-");
      if (slugBase.length > 80) {
        // Still overflows post-summarize: summarization didn't fire or didn't help.
        slugOverflowDropped++;
        continue;
      }
    }
    survivors.push(s);
  }
  raw.length = 0;
  raw.push(...survivors);
  console.log(`[list] long_title_dropped=${longTitleDropped}, slug_overflow=${slugOverflowDropped}`);

  // Fuzzy dedupe
  const fuzzyKey = (s: string): string =>
    s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  const TAG_CAP = 20;
  const byKey = new Map<string, Skill>();
  let collisions = 0, emptyKey = 0, emptySlug = 0;
  for (const s of raw) {
    const k = fuzzyKey(s.title);
    if (!k) { emptyKey++; continue; }
    const existing = byKey.get(k);
    if (existing) {
      collisions++;
      for (const src of s.sources) if (!existing.sources.includes(src)) existing.sources.push(src);
      for (const t of s.tags) {
        if (existing.tags.length >= TAG_CAP) break;
        if (!existing.tags.includes(t)) existing.tags.push(t);
      }
      if (s.description && s.description.length > existing.description.length) existing.description = s.description;
    } else {
      const slug = slugify(s.title);
      if (!slug) { emptySlug++; continue; }
      byKey.set(k, { ...s, id: slug });
    }
  }
  if (emptyKey + emptySlug > raw.length * 0.01) {
    throw new Error(`list: too many drops (empty_key=${emptyKey}, empty_slug=${emptySlug})`);
  }

  // Resolve slug collisions
  const bySlug = new Map<string, Skill[]>();
  for (const s of byKey.values()) {
    const arr = bySlug.get(s.id) ?? [];
    arr.push(s);
    bySlug.set(s.id, arr);
  }
  let slugCollisions = 0;
  for (const arr of bySlug.values()) {
    if (arr.length === 1) continue;
    slugCollisions += arr.length - 1;
    arr.forEach((s, i) => { if (i > 0) s.id = `${s.id}-${i + 1}`; });
  }

  const out = [...byKey.values()];
  const clean = (c: string) => c
    .replace(/[\u0000-\u001f\u200b-\u200f\ufeff]/g, "")
    .replace(/[\t\n\r]/g, " ").replace(/\s+/g, " ").trim();
  const tsv = ["id\ttitle\tdescription\tsources\ttags"];
  for (const s of out) {
    if (!s.id) throw new Error(`empty id: ${s.title}`);
    tsv.push([s.id, clean(s.title), clean(s.description), s.sources.join(","), s.tags.join(",")].join("\t"));
  }
  Deno.writeTextFileSync(`${BUILD}/1_skills.tsv`, tsv.join("\n") + "\n");

  const titleLens = out.map((s) => s.title.length);
  writeStats(1, {
    total_rows: out.length,
    raw_rows: raw.length,
    dedupe_collisions: collisions,
    empty_key_drops: emptyKey,
    empty_slug_drops: emptySlug,
    slug_collisions: slugCollisions,
    per_source: {
      esco: out.filter((s) => s.sources.includes("esco")).length,
      onet: out.filter((s) => s.sources.includes("onet")).length,
      lightcast: out.filter((s) => s.sources.includes("lightcast")).length,
      opensalt: out.filter((s) => s.sources.includes("opensalt")).length,
    },
    title_len: { p50: pct(titleLens, 0.5), p95: pct(titleLens, 0.95), max: Math.max(...titleLens) },
    empty_description: out.filter((s) => !s.description).length,
  });

  if (out.length < 20000) throw new Error(`list: suspiciously few rows (${out.length})`);
}

// ---------- stage enrich: Ollama infill + summarize + onet-desc ----------

const OPENSALT_DESC_CACHE = `${BUILD}/1e_opensalt_desc.tsv`;

async function stageEnrich() {
  const lines = Deno.readTextFileSync(`${BUILD}/1_skills.tsv`).split("\n").filter((l) => l.length);
  const SUM_MAX = Number(Deno.env.get("SUMMARIZE_MAX_LEN") ?? "120");
  const infillTargets: { id: string; title: string }[] = [];
  const sumTargets: { id: string; title: string }[] = [];
  const onetTargets: { id: string; title: string }[] = [];
  const opensaltTargets: { id: string; title: string }[] = [];
  let opaqueSkipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    const [id, title, desc, sources, tags] = c;
    if (title.length > SUM_MAX) sumTargets.push({ id, title });
    if (sources.includes("lightcast") && (!desc || tags?.includes("desc:placeholder"))) {
      if (title.length <= 3 && !SHORT_TECH_WHITELIST.has(title.toLowerCase())) { opaqueSkipped++; }
      else infillTargets.push({ id, title });
    }
    if (sources === "onet" && !desc && title.length < 120) onetTargets.push({ id, title });
    // Pass 12 DESC1: route OpenSALT empty-desc skills through LLM infill too.
    if (sources === "opensalt" && !desc && title.length >= 8 && title.length <= 120) {
      opensaltTargets.push({ id, title });
    }
  }
  console.log(`[enrich] infill=${infillTargets.length} (opaque=${opaqueSkipped}), summarize=${sumTargets.length}, onet-desc=${onetTargets.length}, opensalt-desc=${opensaltTargets.length}`);

  // Pass 12 E2: prepend context for ambiguous names (protege→ontology editor, not mentorship).
  const LIGHTCAST_CONTEXT = "You are describing entries in a professional labor-market skills taxonomy (Lightcast). When a name is ambiguous between generic English and a specific technical tool/product/standard, assume the technical interpretation. Do not invent organization names, certifications, or statistics.";

  await resumableOllama("enrich:infill", INFILL_CACHE, infillTargets,
    // Pass 12 ENR1: tone drift — ban marketing voice.
    (t) => `${LIGHTCAST_CONTEXT}\n\nWrite a single factual sentence (≤100 chars) defining the skill without marketing language, jargon, or elaboration. Do not begin with the skill name. If unclear, output: SKIP\n\nSkill: ${t.title}\n\nDefinition:`,
    // Pass 12 ENR2: raise num_predict from 120 so ~200-char outputs no longer truncate mid-word.
    { numPredict: 200 });

  await resumableOllama("enrich:summarize", SUMMARIZE_CACHE, sumTargets,
    // Pass 12 ENR4: extract-only constraint — don't add/assume concepts.
    (t) => `Extract the core skill as a concise 3-7 word noun phrase. Extract only concepts present in the input; do not add or assume. Output only the phrase — no preamble, no quotes, no trailing period. Examples:\n"Use place value understanding to round multi-digit whole numbers." → Rounding multi-digit whole numbers\n"Draw triangles with given conditions." → Drawing triangles with given conditions\n\nStandard: ${t.title}\n\nName:`,
    { numPredict: 60 });

  await resumableOllama("enrich:onet-desc", ONET_DESC_CACHE, onetTargets,
    // Pass 12 ENR3: ban "This task involves" template; cap at one sentence, <150 chars.
    (t) => `Describe this workplace task in one sentence (<150 chars). Start with the action verb. Do not use "This task involves". No preamble, no quotation marks.\n\nTask: ${t.title}\n\nDescription:`,
    { numPredict: 120 });

  // Pass 12 DESC1: OpenSALT standards with empty descriptions — expand to a single factual sentence.
  await resumableOllama("enrich:opensalt-desc", OPENSALT_DESC_CACHE, opensaltTargets,
    (t) => `Describe this K-12 academic standard in one sentence (<150 chars) that a teacher would use to explain what a student learns. Start with a noun or verb. Do not use "Students will". No preamble, no quotation marks.\n\nStandard: ${t.title}\n\nDescription:`,
    { numPredict: 140 });
}

// ---------- stage trees: LCSH + DBpedia SKOS broader chains ----------

async function buildTree(label: string, cmd: string[], outPath: string, depth: number, junkRe?: RegExp) {
  console.log(`[trees] ${label}: streaming…`);
  const labels = new Map<string, string>();
  const parents = new Map<string, string[]>();
  const PREF = "skos/core#prefLabel";
  const BROADER = "skos/core#broader";
  const rxPref = /^<([^>]+)>\s+<[^>]+prefLabel>\s+"((?:[^"\\]|\\.)*)"(?:@en)?\s*\.$/;
  const rxBroader = /^<([^>]+)>\s+<[^>]+broader>\s+<([^>]+)>\s*\.$/;
  let n = 0;
  await streamLines(cmd, (line) => {
    n++;
    if (n % 2000000 === 0) console.log(`  ${label}: ${n} lines, ${labels.size} labels`);
    if (line.length < 50 || line[0] !== "<") return;
    if (line.includes(PREF)) {
      const m = rxPref.exec(line);
      if (m) {
        const lbl = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        if (lbl.length >= 2 && lbl.length <= 80 && !lbl.includes("--")) labels.set(m[1], lbl);
      }
    } else if (line.includes(BROADER)) {
      const m = rxBroader.exec(line);
      if (m) {
        const arr = parents.get(m[1]) ?? []; arr.push(m[2]); parents.set(m[1], arr);
      }
    }
  });
  console.log(`[trees] ${label}: ${labels.size} labels, ${parents.size} with parents`);

  const slugToAncestors = new Map<string, string[]>();
  for (const [uri, lbl] of labels) {
    if (junkRe && (junkRe.test(uri) || junkRe.test(lbl))) continue;
    const slug = slugify(lbl);
    if (!slug || slug.length > 80) continue;
    const seen = new Set<string>([uri]);
    const anc: string[] = [];
    let frontier = parents.get(uri) || [];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const p of frontier) {
        if (seen.has(p)) continue;
        seen.add(p);
        if (junkRe && junkRe.test(p)) continue;
        const pLbl = labels.get(p);
        if (pLbl && !(junkRe && junkRe.test(pLbl))) {
          const pSlug = slugify(pLbl);
          if (pSlug && pSlug !== slug && !anc.includes(pSlug)) anc.push(pSlug);
        }
        for (const pp of (parents.get(p) || [])) next.push(pp);
      }
      frontier = next;
    }
    if (anc.length) slugToAncestors.set(slug, anc.slice(0, 6));
  }
  const fh = Deno.openSync(outPath, { create: true, write: true, truncate: true });
  const enc = new TextEncoder();
  for (const [slug, anc] of slugToAncestors) fh.writeSync(enc.encode(`${slug}\t${anc.join(",")}\n`));
  fh.close();
  console.log(`[trees] ${label}: ${slugToAncestors.size} slugs → ${outPath}`);
  return slugToAncestors.size;
}

async function stageTrees() {
  const lcsh = await buildTree("lcsh",
    ["sh", "-c", "gunzip -c data/lcsh/subjects.skosrdf.nt.gz"],
    `${BUILD}/1j_lcsh_tree.tsv`, 4);
  const JUNK = /_by_country$|_by_region$|_by_type$|_by_year$|_introduced_in_|_established_in_|_disestablished_in_|_founded_in_|_born_in_|_died_in_|_set_in_|^Category:People_in_|_people$|_in_history$/i;
  const dbp = await buildTree("dbpedia",
    ["sh", "-c", "bzcat data/dbpedia/skos_categories_en.ttl.bz2"],
    `${BUILD}/1k_dbpedia_tree.tsv`, 3, JUNK);
  writeStats("trees", { lcsh_slugs: lcsh, dbpedia_slugs: dbp });
}

// ---------- stage seed-edges ----------

function loadSkillIndex(): { idSet: Set<string>; titleToId: Map<string, string>; slugToId: Map<string, string> } {
  const lines = Deno.readTextFileSync(taggedTsvPath()).split("\n").filter((l) => l.length);
  const idSet = new Set<string>();
  const titleToId = new Map<string, string>();
  const slugToId = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const [id, title] = lines[i].split("\t");
    if (!id) continue;
    idSet.add(id);
    const t = (title || "").toLowerCase().trim();
    if (t && !titleToId.has(t)) titleToId.set(t, id);
    slugToId.set(id, id);
    const altSlug = slugify(title || "");
    if (altSlug && !slugToId.has(altSlug)) slugToId.set(altSlug, id);
  }
  return { idSet, titleToId, slugToId };
}

function resolveConcept(
  raw: string,
  idx: { idSet: Set<string>; titleToId: Map<string, string>; slugToId: Map<string, string> },
): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/_/g, " ").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const lc = cleaned.toLowerCase();
  if (idx.titleToId.has(lc)) return idx.titleToId.get(lc)!;
  const slug = slugify(cleaned);
  if (idx.idSet.has(slug)) return slug;
  if (idx.slugToId.has(slug)) return idx.slugToId.get(slug)!;
  const rawSlug = slugify(raw.replace(/_/g, " "));
  if (idx.idSet.has(rawSlug)) return rawSlug;
  if (idx.slugToId.has(rawSlug)) return idx.slugToId.get(rawSlug)!;
  return null;
}

async function stageSeedEdges() {
  console.log("[seed-edges] collecting…");
  const idx = loadSkillIndex();
  console.log(`[seed-edges] index: ${idx.idSet.size} ids`);
  type RawPair = { rawSrc: string; rawDst: string; source: string; raw: string };
  const rawPairs: RawPair[] = [];
  const perSource: Record<string, { total: number; resolved: number; holdout: number; fallback: number }> = {};
  // Pass 10 S2-2/S2-3: normalize labels before emit.
  // AL-CPL uses "Basis_(linear_algebra)" format; Khan has parenthetical "(basic)" variants.
  const normalizeLabel = (lbl: string): string => {
    return lbl
      .replace(/_/g, " ")
      .replace(/\s*\([^)]*\)/g, "")   // strip parentheticals
      .replace(/\s+/g, " ")
      .trim();
  };
  const addRaw = (s: string, d: string, src: string, r: string) => {
    s = normalizeLabel(s);
    d = normalizeLabel(d);
    // Pass 10 S2-1: skip self-loops at emit (~7% of quarantined pairs).
    if (!s || !d || s.toLowerCase() === d.toLowerCase()) return;
    rawPairs.push({ rawSrc: s, rawDst: d, source: src, raw: r });
    (perSource[src] ??= { total: 0, resolved: 0, holdout: 0, fallback: 0 }).total++;
  };

  // Khan Academy
  {
    const lines = Deno.readTextFileSync("data/khanacademy/khandata.tsv").split("\n").filter((l) => l.length);
    const h = lines[0].split("\t");
    const iName = h.indexOf("Data Name"), iPre = h.indexOf("Prereq(s)"),
          iCode = h.indexOf("Code"), iDisp = h.indexOf("Display Name");
    const codeToName = new Map<string, string>(), nameToDisplay = new Map<string, string>();
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split("\t");
      if (c[iCode] && c[iName]) codeToName.set(c[iCode].trim(), c[iName].trim());
      if (c[iName] && c[iDisp]) nameToDisplay.set(c[iName].trim(), c[iDisp].trim());
    }
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split("\t");
      const target = (c[iName] || "").trim();
      const pre = (c[iPre] || "").trim();
      if (!target || !pre || pre === "root") continue;
      const dstLabel = nameToDisplay.get(target) || target;
      for (const p of pre.split(";").map((x) => x.trim()).filter(Boolean)) {
        const pName = codeToName.get(p) || p;
        const srcLabel = nameToDisplay.get(pName) || pName;
        addRaw(srcLabel, dstLabel, "khan", `${pName}->${target}`);
      }
    }
  }

  // AL-CPL — per readme: "*.preqs: concept pairs with prerequisite relations.
  // The second concept (2nd column) is a prerequisite of the first concept (1st column)."
  for (const domain of ["data_mining", "geometry", "physics", "precalculus"]) {
    let text: string;
    try { text = Deno.readTextFileSync(`data/al-cpl/data/${domain}.preqs`); } catch { continue; }
    for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const [dependent, prereq] = line.split(",");
      if (dependent && prereq) addRaw(prereq, dependent, `alcpl_${domain}`, line);
    }
  }

  // Metacademy — Wikipedia-mapped CSV
  {
    const rows = parseCsv(Deno.readTextFileSync("data/metacademy/Metacademy-prerequisite-pairs-transformed-to-wikipedia.csv"));
    for (let i = 1; i < rows.length; i++) {
      const pre = rows[i][0], tgt = rows[i][3];
      if (pre && tgt) addRaw(pre, tgt, "metacademy", `${pre}->${tgt}`);
    }
  }

  // Metacademy — raw concept dependencies.txt (393 concept dirs)
  {
    const CONCEPTS = "data/metacademy/metacademy-content/concepts";
    const titleByDir = new Map<string, string>();
    const dirs: string[] = [];
    try {
      for (const f of Deno.readDirSync(CONCEPTS)) {
        if (!f.isDirectory || f.name === "ANNOTATED_EXAMPLE") continue;
        dirs.push(f.name);
        try { titleByDir.set(f.name, Deno.readTextFileSync(`${CONCEPTS}/${f.name}/title.txt`).trim()); }
        catch { /* title missing — fall back to dir name below */ }
      }
    } catch (e) { console.warn(`[seed-edges] WARN: Metacademy concepts dir unavailable — ${(e as Error).message}`); }
    const resolveTag = (tag: string): string => {
      const t = tag.trim();
      if (!t) return "";
      const dashToUnder = t.replace(/-/g, "_");
      const underToDash = t.replace(/_/g, "-");
      for (const key of [t, dashToUnder, underToDash]) {
        const title = titleByDir.get(key);
        if (title) return title;
      }
      return t.replace(/[_-]/g, " ");
    };
    let emitted = 0;
    for (const dir of dirs) {
      const target = titleByDir.get(dir) || dir.replace(/_/g, " ");
      let deps: string;
      try { deps = Deno.readTextFileSync(`${CONCEPTS}/${dir}/dependencies.txt`); } catch { continue; }
      for (const line of deps.split("\n")) {
        const m = line.match(/^\s*tag:\s*(\S+)\s*$/);
        if (!m) continue;
        const pre = resolveTag(m[1]);
        if (pre && target) { addRaw(pre, target, "metacademy_raw", `${m[1]}->${dir}`); emitted++; }
      }
    }
    console.log(`[seed-edges] metacademy_raw: ${emitted} pairs from ${dirs.length} concept dirs`);
  }

  // MOOCCubeX
  const translations: Record<string, string> = (() => {
    try { return JSON.parse(Deno.readTextFileSync("data/mooccubex/translations.json")); }
    catch (e) {
      console.warn(`[seed-edges] WARN: data/mooccubex/translations.json missing — Chinese labels will pass through untranslated (${(e as Error).message})`);
      return {};
    }
  })();
  for (const domain of ["cs", "math", "psy"]) {
    let bytes: Uint8Array;
    try { bytes = Deno.readFileSync(`data/mooccubex/${domain}.json.gz`); }
    catch (e) { console.warn(`[seed-edges] WARN: skipping MOOCCubeX ${domain} — ${(e as Error).message}`); continue; }
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
    const text = await new Response(stream).text();
    let parseFails = 0;
    for (const line of text.split("\n")) {
      if (!line) continue;
      let obj: { c1?: string; c2?: string; ground_truth?: number };
      try { obj = JSON.parse(line); } catch { parseFails++; continue; }
      if (obj.ground_truth !== 1 || !obj.c1 || !obj.c2) continue;
      addRaw(translations[obj.c1] || obj.c1, translations[obj.c2] || obj.c2,
        `moocx_${domain}`, `${obj.c1}->${obj.c2}`);
    }
    if (parseFails > 0) console.warn(`[seed-edges] WARN: MOOCCubeX ${domain} dropped ${parseFails} malformed JSON lines`);
  }

  // OpenSALT precedes
  {
    for (const f of Deno.readDirSync("data/opensalt")) {
      if (!f.name.endsWith(".json") || f.name === "index.json") continue;
      let doc: { CFItems?: { identifier: string; humanCodingScheme?: string; fullStatement?: string }[];
        CFAssociations?: { associationType?: string; originNodeURI?: { identifier?: string; title?: string }; destinationNodeURI?: { identifier?: string; title?: string } }[] };
      try { doc = JSON.parse(Deno.readTextFileSync(`data/opensalt/${f.name}`)); }
      catch (e) { console.warn(`[seed-edges] WARN: skipping OpenSALT framework ${f.name} — ${(e as Error).message}`); continue; }
      const itemMap = new Map<string, { code: string; statement: string }>();
      for (const it of doc.CFItems || []) {
        itemMap.set(it.identifier, { code: it.humanCodingScheme || "", statement: it.fullStatement || "" });
      }
      for (const a of doc.CFAssociations || []) {
        if ((a.associationType || "").toLowerCase() !== "precedes") continue;
        const o = a.originNodeURI || {}, d = a.destinationNodeURI || {};
        const lbl = (x: { identifier?: string; title?: string }) => {
          if (x.identifier && itemMap.has(x.identifier)) {
            return itemMap.get(x.identifier)!.statement || x.title || x.identifier || "";
          }
          return x.title || x.identifier || "";
        };
        addRaw(lbl(o), lbl(d), "opensalt_precedes", `${o.identifier || o.title}->${d.identifier || d.title}`);
      }
    }
  }

  // OpenSALT within-framework grade ordering
  {
    const STOPT = new Set(["the","a","an","of","in","on","for","to","and","or","is","at","by","with","from","as","be","that","this","which","can","will","should","about","each","student","students","their","they","them","are","use","uses"]);
    const sigT = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOPT.has(w)));
    let emitted = 0;
    outer: for (const f of Deno.readDirSync("data/opensalt")) {
      if (!f.name.endsWith(".json") || f.name === "index.json") continue;
      let doc: { CFItems?: { identifier: string; humanCodingScheme?: string; fullStatement?: string; educationLevel?: string[] }[] };
      try { doc = JSON.parse(Deno.readTextFileSync(`data/opensalt/${f.name}`)); }
      catch (e) { console.warn(`[seed-edges] WARN: skipping OpenSALT grade ${f.name} — ${(e as Error).message}`); continue; }
      type Node = { label: string; grade: number; code: string };
      const nodes: Node[] = [];
      for (const it of doc.CFItems || []) {
        if (!it.fullStatement || it.fullStatement.length < 15) continue;
        const grades: number[] = [];
        for (const el of it.educationLevel || []) {
          const v = (el || "").toUpperCase();
          if (v === "KG" || v === "K") grades.push(0);
          else if (v === "PK") grades.push(-1);
          else if (/^\d+$/.test(v)) grades.push(Number(v));
        }
        if (!grades.length) continue;
        const minG = Math.min(...grades);
        if (minG < 0 || minG > 12) continue;
        nodes.push({ label: it.fullStatement.slice(0, 120), grade: minG, code: it.humanCodingScheme || "" });
      }
      if (nodes.length < 10) continue;
      nodes.sort((a, b) => a.grade - b.grade);
      const PAIR_CAP = 5;
      const perGradePair = new Map<string, number>();
      for (let i = 0; i < nodes.length; i++) {
        const ai = nodes[i];
        const ta = sigT(ai.label);
        if (ta.size < 3) continue;
        for (let j = i + 1; j < nodes.length; j++) {
          const aj = nodes[j];
          if (aj.grade <= ai.grade || aj.grade > ai.grade + 3) { if (aj.grade > ai.grade + 3) break; else continue; }
          const tb = sigT(aj.label);
          let overlap = 0;
          for (const t of ta) if (tb.has(t)) overlap++;
          if (overlap < 3) continue;
          // Pass 10 S2-5: skip near-duplicate grade-adjacent standards.
          // Jaccard ≥0.80 means same concept at different grade levels (sequencing, not prereq).
          const jaccard = overlap / (ta.size + tb.size - overlap);
          if (jaccard >= 0.80) continue;
          const k = `${ai.grade}->${aj.grade}`;
          const c = perGradePair.get(k) ?? 0;
          if (c >= PAIR_CAP) continue;
          perGradePair.set(k, c + 1);
          addRaw(ai.label, aj.label, "opensalt_grade", `${ai.code || "c"}_g${ai.grade}->${aj.code || "c"}_g${aj.grade}`);
          emitted++;
          if (emitted > 50000) break outer;
        }
      }
    }
    console.log(`[seed-edges] opensalt_grade: ${emitted} pairs`);
  }

  // Pass 16 MF2: foundation wiring. Connect synthesized foundation hubs to their
  // fragmented variants (add-within-5 → addition, etc.) via pattern matching.
  {
    try {
      const f = JSON.parse(Deno.readTextFileSync("data/_foundations.json"));
      const foundationTitles = new Map<string, string>();
      for (const fd of f.foundations || []) {
        if (fd.id && fd.title) foundationTitles.set(fd.id, fd.title);
      }
      let n = 0;
      for (const e of f.seed_edges || []) {
        if (!e.prereq) continue;
        const preTitle = foundationTitles.get(e.prereq);
        if (!preTitle) continue;
        if (e.dependent) {
          const dTitle = foundationTitles.get(e.dependent);
          if (dTitle) { addRaw(preTitle, dTitle, "foundation", `${e.prereq}->${e.dependent}`); n++; }
        } else if (e.dependent_pattern) {
          const re = new RegExp(e.dependent_pattern);
          for (const id of idx.idSet) {
            if (!re.test(id)) continue;
            if (id === e.prereq) continue;
            // resolveConcept matches ids directly; pass the id slug as the "label".
            addRaw(preTitle, id, "foundation", `${e.prereq}->${id}`);
            n++;
          }
        }
      }
      console.log(`[seed-edges] foundation wiring: ${n} pairs`);
    } catch (e) { console.warn(`[seed-edges] foundation wiring skipped: ${(e as Error).message}`); }
  }

  // Pass 15 K2: Khan-to-OpenSALT-Khan crosswalk via humanCodingScheme.
  // Khan TSV uses slugs like "counting-out-1-20-objects"; OpenSALT Khan framework
  // uses "K.CC.B.5"-style codes in its humanCodingScheme. Crosswalk adds ~700 seeds.
  // Currently handled via the same index; extend resolveConcept to try `code:Khan X`.
  // (No change needed here — stage list already emits `code:` tags which resolveConcept can match.)

  console.log(`[seed-edges] collected ${rawPairs.length} raw pairs`);

  // Pass 1: exact
  const labelToId = new Map<string, string | null>();
  const resolveExact = (lbl: string): string | null => {
    if (labelToId.has(lbl)) return labelToId.get(lbl)!;
    const r = resolveConcept(lbl, idx);
    labelToId.set(lbl, r);
    return r;
  };
  const unresolved = new Set<string>();
  for (const p of rawPairs) {
    if (!resolveExact(p.rawSrc)) unresolved.add(p.rawSrc);
    if (!resolveExact(p.rawDst)) unresolved.add(p.rawDst);
  }
  console.log(`[seed-edges] pass 1: ${labelToId.size - unresolved.size}/${labelToId.size} resolved exactly`);

  // Pass 2: embedding fallback
  const FALLBACK = Number(Deno.env.get("SEED_FALLBACK_COS") ?? "0.90");
  const STOP = new Set(["the","a","an","of","in","on","for","to","and","or","is","at","by","with","from","as","be","that","this"]);
  const sigTokens = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const t of s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean)) {
      if (t.length >= 3 && !STOP.has(t)) out.add(t);
    }
    return out;
  };
  const titleById = new Map<string, string>();
  {
    const tlines = Deno.readTextFileSync(taggedTsvPath()).split("\n").filter((l) => l.length);
    for (let i = 1; i < tlines.length; i++) {
      const [id, title] = tlines[i].split("\t");
      if (id) titleById.set(id, title || "");
    }
  }
  const dropReason = new Map<string, string>();
  let embedErrors = 0;
  if (unresolved.size > 0) {
    const { ids: embIds } = loadRawEmbeddings();
    const matIds = embIds.filter((id) => idx.idSet.has(id));
    const mat = normalizedEmbeddingsForSkills(matIds);
    console.log(`[seed-edges] active vectors: ${matIds.length}/${embIds.length}`);
    const labels = [...unresolved];
    const labelVecs = new Float32Array(labels.length * EMBED_DIM);
    const embedOk = new Uint8Array(labels.length);
    const CONC = 16;
    const embedWithRetry = async (lbl: string): Promise<Float32Array | null> => {
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { return await embedOne(lbl); }
        catch (e) {
          lastErr = e;
          if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        }
      }
      embedErrors++;
      if (embedErrors <= 5) console.warn(`[seed-edges] embed failed after 3 tries: ${lbl.slice(0, 60)} — ${(lastErr as Error).message}`);
      return null;
    };
    let done = 0;
    const t0 = performance.now();
    for (let s = 0; s < labels.length; s += CONC) {
      const batch = labels.slice(s, s + CONC);
      const results = await Promise.all(batch.map(embedWithRetry));
      for (let j = 0; j < results.length; j++) {
        const v = results[j];
        if (v) {
          labelVecs.set(normalize(v), (s + j) * EMBED_DIM);
          embedOk[s + j] = 1;
        }
      }
      done += batch.length;
      if (done % 500 === 0 || done === labels.length) {
        const rate = done / ((performance.now() - t0) / 1000);
        console.log(`[seed-edges] embedded ${done}/${labels.length} (${rate.toFixed(1)}/s)`);
      }
    }
    let matched = 0;
    for (let li = 0; li < labels.length; li++) {
      if (!embedOk[li]) { dropReason.set(labels[li], "embed-failed"); continue; }
      const lv = labelVecs.subarray(li * EMBED_DIM, (li + 1) * EMBED_DIM);
      let best = -1, bestScore = FALLBACK;
      for (let si = 0; si < matIds.length; si++) {
        const sv = mat.subarray(si * EMBED_DIM, (si + 1) * EMBED_DIM);
        let dot = 0;
        for (let k = 0; k < EMBED_DIM; k++) dot += lv[k] * sv[k];
        if (dot > bestScore) { bestScore = dot; best = si; }
      }
      if (best < 0) { dropReason.set(labels[li], `below-cos-${FALLBACK}`); continue; }
      const lt = sigTokens(labels[li]);
      const tt = sigTokens(titleById.get(matIds[best]) || matIds[best]);
      let overlap = 0;
      for (const t of lt) if (tt.has(t)) overlap++;
      if (overlap === 0 || lt.size === 0) {
        dropReason.set(labels[li], "no-token-overlap");
        continue;
      }
      labelToId.set(labels[li], matIds[best]);
      matched++;
    }
    console.log(`[seed-edges] fallback matched ${matched}/${labels.length} @ cos≥${FALLBACK}${embedErrors ? `, ${embedErrors} embed errors` : ""}`);
  }

  // Pass 3: emit (and quarantine unresolved)
  type Edge = { src: string; dst: string; source: string; confidence: number; holdout: boolean; fallback: boolean };
  const edges: Edge[] = [];
  const quarantine: string[] = ["rawSrc\trawDst\tsource\traw\tsrc_reason\tdst_reason"];
  const dropPerSource: Record<string, number> = {};
  const labelReason = (lbl: string): string => {
    if (labelToId.get(lbl)) return "ok";
    if (dropReason.has(lbl)) return dropReason.get(lbl)!;
    if (unresolved.has(lbl)) return "no-match";
    return "unknown";
  };
  for (const p of rawPairs) {
    const src = labelToId.get(p.rawSrc);
    const dst = labelToId.get(p.rawDst);
    if (!src || !dst || src === dst) {
      const reason = src === dst && src ? "self-loop" : "unresolved";
      dropPerSource[p.source] = (dropPerSource[p.source] ?? 0) + 1;
      quarantine.push(`${p.rawSrc}\t${p.rawDst}\t${p.source}\t${p.raw}\t${src ? "ok" : labelReason(p.rawSrc)}\t${dst ? "ok" : labelReason(p.rawDst)}${reason === "self-loop" ? " (self-loop)" : ""}`);
      continue;
    }
    const srcExact = resolveConcept(p.rawSrc, idx) === src;
    const dstExact = resolveConcept(p.rawDst, idx) === dst;
    const fallback = !(srcExact && dstExact);
    const holdout = (h32(p.source + "|" + p.raw) % 5) === 0;
    edges.push({ src, dst, source: p.source, confidence: fallback ? 0.85 : 1.0, holdout, fallback });
    const s = perSource[p.source];
    s.resolved++;
    if (holdout) s.holdout++;
    if (fallback) s.fallback++;
  }
  Deno.writeTextFileSync(`${BUILD}/1e_unresolved.tsv`, quarantine.join("\n") + "\n");
  console.log(`[seed-edges] quarantine: ${quarantine.length - 1} pairs dropped, written to build/1e_unresolved.tsv`);
  const seen = new Map<string, Edge>();
  for (const e of edges) {
    const k = `${e.src}\t${e.dst}\t${e.source}`;
    const prev = seen.get(k);
    if (!prev || (prev.fallback && !e.fallback)) seen.set(k, e);
  }
  const uniq = [...seen.values()];
  const out = ["src_id\tdst_id\tsource\tconfidence\tholdout\tfallback"];
  for (const e of uniq) out.push(`${e.src}\t${e.dst}\t${e.source}\t${e.confidence.toFixed(2)}\t${e.holdout ? "1" : "0"}\t${e.fallback ? "1" : "0"}`);
  Deno.writeTextFileSync(`${BUILD}/1e_seed_edges.tsv`, out.join("\n") + "\n");

  writeStats("seed-edges", {
    total_raw: rawPairs.length,
    total_edges: uniq.length,
    exact: uniq.filter((e) => !e.fallback).length,
    fallback: uniq.filter((e) => e.fallback).length,
    holdout: uniq.filter((e) => e.holdout).length,
    per_source: perSource,
    dropped_total: quarantine.length - 1,
    dropped_per_source: dropPerSource,
    embed_errors: embedErrors,
    fallback_threshold: FALLBACK,
  });
}

// ---------- stage embed ----------

function buildEmbedContent(title: string, desc: string, tags: string): string {
  // nomic-embed-text returns a constant-ish vector for short inputs (confirmed via Ollama API).
  // Pad short content with the tag breadcrumb so the pooling has enough tokens to differentiate.
  const base = desc ? `${title}\n${desc}` : title;
  if (base.length >= 40) return base;
  const tagHint = tags ? tags.replace(/,/g, " ").slice(0, 300) : "";
  return tagHint ? `${base}. ${tagHint}` : `${base}. Skill: ${title}. ${title}.`;
}

function paddedEmbedContent(title: string, desc: string, tags: string): string {
  const tagHint = tags ? tags.replace(/,/g, " ").slice(0, 400) : "";
  const d = desc ? ` ${desc}` : "";
  return `Skill: ${title}.${d} Context: ${tagHint || title}. Topic: ${title}.`;
}

function embedSignature(v: Float32Array): string {
  let s = "";
  for (let k = 0; k < 16; k++) s += v[k].toFixed(3) + ",";
  return s;
}

async function stageEmbed() {
  const lines = Deno.readTextFileSync(`${BUILD}/1_skills.tsv`).split("\n").filter((l) => l.length);
  const skills: { id: string; title: string; description: string; tags: string; content: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    skills.push({
      id: c[0],
      title: c[1],
      description: c[2] || "",
      tags: c[4] || "",
      content: buildEmbedContent(c[1], c[2] || "", c[4] || ""),
    });
  }
  if (Deno.env.get("SKILL_LIMIT")) {
    skills.length = Math.min(skills.length, Number(Deno.env.get("SKILL_LIMIT")));
  }
  console.log(`[embed] ${skills.length} skills`);

  const t0 = performance.now();
  const vecs = await embedBatch(skills.map((s) => s.content), "embed");

  // Duplicate-vector detection: nomic-embed-text collapses short inputs to near-identical vectors.
  // Group by 16-float signature, re-embed groups with >5 members using padded content.
  const bucket = new Map<string, number[]>();
  for (let i = 0; i < vecs.length; i++) {
    const sig = embedSignature(vecs[i]);
    const arr = bucket.get(sig);
    if (arr) arr.push(i); else bucket.set(sig, [i]);
  }
  const dupGroupsInitial = [...bucket.values()].filter((idxs) => idxs.length > 5);
  console.log(`[embed] ${dupGroupsInitial.length} duplicate-vector groups before retry`);

  let retried = 0;
  if (dupGroupsInitial.length > 0) {
    const retryIdxs: number[] = [];
    const retryContents: string[] = [];
    for (const idxs of dupGroupsInitial) {
      for (const i of idxs) {
        retryIdxs.push(i);
        retryContents.push(paddedEmbedContent(skills[i].title, skills[i].description, skills[i].tags));
      }
    }
    const retriedVecs = await embedBatch(retryContents, "embed-retry");
    for (let k = 0; k < retryIdxs.length; k++) vecs[retryIdxs[k]] = retriedVecs[k];
    retried = retryIdxs.length;
  }

  // Post-retry scan — anything still in a large duplicate group is pathological.
  bucket.clear();
  for (let i = 0; i < vecs.length; i++) {
    const sig = embedSignature(vecs[i]);
    const arr = bucket.get(sig);
    if (arr) arr.push(i); else bucket.set(sig, [i]);
  }
  const dupGroupsFinal = [...bucket.values()].filter((idxs) => idxs.length > 5);
  const pathological: string[] = [];
  for (const idxs of dupGroupsFinal) for (const i of idxs) pathological.push(skills[i].id);
  Deno.writeTextFileSync(
    `${BUILD}/2_pathological.tsv`,
    pathological.length ? pathological.join("\n") + "\n" : "",
  );
  console.log(`[embed] ${dupGroupsFinal.length} duplicate-vector groups after retry; ${pathological.length} pathological skills`);

  const bin = new Float32Array(skills.length * EMBED_DIM);
  let nans = 0;
  for (let i = 0; i < skills.length; i++) {
    const v = vecs[i];
    for (let j = 0; j < EMBED_DIM; j++) if (!Number.isFinite(v[j])) nans++;
    bin.set(v, i * EMBED_DIM);
  }
  Deno.writeFileSync(`${BUILD}/2_embeddings.bin`, new Uint8Array(bin.buffer));
  Deno.writeTextFileSync(`${BUILD}/2_ids.tsv`, skills.map((s) => s.id).join("\n") + "\n");

  writeStats(2, {
    total: skills.length,
    dim: EMBED_DIM,
    nan_count: nans,
    dup_groups_before_retry: dupGroupsInitial.length,
    dup_groups_after_retry: dupGroupsFinal.length,
    dup_vector_count: pathological.length,
    retried,
    total_seconds: (performance.now() - t0) / 1000,
  });
  if (nans > 0) throw new Error(`embed: ${nans} NaN/Inf values`);
}

// ---------- stage tag ----------

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
  const esco = parseCsv(Deno.readTextFileSync("data/esco/occupations_en.csv"));
  const eh = esco[0], el = eh.indexOf("preferredLabel"), ed = eh.indexOf("description");
  for (let i = 1; i < esco.length; i++) push(esco[i][el] || "", esco[i][ed] || "");
  const onet = parseTsv(Deno.readTextFileSync("data/onet/Occupation Data.txt"));
  const oh = onet[0], ot = oh.indexOf("Title"), od = oh.indexOf("Description");
  for (let i = 1; i < onet.length; i++) push(onet[i][ot] || "", onet[i][od] || "");
  console.log(`[tag] occupation refs: ${refs.length}`);
  return refs;
}

// Drop geographic/temporal/biographical categories — they provide zero signal for skills
// and cause false positives like polyline → "railway-lines-in-europe".
const TOPIC_BADCAT2 = /(\b(in|of|from|by|for)\b\s+(Europe|Asia|Africa|America|Oceania|Antarctica|England|France|Germany|China|Japan|India|Russia|USSR|USA|Britain|Scotland|Ireland|Italy|Spain|Canada|Australia|Mexico|Brazil|Argentina|Iran|Iraq|Egypt|Turkey|Greece))|(\bcentury|centuries|\bdecade|\b\d{4}s\b|\b\d{3,4}\s*(BC|AD|BCE|CE)\b)|(\bpeople\b|\bbiography|\bbiographies|\bdeaths\b|\bbirths\b|\bmarriage|\bfamily\b)|(\bdisasters|\bincidents|\baccidents|\bwars\b|\bbattles|\belections)|^(19|20)\d{2}s?\b|^\d{1,2}(st|nd|rd|th)\s*(century|millennium)/i;

async function parseTopicRefs(perSource: number): Promise<{ label: string; desc: string }[]> {
  const BADCAT = /^(Wikipedia|Lists of|List of|Categories |Redirects|Articles |Stubs|Templates|Commons|Set indices)/i;
  const topSource = async (name: string, cmd: string[]) => {
    const BROADER = "skos/core#broader", PREF = "skos/core#prefLabel";
    const inDeg = new Map<string, number>();
    await streamLines(cmd, (line) => {
      if (line.length < 40 || line[0] === "#") return;
      if (!line.includes(BROADER)) return;
      const m = line.match(/^<[^>]+>\s+<[^>]+>\s+<([^>]+)>\s*\.$/);
      if (m) inDeg.set(m[1], (inDeg.get(m[1]) ?? 0) + 1);
    });
    const top = [...inDeg.entries()].sort((a, b) => b[1] - a[1]).slice(0, perSource * 5);
    const topSet = new Map(top.map(([uri, d]) => [uri, d]));
    inDeg.clear();
    const labels = new Map<string, string>();
    await streamLines(cmd, (line) => {
      if (line.length < 40 || line[0] === "#") return;
      if (!line.includes(PREF)) return;
      const m = line.match(/^<([^>]+)>\s+<[^>]+>\s+"((?:[^"\\]|\\.)*)"(?:@en)?\s*\.$/);
      if (!m || !topSet.has(m[1])) return;
      const lbl = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      if (lbl.length < 2 || lbl.length > 50) return;
      if (BADCAT.test(lbl)) return;
      const words = lbl.split(/\s+/);
      if (words.length > 4) return;
      if (lbl.includes("(") || lbl.includes(",")) return;
      labels.set(m[1], lbl);
    });
    const scored: { uri: string; label: string; inDeg: number }[] = [];
    for (const [uri, label] of labels) scored.push({ uri, label, inDeg: topSet.get(uri)! });
    scored.sort((a, b) => b.inDeg - a.inDeg);
    return scored.slice(0, perSource);
  };
  const tL = await topSource("lcsh", ["sh", "-c", "gunzip -c data/lcsh/subjects.skosrdf.nt.gz"]);
  const tD = await topSource("dbpedia", ["sh", "-c", "bzcat data/dbpedia/skos_categories_en.ttl.bz2"]);
  const refs: { label: string; desc: string }[] = [];
  const seen = new Set<string>();
  for (const r of [...tL, ...tD]) {
    const k = r.label.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    refs.push({ label: r.label, desc: "" });
  }
  console.log(`[tag] topic refs: ${refs.length}`);
  return refs;
}

function parseEscoSkillTopics(): Map<string, string[]> {
  const rows = parseCsv(Deno.readTextFileSync("data/esco/broaderRelationsSkillPillar_en.csv"));
  const h = rows[0];
  const iC = h.indexOf("conceptLabel"), iCu = h.indexOf("conceptUri"),
        iB = h.indexOf("broaderLabel"), iBu = h.indexOf("broaderUri");
  const label = new Map<string, string>(), parents = new Map<string, string[]>();
  for (let i = 1; i < rows.length; i++) {
    const cU = rows[i][iCu], cL = rows[i][iC], pU = rows[i][iBu], pL = rows[i][iB];
    if (cU && cL) label.set(cU, cL);
    if (pU && pL) label.set(pU, pL);
    if (cU && pU) { const arr = parents.get(cU) ?? []; arr.push(pU); parents.set(cU, arr); }
  }
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
  return out;
}

function parseOnetSkillOccupations(): Map<string, string[]> {
  const occTitles = new Map<string, string>();
  for (const r of parseTsv(Deno.readTextFileSync("data/onet/Occupation Data.txt")).slice(1))
    if (r[0] && r[1]) occTitles.set(r[0], r[1]);
  const cmr = new Map<string, string>();
  for (const r of parseTsv(Deno.readTextFileSync("data/onet/Content Model Reference.txt")).slice(1))
    if (r[0] && r[1]) cmr.set(r[0], r[1]);
  const bySkill = new Map<string, Map<string, number>>();
  for (const fname of ["Skills.txt", "Knowledge.txt", "Abilities.txt"]) {
    const rows = parseTsv(Deno.readTextFileSync(`data/onet/${fname}`));
    const h = rows[0];
    const iS = h.indexOf("O*NET-SOC Code"), iE = h.indexOf("Element ID"),
          iSc = h.indexOf("Scale ID"), iV = h.indexOf("Data Value");
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][iSc] !== "IM") continue;
      const name = cmr.get(rows[i][iE]);
      const occ = occTitles.get(rows[i][iS]);
      if (!name || !occ) continue;
      const v = Number(rows[i][iV]);
      if (!Number.isFinite(v)) continue;
      const key = slugify(name);
      let m = bySkill.get(key);
      if (!m) { m = new Map(); bySkill.set(key, m); }
      m.set(occ, Math.max(m.get(occ) ?? 0, v));
    }
  }
  const out = new Map<string, string[]>();
  for (const [key, m] of bySkill) {
    out.set(key, [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k));
  }
  return out;
}

function parseEscoSkillOccupations(): Map<string, string[]> {
  const rows = parseCsv(Deno.readTextFileSync("data/esco/occupationSkillRelations_en.csv"));
  const h = rows[0];
  const iO = h.indexOf("occupationLabel"), iS = h.indexOf("skillLabel"), iT = h.indexOf("relationType");
  const m = new Map<string, Set<string>>();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][iT] !== "essential") continue;
    const slug = slugify(rows[i][iS] || "");
    const occ = rows[i][iO];
    if (!slug || !occ) continue;
    let s = m.get(slug);
    if (!s) { s = new Set(); m.set(slug, s); }
    s.add(occ);
  }
  const out = new Map<string, string[]>();
  for (const [k, v] of m) out.set(k, [...v]);
  return out;
}

async function stageTag() {
  const lines = Deno.readTextFileSync(`${BUILD}/1_skills.tsv`).split("\n").filter((l) => l.length);
  const skills = lines.slice(1).map((l) => {
    const c = l.split("\t");
    return { id: c[0], title: c[1], description: c[2], sources: c[3], tags: c[4] };
  });
  const DIM = EMBED_DIM;
  const skillVecs = normalizedEmbeddingsForSkills(skills.map((s) => s.id));

  const occRefs = parseOccupationRefs();
  const topicRefs = await parseTopicRefs(Number(Deno.env.get("TOPIC_PER_SOURCE") ?? "5000"));
  // Retroactively filter topic refs by geographic/temporal patterns. Their embeddings are
  // already in the cache, so we keep them in-place but mark them as "poisoned" so they
  // are never matched.
  const topicPoisoned = new Uint8Array(topicRefs.length);
  let topicDropped = 0;
  for (let i = 0; i < topicRefs.length; i++) {
    if (TOPIC_BADCAT2.test(topicRefs[i].label)) { topicPoisoned[i] = 1; topicDropped++; }
  }
  console.log(`[tag] poisoned ${topicDropped}/${topicRefs.length} topic refs (geographic/temporal)`);
  const occVecs = await embedBatch(occRefs.map((r) => r.label), "tag:occ");
  const topicVecs = await embedBatch(topicRefs.map((r) => r.label), "tag:topic");

  const packNorm = (vecs: Float32Array[]) => {
    const buf = new Float32Array(vecs.length * DIM);
    for (let i = 0; i < vecs.length; i++) buf.set(normalize(vecs[i]), i * DIM);
    return buf;
  };
  const occMat = packNorm(occVecs);
  const topicMat = packNorm(topicVecs);

  const OCC_K = Number(Deno.env.get("OCC_TOP_K") ?? "2");
  const TOPIC_K = Number(Deno.env.get("TOPIC_TOP_K") ?? "3");
  const OCC_TH = Number(Deno.env.get("OCC_THRESHOLD") ?? "0.60");
  const TOPIC_TH = Number(Deno.env.get("TOPIC_THRESHOLD") ?? "0.62");
  const IDF_MAX = Number(Deno.env.get("IDF_MAX_FRAC") ?? "0.015");
  const LEXICAL_GUARD = Deno.env.get("TAG_LEXICAL_GUARD") !== "0";

  const TAG_STOP = new Set([
    "the","a","an","and","or","of","to","for","in","on","at","by","with","from","as","is","are","be",
    "that","this","these","those","their","its","into","such","than","then","also","over","under",
    "about","above","below","between","through","during","after","before","because","while","other","which",
    "where","when","what","each","both","some","most","many","much","more","less","only","very","just",
    "can","should","would","could","may","might","will","shall","does","did","done","has","have","had",
  ]);
  const tokenize = (s: string): Set<string> => {
    const out = new Set<string>();
    const norm = s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);
    for (const w of norm) {
      if (w.length < 4) continue;
      if (TAG_STOP.has(w)) continue;
      out.add(w);
      // singular/plural normalization: add stem without trailing s
      if (w.length >= 5 && w.endsWith("s") && !w.endsWith("ss")) out.add(w.slice(0, -1));
    }
    return out;
  };
  const skillToks = skills.map((s) => tokenize(`${s.title} ${s.description}`));
  // Build a corpus-frequency table so "common" words (line, data, system, device…) don't
  // satisfy the lexical guard on their own.
  const docFreq = new Map<string, number>();
  for (const toks of skillToks) for (const t of toks) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  const COMMON_CUTOFF = Math.max(500, Math.floor(skills.length * 0.01));
  const commonWord = (t: string): boolean => (docFreq.get(t) ?? 0) > COMMON_CUTOFF;

  const oversamplePass = (refMat: Float32Array, refCount: number, refs: { label: string }[], keep: number, th: number, poisoned?: Uint8Array) => {
    const out: { idx: number; score: number }[][] = new Array(skills.length);
    const refHits = new Int32Array(refCount);
    const refToks = refs.map((r) => tokenize(r.label));
    for (let i = 0; i < skills.length; i++) {
      const sOff = i * DIM;
      const skToks = skillToks[i];
      const top: { idx: number; score: number }[] = [];
      for (let r = 0; r < refCount; r++) {
        if (poisoned && poisoned[r]) continue;
        if (LEXICAL_GUARD) {
          let hits = 0;
          let rareHit = false;
          for (const t of refToks[r]) {
            if (!skToks.has(t)) continue;
            hits++;
            if (!commonWord(t)) rareHit = true;
          }
          if (!rareHit && hits < 2) continue;
        }
        let s = 0;
        const rOff = r * DIM;
        for (let d = 0; d < DIM; d++) s += skillVecs[sOff + d] * refMat[rOff + d];
        if (s < th) continue;
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
    const maxHits = Math.floor(skills.length * IDF_MAX);
    const mask = new Uint8Array(refs.length);
    let dropped = 0;
    for (let r = 0; r < refs.length; r++) {
      if (refHits[r] > maxHits) dropped++;
      else mask[r] = 1;
    }
    console.log(`[tag] ${label}: pruned ${dropped}/${refs.length} refs (>${maxHits} hits)`);
    return mask;
  };

  const OVERSAMPLE = 5;
  console.log(`[tag] matching ${skills.length}×${occRefs.length} occs (lexical_guard=${LEXICAL_GUARD})`);
  const occPass = oversamplePass(occMat, occRefs.length, occRefs, OCC_K * OVERSAMPLE, OCC_TH);
  const occMask = pruneMask(occPass.refHits, occRefs, "occ");
  console.log(`[tag] matching ${skills.length}×${topicRefs.length} topics (lexical_guard=${LEXICAL_GUARD})`);
  const topicPass = oversamplePass(topicMat, topicRefs.length, topicRefs, TOPIC_K * OVERSAMPLE, TOPIC_TH, topicPoisoned);
  const topicMask = pruneMask(topicPass.refHits, topicRefs, "topic");

  const directEsco = parseEscoSkillOccupations();
  const directOnet = parseOnetSkillOccupations();
  const directEscoTopics = parseEscoSkillTopics();
  const DIRECT_OCC_CAP = 3, DIRECT_TOPIC_CAP = 3;

  const frameworkTopic = (tagString: string): string | null => {
    const m = tagString.match(/framework:([^,]+)/);
    if (!m) return null;
    return m[1].replace(/^(ui-|gcps-aks-|pcg-|ccs-|chicago-public-schools-illinois-|western-and-northern-canadian-protocol-)/, "");
  };

  // Pass 11 O1/O3: manager/director occupation cosine threshold (0.60→0.95).
  const MANAGER_RE = /-manager$|-manager-|-director$|-director-|-supervisor$|-supervisor-/;
  // Pass 11 O1: hex-suffix occupation slugs are overflow-hashed ESCO titles (noise).
  const HEX_SUFFIX_RE = /-[a-f0-9]{6}$/;

  type Picked = { slug: string; score: number };
  const pickedOccs: Picked[][] = new Array(skills.length);
  const pickedTopics: Picked[][] = new Array(skills.length);

  for (let i = 0; i < skills.length; i++) {
    const s = skills[i];
    // Pass 15 K1: Khan K-12 content + low-grade OpenSALT-only skills skip occupation tagging.
    const grades: number[] = [];
    for (const m of s.tags.matchAll(/grade:([^,]+)/g)) {
      for (const part of m[1].split(".")) {
        const d = gradeToDifficulty(part);
        if (d !== null) grades.push(d);
      }
    }
    const maxGrade = grades.length ? Math.max(...grades) : -1;
    const isKhanContent = /framework:content-khan-academy/.test(s.tags) || s.tags.includes("framework:content-khan-academy");
    const khanSlug = /^khan-|-khan-|-khan$/.test(s.id) || s.title.toLowerCase().startsWith("khan");
    const lowGradeOnly = maxGrade >= 0 && maxGrade <= 9  // diff 9 = grade 8
      && !s.sources.includes("onet") && !s.sources.includes("esco");
    const skipOccs = isKhanContent || khanSlug || lowGradeOnly;

    let occs: Picked[] = skipOccs ? [] : occPass.out[i]
      .filter((r) => occMask[r.idx])
      .map((r) => ({ slug: slugify(occRefs[r.idx].label), score: r.score }))
      .filter((p) => p.slug && !HEX_SUFFIX_RE.test(p.slug))
      .filter((p) => !MANAGER_RE.test(p.slug) || p.score >= 0.95);
    {
      const seen = new Map<string, number>();
      for (const p of occs) seen.set(p.slug, Math.max(seen.get(p.slug) ?? 0, p.score));
      occs = [...seen.entries()].map(([slug, score]) => ({ slug, score }))
        .sort((a, b) => b.score - a.score).slice(0, OCC_K);
    }

    let topics: Picked[] = topicPass.out[i]
      .filter((r) => topicMask[r.idx])
      .map((r) => ({ slug: slugify(topicRefs[r.idx].label), score: r.score }))
      .filter((p) => !!p.slug);

    // Pass 13 CR4: for ≤2-word titles, require ≥1 shared significant token with topic.
    const wordCount = s.title.split(/\s+/).filter((w) => w.length > 1).length;
    if (wordCount <= 2) {
      const titleToks = new Set(slugify(s.title).split("-").filter((w) => w.length >= 4));
      topics = topics.filter((p) => {
        for (const tok of p.slug.split("-")) if (tok.length >= 4 && titleToks.has(tok)) return true;
        return false;
      });
    }
    {
      const seen = new Map<string, number>();
      for (const p of topics) seen.set(p.slug, Math.max(seen.get(p.slug) ?? 0, p.score));
      topics = [...seen.entries()].map(([slug, score]) => ({ slug, score }))
        .sort((a, b) => b.score - a.score).slice(0, TOPIC_K);
    }

    if (s.sources.includes("esco") && !skipOccs) {
      const dOcc = directEsco.get(s.id);
      if (dOcc?.length) {
        const direct = dOcc.slice(0, DIRECT_OCC_CAP).map((o) => slugify(o))
          .filter((sl) => sl && !HEX_SUFFIX_RE.test(sl));
        const existing = new Set(occs.map((p) => p.slug));
        const merged: Picked[] = [...direct.filter((sl) => !existing.has(sl)).map((sl) => ({ slug: sl, score: 1.0 })), ...occs];
        occs = merged.slice(0, DIRECT_OCC_CAP);
      }
      const dTopic = directEscoTopics.get(s.id);
      if (dTopic?.length) {
        const direct = dTopic.slice(0, DIRECT_TOPIC_CAP).map((t) => slugify(t)).filter(Boolean);
        const existing = new Set(topics.map((p) => p.slug));
        const merged: Picked[] = [...direct.filter((sl) => !existing.has(sl)).map((sl) => ({ slug: sl, score: 1.0 })), ...topics];
        topics = merged.slice(0, DIRECT_TOPIC_CAP);
      }
    }
    if (s.sources.includes("onet") && !skipOccs) {
      const dOcc = directOnet.get(s.id);
      if (dOcc?.length) {
        const direct = dOcc.slice(0, DIRECT_OCC_CAP).map((o) => slugify(o))
          .filter((sl) => sl && !HEX_SUFFIX_RE.test(sl));
        const existing = new Set(occs.map((p) => p.slug));
        const merged: Picked[] = [...direct.filter((sl) => !existing.has(sl)).map((sl) => ({ slug: sl, score: 1.0 })), ...occs];
        occs = merged.slice(0, DIRECT_OCC_CAP);
      }
    }
    if (s.sources.includes("opensalt")) {
      const ft = frameworkTopic(s.tags);
      if (ft) {
        const existing = new Set(topics.map((p) => p.slug));
        const merged: Picked[] = existing.has(ft) ? topics : [{ slug: ft, score: 1.0 }, ...topics];
        topics = merged.slice(0, DIRECT_TOPIC_CAP);
      }
    }
    pickedOccs[i] = occs;
    pickedTopics[i] = topics;
  }

  // Pass 11 O2: per-occupation frequency cap. Keeps the highest-scoring 500 assignments.
  const OCC_FREQ_CAP = Number(Deno.env.get("OCC_FREQ_CAP") ?? "500");
  const occToSkills = new Map<string, { i: number; score: number }[]>();
  for (let i = 0; i < skills.length; i++) {
    for (const p of pickedOccs[i]) {
      let arr = occToSkills.get(p.slug);
      if (!arr) { arr = []; occToSkills.set(p.slug, arr); }
      arr.push({ i, score: p.score });
    }
  }
  const freqDrops = new Map<number, Set<string>>();
  let freqCapped = 0;
  for (const [slug, arr] of occToSkills) {
    if (arr.length <= OCC_FREQ_CAP) continue;
    arr.sort((a, b) => b.score - a.score);
    for (let k = OCC_FREQ_CAP; k < arr.length; k++) {
      let set = freqDrops.get(arr[k].i);
      if (!set) { set = new Set(); freqDrops.set(arr[k].i, set); }
      set.add(slug);
      freqCapped++;
    }
  }
  if (freqCapped > 0) console.log(`[tag] occupation freq cap dropped ${freqCapped} assignments (cap=${OCC_FREQ_CAP})`);

  const rows: string[] = ["id\ttitle\tdescription\tsources\ttags\toccupations\ttopics"];
  const occCount = new Map<string, number>();
  const topicCount = new Map<string, number>();
  const occPer: number[] = [], topicPer: number[] = [];
  for (let i = 0; i < skills.length; i++) {
    const s = skills[i];
    const dropSet = freqDrops.get(i);
    const occSlugs = pickedOccs[i].filter((p) => !(dropSet?.has(p.slug))).map((p) => p.slug);
    const topicSlugs = pickedTopics[i].map((p) => p.slug);
    for (const x of occSlugs) occCount.set(x, (occCount.get(x) ?? 0) + 1);
    for (const x of topicSlugs) topicCount.set(x, (topicCount.get(x) ?? 0) + 1);
    occPer.push(occSlugs.length);
    topicPer.push(topicSlugs.length);
    rows.push([s.id, s.title, s.description, s.sources, s.tags, occSlugs.join(","), topicSlugs.join(",")].join("\t"));
  }
  Deno.writeTextFileSync(`${BUILD}/3_tagged.tsv`, rows.join("\n") + "\n");
  try { Deno.removeSync(`${BUILD}/3b_tagged_deduped.tsv`); } catch { /* ignore */ }

  const topN = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  writeStats(3, {
    skills: skills.length,
    occ_refs: occRefs.length,
    topic_refs: topicRefs.length,
    occ_threshold: OCC_TH,
    topic_threshold: TOPIC_TH,
    occ_top_k: OCC_K,
    topic_top_k: TOPIC_K,
    untagged_occupation: occPer.filter((n) => n === 0).length,
    untagged_topic: topicPer.filter((n) => n === 0).length,
    top_occupations: topN(occCount, 20),
    top_topics: topN(topicCount, 20),
  });
}

// ---------- stage dedupe ----------

function stageDedupe() {
  const lines = Deno.readTextFileSync(`${BUILD}/3_tagged.tsv`).split("\n").filter((l) => l.length);
  const hdr = lines[0];
  type Row = { id: string; title: string; description: string; sources: string; tags: string; occupations: string; topics: string };
  const rows: Row[] = lines.slice(1).map((l) => {
    const c = l.split("\t");
    return { id: c[0], title: c[1], description: c[2], sources: c[3], tags: c[4], occupations: c[5], topics: c[6] };
  });
  const DIM = EMBED_DIM;
  const vecs = normalizedEmbeddingsForSkills(rows.map((r) => r.id));
  const DEDUPE_COSINE = Number(Deno.env.get("DEDUPE_COSINE") ?? "0.96");

  // Antonym/modifier pairs that must NOT be merged with each other.
  // When A and B share all other tokens but one is in one group and the other is in another,
  // we treat them as distinct concepts.
  const ANTONYM_GROUPS: string[][] = [
    ["theoretical","practical","applied"],
    ["commercial","industrial","residential","military","civil","consumer"],
    ["1d","2d","3d","4d"],
    ["first","second","third","fourth","fifth"],
    ["introductory","advanced","intermediate","beginner","basic"],
    ["micro","macro","nano","mini","mega"],
    ["pre","post","anti","pro","non","sub","super"],
    ["internal","external"],
    ["public","private"],
    ["input","output"],
    ["front","back","side","top","bottom"],
    ["positive","negative","neutral"],
    ["online","offline"],
    ["qualitative","quantitative"],
    ["domestic","international","foreign"],
    ["static","dynamic"],
    ["manual","automatic","automated"],
    ["wired","wireless"],
    ["analog","digital"],
    ["primary","secondary","tertiary"],
    ["open","closed"],
    ["augmented","mixed","virtual"],
    // Pass 10 S3-1 additions
    ["ac","dc"],
    ["z","c","bash","fish","ksh","zsh"],
  ];
  const antonymGroupOf = new Map<string, number>();
  ANTONYM_GROUPS.forEach((g, gi) => g.forEach((w) => antonymGroupOf.set(w, gi)));
  const antonymClash = (titleA: string, titleB: string): boolean => {
    const tA = titleA.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const tB = titleB.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const groupsA = new Map<number, Set<string>>();
    const groupsB = new Map<number, Set<string>>();
    for (const t of tA) {
      const g = antonymGroupOf.get(t);
      if (g === undefined) continue;
      if (!groupsA.has(g)) groupsA.set(g, new Set());
      groupsA.get(g)!.add(t);
    }
    for (const t of tB) {
      const g = antonymGroupOf.get(t);
      if (g === undefined) continue;
      if (!groupsB.has(g)) groupsB.set(g, new Set());
      groupsB.get(g)!.add(t);
    }
    for (const [g, setA] of groupsA) {
      const setB = groupsB.get(g);
      if (!setB) continue;
      let sameWord = false;
      for (const w of setA) if (setB.has(w)) { sameWord = true; break; }
      if (!sameWord) return true; // different antonym word in same group
    }
    for (const [g, setB] of groupsB) {
      if (!groupsA.has(g)) continue;
      // Already handled above.
      void g; void setB;
    }
    return false;
  };

  const sourceCount = (r: Row): number => {
    if (!r.sources) return 0;
    return r.sources.split(",").filter(Boolean).length;
  };

  const parent = new Int32Array(rows.length);
  for (let i = 0; i < rows.length; i++) parent[i] = i;
  function find(i: number): number { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  // Pass 10 S3-1: token-subset guard. If one title's tokens are a strict subset
  // of the other's, the longer is a specialization (e.g. "power" vs "power-bi")
  // and should not be merged into the shorter. Blocks ui-ux-writing → writing.
  const titleTokSet = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3 && !SIG_STOP.has(w)) out.add(w);
    return out;
  };
  function union(a: number, b: number): boolean {
    const ra = find(a), rb = find(b);
    if (ra === rb) return false;
    if (antonymClash(rows[ra].title, rows[rb].title)) return false;
    const sa = sourceCount(rows[ra]);
    const sb = sourceCount(rows[rb]);
    let keep: number;
    if (sa !== sb) keep = sa > sb ? ra : rb;
    else {
      // Subset-aware tiebreak: prefer the canonical whose tokens are NOT a strict subset.
      // Falls back to shortest title when neither is a proper subset.
      const tA = titleTokSet(rows[ra].title), tB = titleTokSet(rows[rb].title);
      let aSubsetB = tA.size > 0 && tA.size < tB.size;
      for (const t of tA) if (!tB.has(t)) { aSubsetB = false; break; }
      let bSubsetA = tB.size > 0 && tB.size < tA.size;
      for (const t of tB) if (!tA.has(t)) { bSubsetA = false; break; }
      if (aSubsetB && !bSubsetA) keep = rb;
      else if (bSubsetA && !aSubsetB) keep = ra;
      else keep = rows[ra].title.length <= rows[rb].title.length ? ra : rb;
    }
    parent[keep === ra ? rb : ra] = keep;
    return true;
  }

  // Token-sort signature merge
  const SIG_STOP = new Set(["a","an","the","of","to","for","in","on","at","by","with","is","are","be","or","and","from","as","their","its","this","that","these","those"]);
  const tokenSig = (title: string): string => {
    const toks = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)
      .filter((w) => w.length >= 2 && !SIG_STOP.has(w))
      .filter((w) => w.length >= 3 || /[0-9]/.test(w));
    toks.sort();
    return toks.join(" ");
  };
  const sigBuckets = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const sig = tokenSig(rows[i].title);
    if (!sig) continue;
    const arr = sigBuckets.get(sig) ?? []; arr.push(i); sigBuckets.set(sig, arr);
  }
  let sigMerges = 0, sigBlocked = 0;
  for (const idxs of sigBuckets.values()) {
    if (idxs.length < 2) continue;
    for (let k = 1; k < idxs.length; k++) {
      if (union(idxs[0], idxs[k])) sigMerges++;
      else sigBlocked++;
    }
  }
  console.log(`[dedupe] token-sort merges: ${sigMerges} (blocked ${sigBlocked} antonym-clash)`);

  // Topic-bucket merge with jaccard + cosine
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const topic = rows[i].topics.split(",")[0] || "_notopic";
    const arr = buckets.get(topic) ?? []; arr.push(i); buckets.set(topic, arr);
  }
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
  const sigTokens = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const w of s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/))
      if (w.length >= 3 && !SIG_STOP.has(w)) out.add(w);
    return out;
  };
  const sigSets = rows.map((r) => sigTokens(r.title));

  let merged = 0, skippedHuge = 0, cosBlocked = 0;
  for (const idxs of buckets.values()) {
    if (idxs.length < 2) continue;
    if (idxs.length > 1500) { skippedHuge++; continue; }
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        if (jaccard(wordSets[idxs[a]], wordSets[idxs[b]]) < JACCARD_MIN) continue;
        const la = rows[idxs[a]].title.length, lb = rows[idxs[b]].title.length;
        if (Math.max(la, lb) / Math.max(1, Math.min(la, lb)) > 3) continue;
        const sa = sigSets[idxs[a]], sb = sigSets[idxs[b]];
        if (sa.size && sb.size) {
          let inter = 0;
          for (const t of sa) if (sb.has(t)) inter++;
          if (inter / Math.min(sa.size, sb.size) < 0.4) continue;
        }
        let sc = 0;
        const oa = idxs[a] * DIM, ob = idxs[b] * DIM;
        for (let d = 0; d < DIM; d++) sc += vecs[oa + d] * vecs[ob + d];
        if (sc < DEDUPE_COSINE) continue;
        if (union(idxs[a], idxs[b])) merged++;
        else cosBlocked++;
      }
    }
  }
  console.log(`[dedupe] cosine+jaccard merges: ${merged} (blocked ${cosBlocked} antonym, skipped ${skippedHuge} oversize buckets)`);

  const alias = new Map<string, string>();
  let survivors = 0, dropped = 0;
  for (let i = 0; i < rows.length; i++) {
    const c = find(i);
    if (c === i) survivors++;
    else { alias.set(rows[i].id, rows[c].id); dropped++; }
  }
  console.log(`[dedupe] survivors=${survivors}, dropped=${dropped}`);

  const groupBy = new Map<number, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const c = find(i);
    const arr = groupBy.get(c) ?? []; arr.push(i); groupBy.set(c, arr);
  }
  type Canon = { idx: number; occs: string[]; topics: string[]; allTags: string[] };
  const canons: Canon[] = [];
  for (const [cIdx, gIdxs] of groupBy) {
    const canonical = rows[cIdx];
    const occs = new Set<string>(), topics = new Set<string>();
    const allTags = new Set<string>(canonical.tags.split(",").filter(Boolean));
    for (const i of gIdxs) {
      for (const o of rows[i].occupations.split(",").filter(Boolean)) occs.add(o);
      for (const t of rows[i].topics.split(",").filter(Boolean)) topics.add(t);
      for (const tg of rows[i].tags.split(",").filter(Boolean)) allTags.add(tg);
    }
    canons.push({ idx: cIdx, occs: [...occs].slice(0, 3), topics: [...topics].slice(0, 3), allTags: [...allTags] });
  }

  // Backfill tags for untagged canonicals
  const BF_STOP = new Set(["a","an","the","of","to","for","in","on","and","or","with","at","by","from","as"]);
  const titleToks = (s: string): string[] =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)
      .filter((w) => w.length >= 4 && !BF_STOP.has(w));
  const tokToCanons = new Map<string, number[]>();
  for (let k = 0; k < canons.length; k++) {
    for (const tok of titleToks(rows[canons[k].idx].title)) {
      const arr = tokToCanons.get(tok) ?? []; arr.push(k); tokToCanons.set(tok, arr);
    }
  }
  let bfTopics = 0, bfOccs = 0, bfLcsh = 0;
  const BF_SIM = Number(Deno.env.get("BF_SIM") ?? "0.6");
  const BF_SIM_ZZ = Number(Deno.env.get("BF_SIM_ZERO_ZERO") ?? "0.55");
  for (let k = 0; k < canons.length; k++) {
    const c = canons[k];
    const needTopics = c.topics.length === 0, needOccs = c.occs.length === 0;
    if (!needTopics && !needOccs) continue;
    const zeroZero = needTopics && needOccs;
    const threshold = zeroZero ? BF_SIM_ZZ : BF_SIM;
    const qTit = rows[c.idx].title;
    const qToks = titleToks(qTit);
    if (!qToks.length) continue;
    const pool = new Set<number>();
    for (const tok of qToks) {
      const arr = tokToCanons.get(tok);
      if (!arr || arr.length > 2000) continue;
      for (const i of arr) if (i !== k) pool.add(i);
    }
    if (!pool.size) continue;
    const qOff = c.idx * DIM;
    const scored: [number, number][] = [];
    for (const i of pool) {
      const other = canons[i];
      if (needTopics && other.topics.length === 0 && (!needOccs || other.occs.length === 0)) continue;
      if (!needTopics && needOccs && other.occs.length === 0) continue;
      let sc = 0;
      const oOff = other.idx * DIM;
      for (let d = 0; d < DIM; d++) sc += vecs[qOff + d] * vecs[oOff + d];
      if (sc >= threshold) scored.push([i, sc]);
    }
    if (scored.length < 3) continue;
    scored.sort((a, b) => b[1] - a[1]);
    const top = scored.slice(0, 10);
    const topicVotes = new Map<string, number>(), occVotes = new Map<string, number>();
    for (const [i, w] of top) {
      for (const t of canons[i].topics) topicVotes.set(t, (topicVotes.get(t) ?? 0) + w);
      for (const o of canons[i].occs) occVotes.set(o, (occVotes.get(o) ?? 0) + w);
    }
    const pickTop = (m: Map<string, number>, minV: number, cap: number): string[] =>
      [...m.entries()].filter(([, v]) => v >= minV).sort((a, b) => b[1] - a[1]).slice(0, cap).map(([k]) => k);
    const minW = 3 * threshold;
    if (needTopics) {
      const nt = pickTop(topicVotes, minW, 3);
      if (nt.length) { c.topics = nt; bfTopics++; }
    }
    if (needOccs) {
      const no = pickTop(occVotes, minW, 2);
      if (no.length) { c.occs = no; bfOccs++; }
    }
  }

  // Last-resort topic seed from LCSH / DBpedia ancestor trees
  const lcshTree = new Map<string, string[]>();
  for (const path of [`${BUILD}/1j_lcsh_tree.tsv`, `${BUILD}/1k_dbpedia_tree.tsv`]) {
    try {
      forEachLine(path, (line) => {
        const tab = line.indexOf("\t");
        if (tab < 0) return;
        const slug = line.slice(0, tab);
        const anc = line.slice(tab + 1).split(",").filter(Boolean);
        if (slug && anc.length && !lcshTree.has(slug)) lcshTree.set(slug, anc);
      });
    } catch { /* tree not cached; skip */ }
  }
  if (lcshTree.size > 0) {
    for (const c of canons) {
      if (c.topics.length > 0) continue;
      const r = rows[c.idx];
      for (const cand of [r.id, slugify(r.title)]) {
        const anc = lcshTree.get(cand);
        if (anc && anc.length) {
          // Pass 11 T3: filter junk BEFORE slicing — was letting wiki-project/years-in-X
          // ancestors become the only topic for otherwise-untagged canonicals.
          const clean = anc.filter((a) => !isJunkTopic(a));
          if (!clean.length) continue;
          c.topics = clean.slice(0, 3);
          bfLcsh++;
          break;
        }
      }
    }
  }
  console.log(`[dedupe] backfill: topics+=${bfTopics}, occs+=${bfOccs}, lcsh-topics+=${bfLcsh}`);

  const outLines = [hdr];
  for (const c of canons) {
    const r = rows[c.idx];
    outLines.push([r.id, r.title, r.description, r.sources, c.allTags.join(","), c.occs.join(","), c.topics.join(",")].join("\t"));
  }
  Deno.writeTextFileSync(`${BUILD}/3b_tagged_deduped.tsv`, outLines.join("\n") + "\n");

  const aliasLines = ["dropped_id\tcanonical_id"];
  for (const [drop, keep] of alias) aliasLines.push(`${drop}\t${keep}`);
  Deno.writeTextFileSync(`${BUILD}/3b_aliases.tsv`, aliasLines.join("\n") + "\n");

  writeStats("3b", {
    before: rows.length,
    dropped,
    after: survivors,
    sig_merges: sigMerges,
    cosine_merges: merged,
    backfilled_topics: bfTopics,
    backfilled_occs: bfOccs,
    backfilled_topics_lcsh: bfLcsh,
  });
}

// ---------- stage difficulty ----------

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

function stageDifficulty() {
  const lines = Deno.readTextFileSync(taggedTsvPath()).split("\n").filter((l) => l.length);
  const hdr = lines[0].split("\t");
  const iTags = hdr.indexOf("tags"), iSources = hdr.indexOf("sources"), iTopics = hdr.indexOf("topics");
  const skills = lines.slice(1).map((l) => {
    const c = l.split("\t");
    return { id: c[0], title: c[1], sources: c[iSources], tags: c[iTags], topics: c[iTopics] };
  });
  const DIM = EMBED_DIM;
  const vecs = normalizedEmbeddingsForSkills(skills.map((s) => s.id));

  const anchor = new Float32Array(skills.length);
  anchor.fill(Number.NaN);
  let gradeAnchored = 0, khanAnchored = 0;
  for (let i = 0; i < skills.length; i++) {
    const grades: number[] = [];
    for (const m of skills[i].tags.matchAll(/grade:([^,]+)/g)) {
      for (const part of m[1].split(".")) {
        const d = gradeToDifficulty(part);
        if (d !== null) grades.push(d);
      }
    }
    if (grades.length) {
      // Pass 13 CR3: use Math.min (first-teachable) rather than Math.max.
      // Wide-grade-span skills (e.g. "grade 3-12") were anchoring at grade 12.
      anchor[i] = Math.min(...grades);
      gradeAnchored++;
    }
  }
  try {
    const lines = Deno.readTextFileSync("data/khanacademy/khandata.tsv").split("\n").filter((l) => l.length);
    const h = lines[0].split("\t");
    const iN = h.indexOf("Data Name"), iD = h.indexOf("Display Name"), iV = h.indexOf("V-Position");
    // Build the richer skill index (title + slug + id) once for resolveConcept-style matching.
    const idSet = new Set<string>();
    const titleToId = new Map<string, string>();
    const slugToId = new Map<string, string>();
    const idToIdx = new Map<string, number>();
    for (let i = 0; i < skills.length; i++) {
      idSet.add(skills[i].id);
      idToIdx.set(skills[i].id, i);
      const t = (skills[i].title || "").toLowerCase().trim();
      if (t && !titleToId.has(t)) titleToId.set(t, skills[i].id);
      slugToId.set(skills[i].id, skills[i].id);
      const altSlug = slugify(skills[i].title || "");
      if (altSlug && !slugToId.has(altSlug)) slugToId.set(altSlug, skills[i].id);
    }
    const kidx = { idSet, titleToId, slugToId };
    const labelsV: [string, number][] = [];
    let vMin = Infinity, vMax = -Infinity;
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split("\t");
      const v = Number(c[iV]);
      if (!Number.isFinite(v)) continue;
      vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
      if (c[iN]) labelsV.push([c[iN], v]);
      if (c[iD]) labelsV.push([c[iD], v]);
    }
    if (vMax > vMin) {
      const seen = new Set<string>();
      for (const [lbl, v] of labelsV) {
        const id = resolveConcept(lbl, kidx);
        if (!id || seen.has(id)) continue;
        const i = idToIdx.get(id);
        if (i === undefined || !Number.isNaN(anchor[i])) continue;
        anchor[i] = (v - vMin) / (vMax - vMin) * 12;
        khanAnchored++;
        seen.add(id);
      }
    }
  } catch (e) { console.warn(`[difficulty] WARN: Khan anchors unavailable — ${(e as Error).message}`); }

  let zoneAnchored = 0;
  try {
    const zoneRows = parseTsv(Deno.readTextFileSync("data/onet/Job Zones.txt"));
    const zh = zoneRows[0];
    const iZs = zh.indexOf("O*NET-SOC Code"), iZz = zh.indexOf("Job Zone");
    const socToZone = new Map<string, number>();
    for (let i = 1; i < zoneRows.length; i++) {
      const soc = zoneRows[i][iZs], z = Number(zoneRows[i][iZz]);
      if (soc && Number.isFinite(z) && z >= 1 && z <= 5) socToZone.set(soc, z);
    }
    const cmr = new Map<string, string>();
    for (const r of parseTsv(Deno.readTextFileSync("data/onet/Content Model Reference.txt")).slice(1))
      if (r[0] && r[1]) cmr.set(r[0], r[1]);
    const skillZoneSum = new Map<string, { w: number; wz: number }>();
    for (const fname of ["Skills.txt", "Knowledge.txt", "Abilities.txt"]) {
      const rows = parseTsv(Deno.readTextFileSync(`data/onet/${fname}`));
      const h = rows[0];
      const iS = h.indexOf("O*NET-SOC Code"), iE = h.indexOf("Element ID"),
            iSc = h.indexOf("Scale ID"), iV = h.indexOf("Data Value");
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][iSc] !== "IM") continue;
        const name = cmr.get(rows[i][iE]);
        const zone = socToZone.get(rows[i][iS]);
        if (!name || zone === undefined) continue;
        const w = Number(rows[i][iV]);
        if (!Number.isFinite(w) || w <= 0) continue;
        const key = slugify(name);
        const e = skillZoneSum.get(key) ?? { w: 0, wz: 0 };
        e.w += w; e.wz += w * zone;
        skillZoneSum.set(key, e);
      }
    }
    // O*NET Tasks: each task statement is linked to exactly one SOC, so we can
    // anchor each task directly via its SOC's zone. Same for DWAs via Task→DWA.
    const taskSocByTid = new Map<string, string>();
    const taskTextByTid = new Map<string, string>();
    {
      const rows = parseTsv(Deno.readTextFileSync("data/onet/Task Statements.txt"));
      const h = rows[0];
      const iS = h.indexOf("O*NET-SOC Code"), iTid = h.indexOf("Task ID"), iTask = h.indexOf("Task");
      for (let i = 1; i < rows.length; i++) {
        const tid = rows[i][iTid], task = rows[i][iTask], soc = rows[i][iS];
        if (!tid || !task || !soc) continue;
        if (!taskSocByTid.has(tid)) { taskSocByTid.set(tid, soc); taskTextByTid.set(tid, task); }
        const key = slugify(task);
        const zone = socToZone.get(soc);
        if (zone === undefined) continue;
        const e = skillZoneSum.get(key) ?? { w: 0, wz: 0 };
        e.w += 1; e.wz += zone;
        skillZoneSum.set(key, e);
      }
    }
    try {
      const dwaTitle = new Map<string, string>();
      for (const r of parseTsv(Deno.readTextFileSync("data/onet/DWA Reference.txt")).slice(1))
        if (r[0] && r[1]) dwaTitle.set(r[0] || "", r[1] || "");
      const t2d = parseTsv(Deno.readTextFileSync("data/onet/Tasks to DWAs.txt"));
      const h = t2d[0];
      const iTid = h.indexOf("Task ID"), iDid = h.indexOf("DWA ID");
      for (let i = 1; i < t2d.length; i++) {
        const tid = t2d[i][iTid], did = t2d[i][iDid];
        const title = dwaTitle.get(did);
        const soc = taskSocByTid.get(tid);
        if (!title || !soc) continue;
        const zone = socToZone.get(soc);
        if (zone === undefined) continue;
        const key = slugify(title);
        const e = skillZoneSum.get(key) ?? { w: 0, wz: 0 };
        e.w += 1; e.wz += zone;
        skillZoneSum.set(key, e);
      }
    } catch (e) { console.warn(`[difficulty] WARN: DWA zone mapping skipped — ${(e as Error).message}`); }

    const idToIdx = new Map<string, number>();
    for (let i = 0; i < skills.length; i++) idToIdx.set(skills[i].id, i);
    for (const [key, { w, wz }] of skillZoneSum) {
      const i = idToIdx.get(key);
      if (i === undefined || !Number.isNaN(anchor[i])) continue;
      anchor[i] = 11.5 + 1.5 * (wz / w);
      zoneAnchored++;
    }
  } catch (e) { console.warn(`[difficulty] WARN: Job Zone anchors unavailable — ${(e as Error).message}`); }

  const anchorIdxs: number[] = [];
  for (let i = 0; i < skills.length; i++) if (!Number.isNaN(anchor[i])) anchorIdxs.push(i);
  console.log(`[difficulty] anchors: grade=${gradeAnchored}, khan=${khanAnchored}, zone=${zoneAnchored}, total=${anchorIdxs.length}`);

  const K = Number(Deno.env.get("KNN_K") ?? "15");
  const t0 = performance.now();
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

  const candidates = (i: number): number[] => {
    const seen = new Set<number>();
    for (const topic of skills[i].topics.split(",")) {
      if (!topic) continue;
      const arr = topicToAnchors.get(topic);
      if (arr) for (const a of arr) seen.add(a);
    }
    return seen.size ? [...seen] : [];
  };
  let out: Float32Array;
  try {
    const cached = Deno.readFileSync(`${BUILD}/4_raw.bin`);
    if (cached.byteLength === skills.length * 4) {
      out = new Float32Array(cached.buffer, cached.byteOffset, skills.length);
      console.log(`[difficulty] loaded cached raw scores`);
    } else throw new Error("size mismatch");
  } catch {
    out = new Float32Array(skills.length);
  }
  let withinTopic = 0, globalFallback = 0;
  if (out.every((v) => v === 0)) {
    const anchorMat = new Float32Array(anchorIdxs.length * DIM);
    const anchorDiff = new Float32Array(anchorIdxs.length);
    for (let a = 0; a < anchorIdxs.length; a++) {
      anchorMat.set(vecs.subarray(anchorIdxs[a] * DIM, (anchorIdxs[a] + 1) * DIM), a * DIM);
      anchorDiff[a] = anchor[anchorIdxs[a]];
    }
    for (let i = 0; i < skills.length; i++) {
      const sOff = i * DIM;
      const top: { score: number; a: number }[] = [];
      let pool: number[] | null = candidates(i);
      if (!pool.length) pool = null;
      if (pool) withinTopic++; else globalFallback++;
      const n = pool ? pool.length : anchorIdxs.length;
      for (let k = 0; k < n; k++) {
        const a = pool ? pool[k] : k;
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
      let num = 0, den = 0;
      for (const { score, a } of top) {
        const w = Math.max(0, score) ** 2;
        num += w * anchorDiff[a];
        den += w;
      }
      out[i] = den > 0 ? num / den : (Number.isNaN(anchor[i]) ? 10 : anchor[i]);
      if ((i + 1) % 5000 === 0) console.log(`  ${i + 1}/${skills.length}`);
    }
  }

  const SMOOTH_W = Number(Deno.env.get("SMOOTH_W") ?? "0.3");
  const smoothed = new Float32Array(out);
  if (SMOOTH_W > 0) {
    const topicSum = new Map<string, { sum: number; n: number }>();
    for (let i = 0; i < skills.length; i++) {
      for (const t of skills[i].topics.split(",")) {
        if (!t) continue;
        const e = topicSum.get(t) ?? { sum: 0, n: 0 };
        e.sum += out[i]; e.n++; topicSum.set(t, e);
      }
    }
    for (let i = 0; i < skills.length; i++) {
      let sum = 0, n = 0;
      for (const t of skills[i].topics.split(",")) {
        if (!t) continue;
        const e = topicSum.get(t);
        if (!e || e.n < 3) continue;
        sum += (e.sum - out[i]) / (e.n - 1);
        n++;
      }
      if (n > 0) smoothed[i] = (1 - SMOOTH_W) * out[i] + SMOOTH_W * (sum / n);
    }
  }

  const jittered = new Float32Array(skills.length);
  for (let i = 0; i < skills.length; i++) {
    let h = 0;
    for (let k = 0; k < skills[i].id.length; k++) h = ((h * 31) + skills[i].id.charCodeAt(k)) | 0;
    jittered[i] = smoothed[i] + (((h >>> 0) % 1000) / 1000 - 0.5) * 0.001;
  }

  // Isotonic PAV
  const pairs: [number, number][] = [];
  for (const ai of anchorIdxs) pairs.push([jittered[ai], anchor[ai]]);
  pairs.sort((a, b) => a[0] - b[0]);
  type PavNode = { x: number; y: number; w: number };
  const pav: PavNode[] = [];
  for (const [x, y] of pairs) {
    let cur: PavNode = { x, y, w: 1 };
    while (pav.length && pav[pav.length - 1].y > cur.y) {
      const prev = pav.pop()!;
      cur = { x: prev.x, y: (prev.y * prev.w + cur.y * cur.w) / (prev.w + cur.w), w: prev.w + cur.w };
    }
    pav.push(cur);
  }
  const pavX = pav.map((p) => p.x), pavY = pav.map((p) => p.y);
  const tailStart = Math.max(0, pavX.length - Math.max(2, Math.floor(pavX.length * 0.1)));
  const tailDX = pavX[pavX.length - 1] - pavX[tailStart];
  const tailDY = pavY[pavY.length - 1] - pavY[tailStart];
  const tailSlope = tailDX > 0 ? tailDY / tailDX : 0.5;
  const calibrate = (raw: number): number => {
    if (pavX.length === 0) return raw;
    if (raw <= pavX[0]) return pavY[0];
    if (raw >= pavX[pavX.length - 1]) return pavY[pavY.length - 1] + tailSlope * (raw - pavX[pavX.length - 1]);
    let lo = 0, hi = pavX.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (pavX[mid] <= raw) lo = mid; else hi = mid;
    }
    const span = pavX[hi] - pavX[lo];
    const t = span > 0 ? (raw - pavX[lo]) / span : 0;
    return pavY[lo] + t * (pavY[hi] - pavY[lo]);
  };
  const calibrated = new Float32Array(skills.length);
  for (let i = 0; i < skills.length; i++) {
    const c = calibrate(jittered[i]);
    if (!Number.isFinite(c)) {
      throw new Error(`[difficulty] non-finite calibrated value for ${skills[i].id} (raw=${out[i]}, smoothed=${smoothed[i]}, jittered=${jittered[i]})`);
    }
    calibrated[i] = c;
  }

  // Pass 16 DR2: seed-edge anchoring.
  // When src → dst is a seed (src is prereq of dst), require raw[src] < raw[dst].
  // 25.9% of seeds were reversed in band space because AL-CPL/MOOCx concepts land
  // in the crowded professional plateau. Pull the prereq down 1.0 below the dependent.
  let seedAnchorAdjusted = 0;
  try {
    const idToIdx = new Map<string, number>();
    for (let i = 0; i < skills.length; i++) idToIdx.set(skills[i].id, i);
    const alias = loadAliasesCollapsed();
    const seedLines = Deno.readTextFileSync(`${BUILD}/1e_seed_edges.tsv`).split("\n").filter((l) => l.length).slice(1);
    for (const line of seedLines) {
      const c = line.split("\t");
      if (c[4] === "1") continue; // skip holdout seeds
      const src = alias.get(c[0]) ?? c[0];
      const dst = alias.get(c[1]) ?? c[1];
      const si = idToIdx.get(src), di = idToIdx.get(dst);
      if (si === undefined || di === undefined) continue;
      if (out[si] >= out[di]) {
        out[si] = out[di] - 1.0;
        seedAnchorAdjusted++;
      }
    }
    if (seedAnchorAdjusted > 0) {
      console.log(`[difficulty] seed-anchored ${seedAnchorAdjusted} prereqs below their dependents`);
      // Re-run calibration on adjusted raws
      for (let i = 0; i < skills.length; i++) {
        const c = calibrate(out[i] + (jittered[i] - out[i])); // preserve jitter
        if (Number.isFinite(c)) calibrated[i] = c;
      }
    }
  } catch { /* no seeds available */ }

  const band = new Int32Array(skills.length);
  const bandCounts = new Array(20).fill(0);
  let healthCapped = 0;
  for (let i = 0; i < skills.length; i++) {
    let b = Math.max(1, Math.min(20, Math.round(calibrated[i]) + 1));
    // Pass 10 S4-3: K-12 health/science concepts with grade anchor ≤12
    // should not exceed band 13 regardless of kNN pull from medical O*NET neighbors.
    if (!Number.isNaN(anchor[i])) {
      const anchorBand = Math.round(anchor[i]) + 1;
      if (anchorBand <= 13 && b > 13) { b = 13; healthCapped++; }
    }
    if (!Number.isInteger(b) || b < 1 || b > 20) {
      throw new Error(`[difficulty] bad band for ${skills[i].id}: ${b} (calibrated=${calibrated[i]})`);
    }
    band[i] = b;
    bandCounts[b - 1]++;
  }
  if (healthCapped > 0) console.log(`[difficulty] K-12 anchor band cap applied to ${healthCapped} skills`);

  const rows = ["id\tdifficulty\tdifficulty_raw"];
  for (let i = 0; i < skills.length; i++) rows.push(`${skills[i].id}\t${band[i]}\t${out[i].toFixed(4)}`);
  Deno.writeTextFileSync(`${BUILD}/4_difficulty.tsv`, rows.join("\n") + "\n");
  Deno.writeFileSync(`${BUILD}/4_raw.bin`, new Uint8Array(out.buffer));

  // Kendall-τ vs anchors
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

  // Grade-vs-band inversion audit: direct grade-anchored skills should have
  // a band close to the grade anchor. >5 bands off signals calibration
  // pathology (e.g. grade-1 skill landing at band 17).
  let gradeAnchoredSkills = 0, inversions = 0, worstInversion = 0;
  const invSamples: string[] = [];
  for (let i = 0; i < skills.length; i++) {
    const grades: number[] = [];
    for (const m of skills[i].tags.matchAll(/grade:([^,]+)/g)) {
      for (const part of m[1].split(".")) {
        const d = gradeToDifficulty(part);
        if (d !== null) grades.push(d);
      }
    }
    if (!grades.length) continue;
    gradeAnchoredSkills++;
    const anchorBand = Math.round(Math.max(...grades)) + 1;
    const gap = Math.abs(band[i] - anchorBand);
    if (gap > 5) {
      inversions++;
      worstInversion = Math.max(worstInversion, gap);
      if (invSamples.length < 10) invSamples.push(`${skills[i].id}: grade→${anchorBand}, band=${band[i]}`);
    }
  }
  if (inversions > 0) console.warn(`[difficulty] ${inversions} grade-vs-band inversions (>5 gap) out of ${gradeAnchoredSkills}; worst gap=${worstInversion}`);

  writeStats(4, {
    skills: skills.length,
    anchors: { grade: gradeAnchored, khan: khanAnchored, zone: zoneAnchored, total: anchorIdxs.length },
    within_topic: withinTopic,
    global_fallbacks: globalFallback,
    band_distribution: bandCounts,
    kendall_tau_vs_anchor: tau,
    grade_anchored_skills: gradeAnchoredSkills,
    grade_band_inversions: inversions,
    grade_band_worst_gap: worstInversion,
    grade_band_inversion_samples: invSamples,
    total_seconds: (performance.now() - t0) / 1000,
  });
}

// ---------- stage prereq ----------

const PREREQ_CANDIDATES_CACHE = `${BUILD}/5_candidates.tsv`;
const PREREQ_CACHE = `${BUILD}/5_prereqs.tsv`;

type SkillWithDiff = {
  id: string;
  title: string;
  description: string;
  topics: string;
  occupations: string;
  sources: string;
  tags: string;
  gradeStart: number; // -2 = unknown
  gradeEnd: number;   // -2 = unknown
};

function parseSkillsWithDifficulty(): { skills: SkillWithDiff[]; diff: Int32Array; raw: Float32Array } {
  const tagged = Deno.readTextFileSync(taggedTsvPath()).split("\n").filter((l) => l.length);
  const h = tagged[0].split("\t");
  const iT = h.indexOf("title"), iD = h.indexOf("description"), iTp = h.indexOf("topics"), iOc = h.indexOf("occupations");
  const iS = h.indexOf("sources"), iTg = h.indexOf("tags");
  const skills: SkillWithDiff[] = tagged.slice(1).map((l) => {
    const c = l.split("\t");
    const tags = iTg >= 0 ? (c[iTg] || "") : "";
    let gs = Infinity, ge = -Infinity;
    for (const m of tags.matchAll(/grade:([A-Za-z0-9-]+)/g)) {
      const d = gradeToDifficulty(m[1]);
      if (d !== null) { gs = Math.min(gs, d); ge = Math.max(ge, d); }
    }
    return {
      id: c[0], title: c[iT], description: c[iD],
      topics: c[iTp], occupations: iOc >= 0 ? (c[iOc] || "") : "",
      sources: iS >= 0 ? (c[iS] || "") : "",
      tags,
      gradeStart: Number.isFinite(gs) ? gs : -2,
      gradeEnd: Number.isFinite(ge) ? ge : -2,
    };
  });
  const dLines = Deno.readTextFileSync(`${BUILD}/4_difficulty.tsv`).split("\n").filter((l) => l.length).slice(1);
  const dm = new Map<string, { band: number; raw: number }>();
  for (const l of dLines) { const c = l.split("\t"); dm.set(c[0], { band: Number(c[1]), raw: Number(c[2]) }); }
  const diff = new Int32Array(skills.length);
  const raw = new Float32Array(skills.length);
  for (let i = 0; i < skills.length; i++) {
    const e = dm.get(skills[i].id);
    if (!e) throw new Error(`no difficulty for ${skills[i].id}`);
    diff[i] = e.band;
    raw[i] = e.raw;
  }
  return { skills, diff, raw };
}

// Pass 9 R6: language-family mutual exclusion for candidate pool.
const LANG_TOKENS = [
  "spanish","french","german","italian","portuguese","chinese","japanese",
  "greek","latin","arabic","korean","russian","hebrew","swazi","kanuri","pulaar",
];
function langTokenOf(id: string): string | null {
  for (const t of LANG_TOKENS) {
    if (id === t || id.startsWith(`${t}-`) || id.includes(`-${t}-`) || id.endsWith(`-${t}`)) return t;
  }
  return null;
}

// Pass 9 R4: study/meta-skill denylist for candidate pool.
const STUDY_SKILL_RE = /^(take[- ]notes?|mental[- ]concentration|find[- ]a[- ]dedicated|test[- ]anxiety|time[- ]management|study[- ]space|ask[- ]for[- ]help)/i;

// Cross-domain foundation whitelist — these are cross-domain prereqs we want to
// preserve in within-topic shared-token guards (R3). Mirrors the postproc FOUNDATION set.
const FOUNDATION_IDS = new Set([
  "mathematics","math","arithmetic","reading","writing","literacy","numeracy",
  "problem-solving","critical-thinking","research","communication","algebra",
  "geometry","statistics","probability",
]);

function loadPathologicalIds(): Set<string> {
  try {
    const t = Deno.readTextFileSync(`${BUILD}/2_pathological.tsv`);
    return new Set(t.split("\n").filter((l) => l.length));
  } catch { return new Set(); }
}

function computePrereqCandidates(): Map<string, number[]> {
  const { skills, raw } = parseSkillsWithDifficulty();
  const DIM = EMBED_DIM;
  const vecs = normalizedEmbeddingsForSkills(skills.map((s) => s.id));
  const topicIdx = new Map<string, number[]>();
  for (let i = 0; i < skills.length; i++) {
    for (const t of skills[i].topics.split(",")) {
      if (!t) continue;
      let arr = topicIdx.get(t);
      if (!arr) { arr = []; topicIdx.set(t, arr); }
      arr.push(i);
    }
  }
  const pathological = loadPathologicalIds();
  const K = Number(Deno.env.get("PREREQ_K") ?? "15");
  // Pass 16 DR1: raise from 0.3 to 1.5 — at 0.3, 23% of picks were reversed difficulty.
  const MIN_DIFF = Number(Deno.env.get("PREREQ_MIN_DIFF_DELTA") ?? "1.5");
  const ANCESTOR_K = Number(Deno.env.get("PREREQ_ANCESTOR_K") ?? "5");
  const GLOBAL_K = Number(Deno.env.get("PREREQ_GLOBAL_K") ?? "5");
  // Pass 10 S5-2: raise min token length 5 → 7 to kill weak-connector matches
  // (e.g. "prepar" linking prepare-medication to prepare-pasta).
  const TOK_MIN = 7;
  // Pass 11 H2: framework-only skills (only topic from LCSH/DBpedia framework slugs)
  // get excluded from the global-pool fallback — they become phantom hubs otherwise.
  const frameworkOnly = new Uint8Array(skills.length);
  const FRAME_RE = /-standards|^sced-|-\d{4}|framework|curriculum|scope-and-sequence/;
  for (let i = 0; i < skills.length; i++) {
    const topics = skills[i].topics.split(",").filter(Boolean);
    if (topics.length === 0) frameworkOnly[i] = 1;
    else if (topics.every((t) => FRAME_RE.test(t))) frameworkOnly[i] = 1;
  }
  // Precompute per-skill grade caps and filter flags
  const slugLangs = skills.map((s) => langTokenOf(s.id));
  const isSced = skills.map((s) => s.tags.includes("sced:catalog") && !/\b(esco|onet|lightcast)\b/.test(s.sources));
  const isStudyMeta = skills.map((s) => STUDY_SKILL_RE.test(s.id));
  const topQuintileRaw = (() => {
    const sorted = [...raw].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.8)] ?? Infinity;
  })();

  // R2 grade-gap filter: target grade_start>=6 (diff>=7) rejects candidate grade_end<=2 (diff<=3)
  const gradeGapReject = (i: number, j: number): boolean => {
    const ts = skills[i].gradeStart, ce = skills[j].gradeEnd;
    return ts >= 7 && ce !== -2 && ce <= 3;
  };

  const candOk = (i: number, j: number): boolean => {
    if (i === j) return false;
    if (pathological.has(skills[j].id)) return false;
    if (isSced[j]) return false;              // R1
    if (isStudyMeta[j] && !isStudyMeta[i]) return false; // R4
    const lj = slugLangs[j];
    if (lj && slugLangs[i] && lj !== slugLangs[i]) return false; // R6
    if (gradeGapReject(i, j)) return false;   // R2
    return raw[j] < raw[i] - MIN_DIFF;        // DR1 hard guard
  };

  const out = new Map<string, number[]>();
  const outLines: string[] = [];
  const t0 = performance.now();
  for (let i = 0; i < skills.length; i++) {
    const topics = skills[i].topics.split(",").filter(Boolean);
    const occsI = skills[i].occupations.split(",").filter(Boolean);
    const myOccs = new Set<string>(occsI);
    const myToks = new Set<string>();
    for (const t of topics) for (const tok of t.split("-")) if (tok.length >= TOK_MIN) myToks.add(tok);

    // R3 within-topic shared-token guard: candidate must share ≥1 topic token,
    // OR share an occupation, OR be in FOUNDATION_IDS.
    const withinTopicOk = (j: number): boolean => {
      if (FOUNDATION_IDS.has(skills[j].id)) return true;
      for (const oc of skills[j].occupations.split(",")) if (oc && myOccs.has(oc)) return true;
      for (const tok of skills[j].id.split("-")) if (tok.length >= TOK_MIN && myToks.has(tok)) return true;
      for (const t of skills[j].topics.split(",")) {
        for (const tok of t.split("-")) if (tok.length >= TOK_MIN && myToks.has(tok)) return true;
      }
      return false;
    };

    const pool = new Set<number>();
    for (const t of topics) {
      const arr = topicIdx.get(t);
      if (!arr) continue;
      for (const j of arr) if (candOk(i, j) && withinTopicOk(j)) pool.add(j);
    }
    let cands: number[];
    if (pool.size >= K) cands = [...pool];
    else if (skills[i].sources.split(",").filter(Boolean).length >= 2 && pool.size < 3) {
      // M1: multi-source skill with sparse pool — skip global fallback, let LLM say "none"
      cands = [...pool];
    } else {
      cands = [];
      for (let j = 0; j < skills.length; j++) if (candOk(i, j)) cands.push(j);
    }

    // Ancestor candidates — foundations within same topic (or expanded for advanced skills)
    const ancestorSet = new Set<number>();
    // R9/R10: top-quintile OR specialized-tool skills get relaxed ancestor MIN_DIFF (0.1 vs 1.5)
    const isSpecialized = skills[i].sources.includes("lightcast") && /specialized-skill|-package$|-framework$|-library$|-middleware$|-software$/.test(skills[i].id + "|" + skills[i].tags);
    const ancestorMin = (raw[i] >= topQuintileRaw || isSpecialized) ? 0.1 : 2;
    if (topics.length > 0 && ANCESTOR_K > 0) {
      const aMax = raw[i] - ancestorMin;
      for (const t of topics) {
        const arr = topicIdx.get(t);
        if (!arr) continue;
        const sorted = [...arr].sort((a, b) => raw[a] - raw[b]);
        for (let k = 0; k < sorted.length && ancestorSet.size < ANCESTOR_K; k++) {
          const j = sorted[k];
          if (raw[j] > aMax) break;
          if (!candOk(i, j)) continue;
          ancestorSet.add(j);
        }
        if (ancestorSet.size >= ANCESTOR_K) break;
      }
    }

    const sOff = i * DIM;
    const top: { idx: number; score: number }[] = [];
    const globalTop: { idx: number; score: number }[] = [];
    const inTopicSlots = Math.max(1, K - ancestorSet.size - GLOBAL_K);
    for (const j of cands) {
      if (ancestorSet.has(j)) continue;
      let sc = 0;
      const aOff = j * DIM;
      for (let d = 0; d < DIM; d++) sc += vecs[sOff + d] * vecs[aOff + d];
      if (top.length < inTopicSlots) {
        top.push({ idx: j, score: sc });
        if (top.length === inTopicSlots) top.sort((a, b) => a.score - b.score);
      } else if (sc > top[0].score) {
        top[0] = { idx: j, score: sc };
        top.sort((a, b) => a.score - b.score);
      }
    }
    top.sort((a, b) => b.score - a.score);
    const picked = new Set<number>([...ancestorSet, ...top.map((t) => t.idx), i]);
    if (GLOBAL_K > 0 && (topics.length > 0 || skills[i].occupations)) {
      const crossPool = new Set<number>();
      for (const [ot, oi] of topicIdx) {
        let shared = false;
        for (const tok of ot.split("-")) if (tok.length >= TOK_MIN && myToks.has(tok)) { shared = true; break; }
        if (!shared) continue;
        for (const j of oi) crossPool.add(j);
      }
      for (const j of crossPool) {
        if (picked.has(j)) continue;
        if (!candOk(i, j)) continue;
        if (frameworkOnly[j]) continue; // H2: framework-only skills never enter global pool
        if (myOccs.size) {
          let occShared = false;
          for (const o of skills[j].occupations.split(",")) if (o && myOccs.has(o)) { occShared = true; break; }
          if (!occShared) {
            let tokShared = 0;
            for (const t of skills[j].topics.split(",")) {
              for (const tok of t.split("-")) {
                if (tok.length >= TOK_MIN && myToks.has(tok)) { tokShared++; break; }
              }
              if (tokShared >= 2) break;
            }
            if (tokShared < 2) continue;
          }
        } else {
          let tokShared = 0;
          for (const t of skills[j].topics.split(",")) {
            for (const tok of t.split("-")) {
              if (tok.length >= TOK_MIN && myToks.has(tok)) { tokShared++; break; }
            }
            if (tokShared >= 2) break;
          }
          if (tokShared < 2) continue;
        }
        let sc = 0;
        const aOff = j * DIM;
        for (let d = 0; d < DIM; d++) sc += vecs[sOff + d] * vecs[aOff + d];
        if (globalTop.length < GLOBAL_K) {
          globalTop.push({ idx: j, score: sc });
          if (globalTop.length === GLOBAL_K) globalTop.sort((a, b) => a.score - b.score);
        } else if (sc > globalTop[0].score) {
          globalTop[0] = { idx: j, score: sc };
          globalTop.sort((a, b) => a.score - b.score);
        }
      }
      globalTop.sort((a, b) => b.score - a.score);
    }

    // S5-3: near-duplicate cluster dedup — if >2 candidates have pairwise cosine ≥0.97,
    // keep only the highest-scoring. Prevents identical K-grade standards flooding slots.
    const allPicks: { idx: number; score: number; src: "anc" | "top" | "global" }[] = [
      ...[...ancestorSet].map((idx) => ({ idx, score: 0, src: "anc" as const })),
      ...top.map((t) => ({ ...t, src: "top" as const })),
      ...globalTop.map((t) => ({ ...t, src: "global" as const })),
    ];
    const DUP_COS = 0.97;
    const dropped = new Set<number>();
    for (let a = 0; a < allPicks.length; a++) {
      if (dropped.has(a)) continue;
      const aIdx = allPicks[a].idx;
      const aOff = aIdx * DIM;
      for (let b = a + 1; b < allPicks.length; b++) {
        if (dropped.has(b)) continue;
        const bIdx = allPicks[b].idx;
        const bOff = bIdx * DIM;
        let sc = 0;
        for (let d = 0; d < DIM; d++) sc += vecs[aOff + d] * vecs[bOff + d];
        if (sc >= DUP_COS) {
          // keep higher-scoring (or lower index for ancestors — score 0)
          if (allPicks[a].score >= allPicks[b].score) dropped.add(b);
          else { dropped.add(a); break; }
        }
      }
    }
    const kept = allPicks.filter((_, k) => !dropped.has(k));
    const idxs = kept.map((p) => p.idx).slice(0, K);
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

function loadPrereqCandidates(): Map<string, number[]> {
  try {
    const text = Deno.readTextFileSync(PREREQ_CANDIDATES_CACHE);
    const m = new Map<string, number[]>();
    for (const line of text.split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const id = line.slice(0, tab);
      const rest = line.slice(tab + 1);
      m.set(id, rest ? rest.split(",").map(Number).filter(Number.isFinite) : []);
    }
    return m;
  } catch { return new Map(); }
}

const PREREQ_PROMPT = `You identify true prerequisites for a skill. Given a skill and a numbered list of candidate prerequisites (all from easier/earlier material), return the numbers of candidates that MUST be understood first before learning the skill. Be strict — only include genuinely foundational dependencies, not merely related or adjacent topics. Return ONLY a comma-separated list of numbers (e.g. "2,5,9") or the word "none". No explanation.`;

const PREREQ_PICK_CAP = Number(Deno.env.get("PREREQ_PICK_CAP") ?? "8");

function parsePrereqResponse(text: string, n: number): number[] {
  const t = text.trim().toLowerCase();
  if (t === "none" || t === "" || t === "n/a") return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const m of t.matchAll(/\d+/g)) {
    const k = Number(m[0]);
    if (k >= 1 && k <= n && !seen.has(k)) {
      seen.add(k);
      out.push(k - 1);
    }
  }
  return out.slice(0, PREREQ_PICK_CAP);
}

async function stagePrereq() {
  const { skills } = parseSkillsWithDifficulty();
  let candidates = loadPrereqCandidates();
  if (candidates.size !== skills.length) {
    console.log(`[prereq] computing candidates for ${skills.length} skills`);
    candidates = computePrereqCandidates();
  } else {
    console.log(`[prereq] loaded ${candidates.size} cached candidate lists`);
  }

  if (Deno.env.get("SKIP_LLM") === "1") {
    console.log("[prereq] SKIP_LLM=1: using existing cache only");
  } else {
    const localCache = new Set<string>();
    try {
      for (const line of Deno.readTextFileSync(PREREQ_CACHE).split("\n")) {
        if (!line) continue;
        const tab = line.indexOf("\t");
        if (tab > 0) localCache.add(line.slice(0, tab));
      }
    } catch { /* fresh */ }
    const skillOrder = skills.map((s) => s.id);
    type Job = { id: string; title: string; description: string; candTitles: string[]; candIdxs: number[] };
    const todo: Job[] = [];
    for (let i = 0; i < skills.length; i++) {
      const s = skills[i];
      if (localCache.has(s.id)) continue;
      const cands = candidates.get(s.id);
      if (!cands || cands.length === 0) continue;
      todo.push({ id: s.id, title: s.title, description: s.description,
        candTitles: cands.map((j) => skills[j].title), candIdxs: cands });
    }
    console.log(`[prereq] cached=${localCache.size} todo=${todo.length}`);
    if (todo.length) {
      const CONCURRENCY = Number(Deno.env.get("OLLAMA_CONCURRENCY") ?? "4");
      const LIMIT = Deno.env.get("OLLAMA_LIMIT") ? Number(Deno.env.get("OLLAMA_LIMIT")) : todo.length;
      const queue = todo.slice(0, LIMIT);
      const fh = Deno.openSync(PREREQ_CACHE, { create: true, append: true });
      const enc = new TextEncoder();
      const t0 = performance.now();
      let done = 0, errs = 0;
      async function worker() {
        while (queue.length) {
          const item = queue.shift();
          if (!item) break;
          const desc = item.description ? `\nDescription: ${item.description.slice(0, 200)}` : "";
          const cands = item.candTitles.map((t, i) => `${i + 1}. ${t}`).join("\n");
          const prompt = `${PREREQ_PROMPT}\n\nSkill: ${item.title}${desc}\n\nCandidates:\n${cands}\n\nPrerequisite numbers (or "none"):`;
          try {
            const raw = await generateOne(prompt, 600);
            const picks = parsePrereqResponse(raw, item.candTitles.length);
            const resolved = picks.map((p) => skillOrder[item.candIdxs[p]]).filter(Boolean).join(",");
            fh.writeSync(enc.encode(`${item.id}\t${resolved}\n`));
          } catch (e) {
            errs++;
            if (errs < 5) console.warn(`[prereq] err ${item.id}: ${(e as Error).message.slice(0, 80)}`);
          }
          done++;
          if (done % 100 === 0) {
            const dt = (performance.now() - t0) / 1000;
            const rate = done / dt;
            console.log(`  ${done}/${LIMIT} (${rate.toFixed(1)}/s, eta ${(queue.length / rate / 60).toFixed(1)}min, errs=${errs})`);
          }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      fh.close();
      console.log(`[prereq] done ${done} in ${((performance.now() - t0) / 1000).toFixed(0)}s, errs=${errs}`);
    }
  }

  // Write 5_edges.tsv
  const cacheFinal = new Map<string, string>();
  try {
    for (const line of Deno.readTextFileSync(PREREQ_CACHE).split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      cacheFinal.set(line.slice(0, tab), line.slice(tab + 1));
    }
  } catch { /* none */ }
  const skillIds = new Set(skills.map((s) => s.id));
  const fh = Deno.openSync(`${BUILD}/5_edges.tsv`, { create: true, write: true, truncate: true });
  const enc = new TextEncoder();
  fh.writeSync(enc.encode("skill_id\tprereq_id\n"));
  let edges = 0, orphans = 0;
  for (const s of skills) {
    const resp = cacheFinal.get(s.id);
    if (!resp || resp === "none") { orphans++; continue; }
    let n = 0;
    for (const pid of resp.split(",")) {
      if (!pid || !skillIds.has(pid)) continue;
      fh.writeSync(enc.encode(`${s.id}\t${pid}\n`));
      edges++; n++;
    }
    if (n === 0) orphans++;
  }
  fh.close();
  writeStats(5, { skills: skills.length, responses: cacheFinal.size, edges, orphans, orphan_rate: orphans / skills.length });
}

// ---------- stage postproc ----------

function stagePostproc() {
  const tagLines = Deno.readTextFileSync(taggedTsvPath()).split("\n").filter((l) => l.length);
  const hdr = tagLines[0].split("\t");
  const iTitle = hdr.indexOf("title"), iTags = hdr.indexOf("tags"), iTopics = hdr.indexOf("topics");
  const skill = new Map<string, { title: string; tags: string; topics: Set<string> }>();
  for (let i = 1; i < tagLines.length; i++) {
    const c = tagLines[i].split("\t");
    skill.set(c[0], {
      title: c[iTitle], tags: c[iTags],
      topics: new Set(c[iTopics].split(",").filter(Boolean)),
    });
  }
  const diffLines = Deno.readTextFileSync(`${BUILD}/4_difficulty.tsv`).split("\n").filter((l) => l.length);
  const rawDiff = new Map<string, number>();
  const band = new Map<string, number>();
  for (let i = 1; i < diffLines.length; i++) {
    const c = diffLines[i].split("\t");
    band.set(c[0], Number(c[1]));
    rawDiff.set(c[0], Number(c[2]));
  }

  const prereqLines = Deno.readTextFileSync(PREREQ_CACHE).split("\n").filter((l) => l.length);
  const pick = new Map<string, string>();
  for (const line of prereqLines) {
    const tab = line.indexOf("\t");
    pick.set(line.slice(0, tab), line.slice(tab + 1));
  }

  let raw: [string, string][] = [];
  for (const [id, resp] of pick) {
    if (!resp || resp === "none") continue;
    for (const pid of resp.split(",")) if (pid) raw.push([id, pid]);
  }

  // Apply dedupe aliases (transitive-collapsed)
  {
    const alias = loadAliasesCollapsed();
    if (alias.size) {
      raw = raw.map(([s, p]) => [alias.get(s) ?? s, alias.get(p) ?? p] as [string, string])
        .filter(([s, p]) => s !== p);
    }
  }

  const beforeOrphan = raw.length;
  raw = raw.filter(([s, p]) => skill.has(s) && skill.has(p));
  if (beforeOrphan - raw.length > 0) console.log(`[postproc] dropped ${beforeOrphan - raw.length} orphan-ref edges`);
  console.log(`[postproc] raw edges: ${raw.length}`);

  // Load seed edges for exemption
  const seedEdgeKeys = new Set<string>();
  let seedLoaded = 0;
  try {
    const seedLines = Deno.readTextFileSync(`${BUILD}/1e_seed_edges.tsv`).split("\n").filter((l) => l.length).slice(1);
    const alias = loadAliasesCollapsed();
    for (const line of seedLines) {
      const c = line.split("\t");
      if (c[4] === "1") continue;
      const src = alias.get(c[0]) ?? c[0];
      const dst = alias.get(c[1]) ?? c[1];
      seedEdgeKeys.add(`${dst}\t${src}`);
      seedLoaded++;
    }
  } catch { /* none */ }
  const isSeed = (s: string, p: string): boolean => seedEdgeKeys.has(`${s}\t${p}`);
  console.log(`[postproc] seed keys: ${seedLoaded}`);

  // Pass 11 H1: leaf-specific holiday/retell titles survive hub caps because they have
  // 1,800+ incoming edges from K-3 ELA scope-and-sequence frameworks.
  // Drop any edge whose prereq matches a leaf-title pattern BEFORE hub filtering.
  const LEAF_PATTERN = /retell-stories-related-to-.*-day|customs-around-.*-day|-national-independence-day|classify-character-traits-and-their-influence|understand-object-naming-and-naming-conventions/;
  const beforeLeaf = raw.length;
  let leafExempt = 0;
  raw = raw.filter(([s, p]) => {
    if (!LEAF_PATTERN.test(p)) return true;
    if (isSeed(s, p)) { leafExempt++; return true; }
    return false;
  });
  console.log(`[postproc] dropped ${beforeLeaf - raw.length} leaf-pattern edges (${leafExempt} seed exempt)`);

  // Filter 0: band-inverted
  let bandExempt = 0;
  const beforeBand = raw.length;
  raw = raw.filter(([s, p]) => {
    if ((band.get(p) ?? 0) <= (band.get(s) ?? 20)) return true;
    if (isSeed(s, p)) { bandExempt++; return true; }
    return false;
  });
  console.log(`[postproc] dropped ${beforeBand - raw.length} band-inverted (${bandExempt} seed exempt)`);

  // Filter 0a: raw-difficulty monotonicity (catches same-band reversals)
  const RAW_EPS = Number(Deno.env.get("RAW_MONOTONIC_EPS") ?? "0.05");
  let rawExempt = 0;
  const beforeRaw = raw.length;
  raw = raw.filter(([s, p]) => {
    const sR = rawDiff.get(s);
    const pR = rawDiff.get(p);
    if (sR === undefined || pR === undefined) return true;
    if (pR <= sR - RAW_EPS) return true;
    if (isSeed(s, p)) { rawExempt++; return true; }
    return false;
  });
  console.log(`[postproc] dropped ${beforeRaw - raw.length} raw-inverted (${rawExempt} seed exempt)`);

  // Filter 0b: domain-skill specificity guard.
  // A broad domain skill (≤2 tokens in its slug, e.g. "arithmetic", "algebra", "geometry")
  // should not have highly-specific prereqs (e.g. "partial-fraction-decomposition") chosen
  // by the LLM. Those are usually sub-concepts mis-picked as prereqs. Only allow seed edges
  // or prereqs that are themselves broad (≤ skill.tokens + 1).
  const tokenCount = (id: string): number => {
    let n = 0; for (const w of id.split("-")) if (w.length >= 2) n++; return n;
  };
  const beforeDomain = raw.length;
  let domainExempt = 0;
  raw = raw.filter(([s, p]) => {
    const sTok = tokenCount(s);
    if (sTok > 2) return true;
    const pTok = tokenCount(p);
    if (pTok <= sTok + 1) return true;
    if (isSeed(s, p)) { domainExempt++; return true; }
    return false;
  });
  console.log(`[postproc] dropped ${beforeDomain - raw.length} domain-specificity (${domainExempt} seed exempt)`);

  // Filter 0b: hypernym
  const HYP_STOP = new Set(["a","an","the","of","to","for","in","on","at","by","with","and","or","from","as","is","are","be","that","this","these","those","their","its"]);
  const sigSlugToks = (id: string): Set<string> => {
    const out = new Set<string>();
    for (const w of id.split("-")) if (w.length >= 3 && !HYP_STOP.has(w)) out.add(w);
    return out;
  };
  const beforeHyp = raw.length;
  raw = raw.filter(([s, p]) => {
    if (isSeed(s, p)) return true;
    const pT = sigSlugToks(p);
    if (pT.size < 2) return true;
    const sT = sigSlugToks(s);
    if (sT.size === 0) return true;
    for (const t of pT) if (!sT.has(t)) return true;
    return sT.size <= pT.size;
  });
  console.log(`[postproc] hypernym: dropped ${beforeHyp - raw.length}`);

  // Filter 1: onet:tech
  const bySkill = new Map<string, string[]>();
  for (const [s, p] of raw) { const arr = bySkill.get(s) ?? []; arr.push(p); bySkill.set(s, arr); }
  let droppedTech = 0;
  const techFiltered: [string, string][] = [];
  for (const [s, prereqs] of bySkill) {
    const ssk = skill.get(s);
    const sIsTech = ssk?.tags.includes("onet:tech") ?? false;
    const sRaw = rawDiff.get(s) ?? 0;
    const kept = prereqs.filter((p) => {
      if (isSeed(s, p)) return true;
      const psk = skill.get(p);
      if (!psk) return true;
      const pIsTech = psk.tags.includes("onet:tech");
      if (!pIsTech) return true;
      if (sIsTech) return sRaw - (rawDiff.get(p) ?? 0) >= 2.0;
      if (ssk?.topics.has(p)) return true;
      return false;
    });
    let final = kept;
    if (final.length === 0 && !sIsTech && prereqs.length > 0) {
      const firstNonTech = prereqs.find((p) => !(skill.get(p)?.tags.includes("onet:tech") ?? false));
      if (firstNonTech) final = [firstNonTech];
    }
    droppedTech += prereqs.length - final.length;
    for (const p of final) techFiltered.push([s, p]);
  }
  raw = techFiltered;
  console.log(`[postproc] dropped ${droppedTech} onet:tech edges`);

  // Filter 2: per-topic + global hub cap
  const PER_TOPIC_CAP = Number(Deno.env.get("PER_TOPIC_CAP") ?? "30");
  const GLOBAL_CAP = Number(Deno.env.get("HUB_CAP") ?? "150");
  const TECH_HUB_CAP = Number(Deno.env.get("TECH_HUB_CAP") ?? "15");
  const downstream = new Map<string, [string, string][]>();
  for (const e of raw) { const arr = downstream.get(e[1]) ?? []; arr.push(e); downstream.set(e[1], arr); }
  let droppedHub = 0, droppedPerTopic = 0;
  const keep = new Set<string>();
  for (const [prereqId, edges] of downstream) {
    const pIsTech = skill.get(prereqId)?.tags.includes("onet:tech") ?? false;
    const pRaw = rawDiff.get(prereqId) ?? 0;
    edges.sort((a, b) => Math.abs((rawDiff.get(a[0]) ?? 0) - pRaw) - Math.abs((rawDiff.get(b[0]) ?? 0) - pRaw));
    if (pIsTech) {
      for (let i = 0; i < edges.length; i++) {
        const [s, p] = edges[i];
        if (isSeed(s, p)) { keep.add(`${s}\t${p}`); continue; }
        if (i < TECH_HUB_CAP) keep.add(`${s}\t${p}`);
        else droppedHub++;
      }
      continue;
    }
    const perTopic = new Map<string, number>();
    let kept = 0;
    for (const [s, p] of edges) {
      if (isSeed(s, p)) { keep.add(`${s}\t${p}`); kept++; continue; }
      const ct = skill.get(s)?.topics;
      const topics = ct && ct.size ? [...ct] : ["_notopic"];
      const allowed = topics.filter((t) => (perTopic.get(t) ?? 0) < PER_TOPIC_CAP);
      if (allowed.length === 0) { droppedPerTopic++; continue; }
      if (kept >= GLOBAL_CAP) { droppedHub++; continue; }
      keep.add(`${s}\t${p}`);
      for (const t of allowed) perTopic.set(t, (perTopic.get(t) ?? 0) + 1);
      kept++;
    }
  }
  const final: [string, string][] = raw.filter((e) => keep.has(`${e[0]}\t${e[1]}`));
  console.log(`[postproc] hub caps: dropped ${droppedPerTopic} per-topic, ${droppedHub} global/tech`);

  // Heuristic orphan fix
  const orphanSkills = new Set<string>();
  const hasEdge = new Set(final.map(([s]) => s));
  for (const id of skill.keys()) if (!hasEdge.has(id)) orphanSkills.add(id);
  const wordToSkills = new Map<string, string[]>();
  for (const [id] of skill) {
    for (const w of id.split("-")) {
      if (w.length >= 5) {
        const arr = wordToSkills.get(w) ?? []; arr.push(id); wordToSkills.set(w, arr);
      }
    }
  }
  const stopWords = new Set<string>();
  for (const [w, list] of wordToSkills) if (list.length > 300) stopWords.add(w);
  const heurUseCount = new Map<string, number>();
  const HEUR_CAP = 15;
  const HEUR_MIN_GAP = Number(Deno.env.get("HEUR_MIN_GAP") ?? "4");
  const HEUR_DISABLE = Deno.env.get("DISABLE_ORPHAN_FIX") === "1";
  let orphanFixed = 0;
  const orphanTitleTok = (id: string): Set<string> => {
    const out = new Set<string>();
    for (const w of id.split("-")) if (w.length >= 4 && !stopWords.has(w)) out.add(w);
    return out;
  };
  for (const orphanId of HEUR_DISABLE ? [] : orphanSkills) {
    const ssk = skill.get(orphanId)!;
    const sRaw = rawDiff.get(orphanId) ?? 0;
    const titleToks = orphanTitleTok(orphanId);
    // Candidate words must appear in orphan's own TITLE (not just topics).
    const candWords = new Set<string>();
    for (const w of titleToks) if (w.length >= 5) candWords.add(w);
    const cands = new Map<string, number>();
    for (const w of candWords) {
      if (stopWords.has(w)) continue;
      const list = wordToSkills.get(w);
      if (!list) continue;
      for (const candId of list) {
        if (candId === orphanId) continue;
        if (candId !== w) continue; // only exact-slug matches
        if (skill.get(candId)?.tags.includes("onet:tech")) continue;
        if (sRaw - (rawDiff.get(candId) ?? 0) < HEUR_MIN_GAP) continue;
        cands.set(candId, 100);
      }
    }
    if (cands.size === 0) continue;
    const ranked = [...cands.entries()].sort((a, b) =>
      b[1] - a[1]
      || (heurUseCount.get(a[0]) ?? 0) - (heurUseCount.get(b[0]) ?? 0)
      || (rawDiff.get(a[0]) ?? 0) - (rawDiff.get(b[0]) ?? 0));
    for (const [candId] of ranked) {
      const n = heurUseCount.get(candId) ?? 0;
      if (n >= HEUR_CAP) continue;
      final.push([orphanId, candId]);
      heurUseCount.set(candId, n + 1);
      orphanFixed++;
      break;
    }
  }
  console.log(`[postproc] orphan fix: added ${orphanFixed}/${orphanSkills.size}`);

  // Cross-domain filter
  const FOUNDATION = new Set([
    "mathematics","math","arithmetic","reading","writing","reading-comprehension",
    "written-expression","active-listening","speaking","problem-solving",
    "critical-thinking","complex-problem-solving","deductive-reasoning","inductive-reasoning",
    "active-learning","learning-strategies",
  ]);
  const MIN_OVERLAP = Number(Deno.env.get("MIN_TOPIC_OVERLAP") ?? "0.0001");
  const sigTok2 = (id: string): Set<string> => {
    const out = new Set<string>();
    for (const w of id.split("-")) if (w.length >= 4 && !stopWords.has(w)) out.add(w);
    return out;
  };
  const outPerSkill = new Map<string, number>();
  for (const [s] of final) outPerSkill.set(s, (outPerSkill.get(s) ?? 0) + 1);
  let droppedCross = 0;
  for (let i = final.length - 1; i >= 0; i--) {
    const [s, p] = final[i];
    if (isSeed(s, p)) continue;
    if (FOUNDATION.has(p)) continue;
    const srcT = skill.get(p)?.topics, dstT = skill.get(s)?.topics;
    if (!srcT || !dstT || srcT.size < 2 || dstT.size < 2) continue;
    let overlap = 0;
    for (const t of srcT) if (dstT.has(t)) overlap++;
    if (overlap / Math.min(srcT.size, dstT.size) >= MIN_OVERLAP) continue;
    const st = sigTok2(p), dt = sigTok2(s);
    let tOverlap = 0;
    for (const t of st) if (dt.has(t)) tOverlap++;
    if (tOverlap > 0) continue;
    if ((outPerSkill.get(s) ?? 0) <= 1) continue;
    final.splice(i, 1);
    outPerSkill.set(s, (outPerSkill.get(s) ?? 0) - 1);
    droppedCross++;
  }
  console.log(`[postproc] cross-domain: dropped ${droppedCross}`);

  // Seed ingestion
  let seedAdded = 0, seedDup = 0, seedMissing = 0;
  try {
    const seedLines = Deno.readTextFileSync(`${BUILD}/1e_seed_edges.tsv`).split("\n").filter((l) => l.length);
    const existing = new Set(final.map(([s, p]) => `${s}\t${p}`));
    const alias = loadAliasesCollapsed();
    for (let i = 1; i < seedLines.length; i++) {
      const c = seedLines[i].split("\t");
      const src = alias.get(c[0]) ?? c[0];
      const dst = alias.get(c[1]) ?? c[1];
      if (c[4] === "1") continue;
      if (!skill.has(src) || !skill.has(dst) || src === dst) { seedMissing++; continue; }
      const key = `${dst}\t${src}`;
      if (existing.has(key)) { seedDup++; continue; }
      final.push([dst, src]);
      existing.add(key);
      seedAdded++;
    }
  } catch { /* none */ }
  console.log(`[postproc] seeds: added=${seedAdded}, dup=${seedDup}, missing=${seedMissing}`);

  // Cycle breaker (Tarjan + rank-based back-edge drop)
  let cyclesBroken = 0, cyclesSeedDropped = 0;
  for (let iter = 0; iter < 100; iter++) {
    const adj = new Map<string, string[]>();
    for (const [s, p] of final) { const arr = adj.get(p) ?? []; arr.push(s); adj.set(p, arr); }
    const index = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    let idx = 0;
    const sccs: string[][] = [];
    const nodes = new Set<string>();
    for (const [s, p] of final) { nodes.add(s); nodes.add(p); }
    function strongconnect(v0: string) {
      const callStack: { node: string; iter: Iterator<string>; minLink: number }[] = [];
      index.set(v0, idx); lowlink.set(v0, idx); idx++;
      stack.push(v0); onStack.add(v0);
      callStack.push({ node: v0, iter: (adj.get(v0) || [])[Symbol.iterator](), minLink: lowlink.get(v0)! });
      while (callStack.length) {
        const top = callStack[callStack.length - 1];
        const next = top.iter.next();
        if (next.done) {
          lowlink.set(top.node, top.minLink);
          if (lowlink.get(top.node) === index.get(top.node)) {
            const comp: string[] = [];
            while (true) {
              const w = stack.pop()!; onStack.delete(w); comp.push(w);
              if (w === top.node) break;
            }
            if (comp.length > 1) sccs.push(comp);
          }
          callStack.pop();
          if (callStack.length) {
            const parent = callStack[callStack.length - 1];
            parent.minLink = Math.min(parent.minLink, top.minLink);
          }
          continue;
        }
        const w = next.value;
        if (!index.has(w)) {
          index.set(w, idx); lowlink.set(w, idx); idx++;
          stack.push(w); onStack.add(w);
          callStack.push({ node: w, iter: (adj.get(w) || [])[Symbol.iterator](), minLink: lowlink.get(w)! });
        } else if (onStack.has(w)) {
          top.minLink = Math.min(top.minLink, index.get(w)!);
        }
      }
    }
    for (const n of nodes) if (!index.has(n)) strongconnect(n);
    if (sccs.length === 0) break;
    const toDrop = new Set<string>();
    for (const scc of sccs) {
      const sccSet = new Set(scc);
      const internal: { s: string; p: string; gap: number; seed: boolean }[] = [];
      for (const [s, p] of final) {
        if (!sccSet.has(s) || !sccSet.has(p)) continue;
        internal.push({ s, p, gap: (rawDiff.get(s) ?? 0) - (rawDiff.get(p) ?? 0), seed: isSeed(s, p) });
      }
      const seedInDeg = new Map<string, number>(), seedAdj = new Map<string, string[]>();
      for (const n of scc) seedInDeg.set(n, 0);
      for (const e of internal) if (e.seed) {
        const arr = seedAdj.get(e.p) ?? []; arr.push(e.s); seedAdj.set(e.p, arr);
        seedInDeg.set(e.s, (seedInDeg.get(e.s) ?? 0) + 1);
      }
      const rankFor = new Map<string, number>();
      const ready: string[] = [...scc].filter((n) => (seedInDeg.get(n) ?? 0) === 0);
      ready.sort((a, b) => (rawDiff.get(a) ?? 0) - (rawDiff.get(b) ?? 0));
      let rank = 0;
      const seedCycleNodes = new Set(scc);
      while (ready.length) {
        const u = ready.shift()!;
        rankFor.set(u, rank++);
        seedCycleNodes.delete(u);
        for (const v of seedAdj.get(u) ?? []) {
          seedInDeg.set(v, (seedInDeg.get(v) ?? 0) - 1);
          if (seedInDeg.get(v) === 0) {
            let ins = 0;
            while (ins < ready.length && (rawDiff.get(ready[ins]) ?? 0) <= (rawDiff.get(v) ?? 0)) ins++;
            ready.splice(ins, 0, v);
          }
        }
      }
      const leftover = [...seedCycleNodes].sort((a, b) => (rawDiff.get(a) ?? 0) - (rawDiff.get(b) ?? 0));
      for (const n of leftover) rankFor.set(n, rank++);
      let droppedThis = 0;
      for (const e of internal) {
        if ((rankFor.get(e.p)!) >= (rankFor.get(e.s)!)) {
          toDrop.add(`${e.s}\t${e.p}`);
          if (e.seed) cyclesSeedDropped++;
          droppedThis++;
        }
      }
      if (droppedThis === 0 && internal.length) {
        internal.sort((a, b) => (a.seed === b.seed ? a.gap - b.gap : a.seed ? 1 : -1));
        const e = internal[0];
        toDrop.add(`${e.s}\t${e.p}`);
        if (e.seed) cyclesSeedDropped++;
      }
    }
    const before = final.length;
    for (let i = final.length - 1; i >= 0; i--) {
      if (toDrop.has(`${final[i][0]}\t${final[i][1]}`)) final.splice(i, 1);
    }
    cyclesBroken += before - final.length;
    if (before === final.length) break;
  }
  console.log(`[postproc] cycle-breaker: ${cyclesBroken} edges (${cyclesSeedDropped} seed)`);

  // DAG assertion
  {
    const adj = new Map<string, string[]>();
    for (const [s, p] of final) { const arr = adj.get(p) ?? []; arr.push(s); adj.set(p, arr); }
    const inDeg = new Map<string, number>();
    const allNodes = new Set<string>();
    for (const [s, p] of final) { allNodes.add(s); allNodes.add(p); }
    for (const n of allNodes) inDeg.set(n, 0);
    for (const [s] of final) inDeg.set(s, (inDeg.get(s) ?? 0) + 1);
    const q = [...allNodes].filter((n) => (inDeg.get(n) ?? 0) === 0);
    let removed = 0;
    const removedSet = new Set<string>(q);
    while (q.length) {
      const u = q.shift()!; removed++;
      for (const v of adj.get(u) ?? []) {
        inDeg.set(v, (inDeg.get(v) ?? 0) - 1);
        if (inDeg.get(v) === 0 && !removedSet.has(v)) { removedSet.add(v); q.push(v); }
      }
    }
    const stuck = allNodes.size - removed;
    if (stuck > 0) {
      const stuckSet = new Set<string>();
      for (const n of allNodes) if (!removedSet.has(n)) stuckSet.add(n);
      for (let i = final.length - 1; i >= 0; i--) {
        if (stuckSet.has(final[i][0]) && stuckSet.has(final[i][1])) final.splice(i, 1);
      }
      console.log(`[postproc] force-dropped remaining cycles (${stuck} nodes)`);
    }
  }

  // Write (sorted for deterministic output across runs)
  final.sort((a, b) => a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : (a[0] < b[0] ? -1 : 1));
  const fh = Deno.openSync(`${BUILD}/6_edges.tsv`, { create: true, write: true, truncate: true });
  const enc = new TextEncoder();
  fh.writeSync(enc.encode("skill_id\tprereq_id\n"));
  for (const [s, p] of final) fh.writeSync(enc.encode(`${s}\t${p}\n`));
  fh.close();

  let seedInFinal = 0;
  for (const [s, p] of final) if (isSeed(s, p)) seedInFinal++;
  writeStats(6, {
    final_edges: final.length,
    cycles_broken: cyclesBroken,
    cycles_seed_dropped: cyclesSeedDropped,
    dropped_tech: droppedTech,
    dropped_per_topic: droppedPerTopic,
    dropped_hub: droppedHub,
    dropped_cross_domain: droppedCross,
    seed_loaded: seedLoaded,
    seed_added: seedAdded,
    seed_in_final: seedInFinal,
    orphan_fixed: orphanFixed,
    orphan_rate: 1 - new Set(final.flatMap((e) => [e[0], e[1]])).size / skill.size,
  });
}

// ---------- stage finalize ----------

function stageFinalize() {
  const lines = Deno.readTextFileSync(taggedTsvPath()).split("\n").filter((l) => l.length);
  const h = lines[0].split("\t");
  const iT = h.indexOf("title"), iD = h.indexOf("description"),
        iO = h.indexOf("occupations"), iTp = h.indexOf("topics"), iTg = h.indexOf("tags");
  const skills = lines.slice(1).map((l) => {
    const c = l.split("\t");
    return { id: c[0], title: c[iT], description: c[iD], occupations: c[iO], topics: c[iTp], tags: iTg >= 0 ? (c[iTg] || "") : "" };
  });
  const dLines = Deno.readTextFileSync(`${BUILD}/4_difficulty.tsv`).split("\n").filter((l) => l.length);
  const diff = new Map<string, number>();
  for (let i = 1; i < dLines.length; i++) {
    const c = dLines[i].split("\t");
    const b = Number(c[1]);
    if (!Number.isInteger(b) || b < 1 || b > 20) {
      throw new Error(`[finalize] bad difficulty for ${c[0]}: ${c[1]}`);
    }
    diff.set(c[0], b);
  }

  const aliasMap = new Map<string, string>();
  forEachLine(`${BUILD}/3b_aliases.tsv`, (line) => {
    const [drop, keep] = line.split("\t");
    if (drop && keep && drop !== "dropped_id") aliasMap.set(drop, keep);
  });
  const remap = (id: string) => aliasMap.get(id) ?? id;

  const skillIdSet = new Set<string>(skills.map((s) => s.id));
  const edgeLines = Deno.readTextFileSync(`${BUILD}/6_edges.tsv`).split("\n").filter((l) => l.length).slice(1);
  const prereqs = new Map<string, string[]>();
  let edgeRemapped = 0, edgeOrphanDropped = 0;
  for (const l of edgeLines) {
    let [s, p] = l.split("\t");
    const s2 = remap(s), p2 = remap(p);
    if (s2 !== s || p2 !== p) edgeRemapped++;
    if (!skillIdSet.has(s2) || !skillIdSet.has(p2) || s2 === p2) { edgeOrphanDropped++; continue; }
    s = s2; p = p2;
    const arr = prereqs.get(s) ?? [];
    if (!arr.includes(p)) arr.push(p);
    prereqs.set(s, arr);
  }

  // Framework/wiki-category filters (module-scope FRAMEWORK_RE, WIKI_CAT_RE, YEAR_RE)
  const frameworkRe = FRAMEWORK_RE;
  const wikiCatRe = WIKI_CAT_RE;
  const yearRe = YEAR_RE;
  const STOP = new Set(["the","a","an","of","to","for","in","on","and","or","with","by","at","from","as","is","be","that","this","these","those"]);
  const sigTokens = (id: string) => new Set(id.split("-").filter((t) => t.length >= 4 && !STOP.has(t)));

  // Cruft drop
  const aliasCanonicals = new Set<string>();
  forEachLine(`${BUILD}/3b_aliases.tsv`, (line) => {
    const keep = line.split("\t")[1];
    if (keep && keep !== "canonical_id") aliasCanonicals.add(keep);
  });
  const childCount = new Map<string, number>();
  for (const [, p] of prereqs) for (const pid of p) childCount.set(pid, (childCount.get(pid) ?? 0) + 1);
  const isOrphanLeaf = (id: string) => (prereqs.get(id) || []).length === 0 && (childCount.get(id) ?? 0) === 0;
  const isCruft = (s: { id: string; title: string; description: string; topics: string }) => {
    if (aliasCanonicals.has(s.id)) return false;
    const desc = (s.description || "").trim();
    const topics = (s.topics || "").split(",").filter(Boolean);
    if (!desc && !topics.length) return true;
    // Empty description AND only 1 topic: not enough signal for a skill node.
    if (!desc && topics.length < 2) return true;
    if (s.id.split("-").length >= 5 && desc.length < 60) return true;
    if (/^review-records|^prepare-inserts|^seal-containers/.test(s.id)) return true;
    return false;
  };

  const deriveDisplay = (title: string, tags: string): string => {
    if (title.length <= 80) return title;
    for (const t of tags.split(",")) {
      if (t.startsWith("code:")) {
        const code = t.slice(5).trim();
        if (code && code.length <= 80) return code;
      }
    }
    const head = title.slice(0, 80);
    const lastDot = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
    if (lastDot > 30) return head.slice(0, lastDot + 1).trim();
    const trim = title.slice(0, 79);
    const lastSpace = trim.lastIndexOf(" ");
    return (lastSpace > 30 ? trim.slice(0, lastSpace) : trim).trim() + "…";
  };

  // Load LCSH + DBpedia ancestor chains
  const lcshTree = new Map<string, string[]>();
  const loadTree = (path: string) => forEachLine(path, (line) => {
    const tab = line.indexOf("\t");
    const slug = line.slice(0, tab);
    const anc = line.slice(tab + 1).split(",").filter(Boolean);
    if (slug && anc.length) {
      const existing = lcshTree.get(slug);
      lcshTree.set(slug, existing ? [...new Set([...existing, ...anc])] : anc);
    }
  });
  loadTree(`${BUILD}/1j_lcsh_tree.tsv`);
  loadTree(`${BUILD}/1k_dbpedia_tree.tsv`);
  console.log(`[finalize] loaded ${lcshTree.size} LCSH/DBpedia ancestor chains`);

  type Row = { id: string; title: string; display: string; desc: string; d: number; ps: string; occ: string; topics: string[]; gStart: string; gEnd: string };
  const pending: Row[] = [];
  const TOPIC_CAP = 5;
  let frameworkFiltered = 0, junkFiltered = 0, lcshEnriched = 0, cruftDropped = 0;
  for (const s of skills) {
    if (isOrphanLeaf(s.id) && isCruft(s)) { cruftDropped++; continue; }
    const d = diff.get(s.id);
    if (d === undefined) throw new Error(`skill ${s.id} missing difficulty`);
    const ps = (prereqs.get(s.id) ?? []).join(",");
    const existing = s.topics.split(",").filter(Boolean);
    const skillTokens = sigTokens(s.id);
    for (const tok of sigTokens(s.title.toLowerCase().replace(/\s+/g, "-"))) skillTokens.add(tok);
    for (const tok of sigTokens((s.description || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, "-"))) skillTokens.add(tok);
    for (const t of s.occupations.split(",").filter(Boolean)) for (const tok of sigTokens(t)) skillTokens.add(tok);
    const filtered = existing.filter((t) => {
      if (frameworkRe.test(t)) { frameworkFiltered++; return false; }
      if (wikiCatRe.test(t) || yearRe.test(t)) { junkFiltered++; return false; }
      if (sigTokens(t).size === 0) { junkFiltered++; return false; }
      return true;
    });
    // LCSH/DBpedia ancestor enrichment
    const lcshTopics: string[] = [];
    for (const cand of [s.id, slugify(s.title), ...filtered]) {
      const anc = lcshTree.get(cand);
      if (!anc) continue;
      for (const a of anc) {
        if (lcshTopics.includes(a) || yearRe.test(a) || wikiCatRe.test(a) || frameworkRe.test(a)) continue;
        if (sigTokens(a).size === 0) continue;
        const aToks = sigTokens(a);
        let ovl = 0;
        for (const tok of aToks) if (skillTokens.has(tok)) { ovl++; break; }
        if (!ovl) continue;
        lcshTopics.push(a);
        if (lcshTopics.length >= 3) break;
      }
      if (lcshTopics.length >= 3) break;
    }
    if (lcshTopics.length) lcshEnriched++;
    const topics = [...new Set([...filtered, ...lcshTopics])].slice(0, TOPIC_CAP);
    const gradeMap: Record<string, number> = { "PK": -1, "K": 0 };
    const grades: number[] = [];
    for (const tag of s.tags.split(",")) {
      if (!tag.startsWith("grade:")) continue;
      const v = tag.slice(6).toUpperCase();
      const n = gradeMap[v] ?? (/^\d+$/.test(v) ? Number(v) : NaN);
      if (!Number.isNaN(n)) grades.push(n);
    }
    pending.push({
      id: s.id, title: s.title, display: deriveDisplay(s.title, s.tags),
      desc: s.description, d, ps, occ: s.occupations, topics,
      gStart: grades.length ? Math.min(...grades).toString() : "",
      gEnd: grades.length ? Math.max(...grades).toString() : "",
    });
  }

  // Topic frequency cap
  const topicFreq = new Map<string, number>();
  for (const r of pending) for (const t of r.topics) topicFreq.set(t, (topicFreq.get(t) ?? 0) + 1);
  const MAX_FREQ = Math.max(1200, Math.floor(pending.length * 0.013));
  const whitelist = new Set([
    "mathematics","science","biology","chemistry","physics","engineering","technology",
    "economics","history","literature","philosophy","medicine","law","education",
    "problem-solving","critical-thinking","communication","management","leadership",
    "computer-science","software-engineering","data-analysis","statistics","research",
    "information-skills","management-skills","nondestructive-testing","mathematical-optimization",
    "handling-and-moving","personnel-management","working-with-machinery-and-specialised-equipment",
  ]);
  const blocklist = new Set([
    "photomechanical-processes","flying-machines","rome-officials-and-employees",
    "traffic-regulations","units-of-measurement",
    "professional-employees","employees","persons","specialists","scientists",
    "workers","people","occupations","officials","personnel","staff",
    "professionals","practitioners","technicians","operators",
    "judaism-customs-and-practices","descriptive-cataloging","ibm-computers",
    "wikiproject-countries-projects","wikiproject-africa-projects",
    "computer-input-output-equipment","history-of-technology",
    "personality-tests","diagnostic-equipment-industry","industrial-equipment-industry",
    "portable-computers","telecommunication-equipment-industry",
    "law-interpretation-and-construction",
  ]);
  let singletonDropped = 0, genericDropped = 0;
  // Pass 11 T4: raise near-singleton threshold from <2 to <4. Topics with 2-3
  // members never form useful clusters but added noise.
  const TOPIC_MIN_FREQ = Number(Deno.env.get("TOPIC_MIN_FREQ") ?? "4");
  for (const r of pending) {
    r.topics = r.topics.filter((t) => {
      const f = topicFreq.get(t) ?? 0;
      if (f < TOPIC_MIN_FREQ) { singletonDropped++; return false; }
      if (blocklist.has(t)) { genericDropped++; return false; }
      if (f > MAX_FREQ && !whitelist.has(t)) { genericDropped++; return false; }
      return true;
    });
  }

  const rows = ["id\ttitle\tdisplay_title\tdescription\tdifficulty\tprereqs\toccupations\ttopics\tgrade_start\tgrade_end"];
  for (const r of pending) {
    rows.push([r.id, r.title, r.display, r.desc, r.d.toString(), r.ps, r.occ, r.topics.join(","), r.gStart, r.gEnd].join("\t"));
  }
  Deno.writeTextFileSync("skills.tsv", rows.join("\n") + "\n");

  const emittedSet = new Set<string>();
  for (let i = 1; i < rows.length; i++) emittedSet.add(rows[i].split("\t")[0]);
  let violations = 0;
  for (const r of pending) {
    if (!r.ps) continue;
    for (const p of r.ps.split(",")) {
      if (!emittedSet.has(p)) {
        if (violations < 5) console.error(`[finalize] orphan edge: ${r.id} → ${p}`);
        violations++;
      }
    }
  }
  if (violations > 0) throw new Error(`finalize: ${violations} orphan prereq references`);

  new Deno.Command("gzip", { args: ["-kf", "skills.tsv"] }).outputSync();

  // Reachability BFS
  const adj = new Map<string, string[]>();
  for (const [s, ps] of prereqs) {
    if (!emittedSet.has(s)) continue;
    for (const p of ps) {
      if (!emittedSet.has(p)) continue;
      const arr = adj.get(p) ?? []; arr.push(s); adj.set(p, arr);
    }
  }
  const roots = skills.filter((s) => emittedSet.has(s.id) && !prereqs.has(s.id)).map((s) => s.id);
  const visited = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of adj.get(u) ?? []) if (!visited.has(v)) { visited.add(v); queue.push(v); }
  }

  const emitted = rows.length - 1;
  writeStats(7, {
    skills_emitted: emitted,
    skills_dropped_cruft: cruftDropped,
    edges: [...prereqs.values()].reduce((s, a) => s + a.length, 0),
    skills_with_prereqs: prereqs.size,
    orphan_skills: emitted - prereqs.size,
    roots: roots.length,
    reachable_from_roots: visited.size,
    unreachable: emitted - visited.size,
    lcsh_topic_enriched: lcshEnriched,
    framework_topics_filtered: frameworkFiltered,
    junk_topics_filtered: junkFiltered,
    singleton_topics_dropped: singletonDropped,
    generic_topics_dropped: genericDropped,
    grade_populated: rows.slice(1).filter((r) => r.split("\t")[8] !== "").length,
    edge_remapped: edgeRemapped,
    edge_orphan_dropped: edgeOrphanDropped,
  });
  console.log(`[finalize] emitted ${emitted} skills, ${[...prereqs.values()].reduce((s, a) => s + a.length, 0)} edges, ${roots.length} roots`);
}

// ---------- dispatch ----------

const stages: Record<string, () => void | Promise<void>> = {
  list: stageList,
  enrich: stageEnrich,
  trees: stageTrees,
  "seed-edges": stageSeedEdges,
  embed: stageEmbed,
  tag: stageTag,
  dedupe: stageDedupe,
  difficulty: stageDifficulty,
  prereq: stagePrereq,
  postproc: stagePostproc,
  finalize: stageFinalize,
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
