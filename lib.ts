import { parse as parseCsvText } from "@std/csv/parse";
import { unescape } from "@std/html/entities";
import entityList from "@std/html/named-entity-list.json" with {
  type: "json",
};

export const BUILD = "build";

export type Skill = {
  id: string;
  title: string;
  description: string;
  sources: string[];
  tags: string[];
};

// ---------- util ----------

export const decodeEntities = (s: string) => unescape(s, { entityList });

export function h32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export const slugify = (s: string) => {
  const base = decodeEntities(s).normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").toLowerCase()
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

const STAGE_OF: Record<string, string> = {
  [`${BUILD}/1_skills.tsv`]: "list",
  [`${BUILD}/1e_seed_edges.tsv`]: "seed-edges",
  [`${BUILD}/1f_translate.tsv`]: "enrich",
  [`${BUILD}/1j_lcsh_tree.tsv`]: "trees",
  [`${BUILD}/1k_dbpedia_tree.tsv`]: "trees",
  [`${BUILD}/1l_topic_refs.tsv`]: "trees",
  [`${BUILD}/2_ids.tsv`]: "embed",
  [`${BUILD}/2_embeddings.bin`]: "embed",
  [`${BUILD}/2_pathological.tsv`]: "embed",
  [`${BUILD}/3_tagged.tsv`]: "tag",
  [`${BUILD}/3b_tagged_deduped.tsv`]: "dedupe",
  [`${BUILD}/3b_aliases.tsv`]: "dedupe",
  [`${BUILD}/4_difficulty.tsv`]: "difficulty",
  [`${BUILD}/4_stats.json`]: "difficulty",
  [`${BUILD}/5_prereqs.tsv`]: "prereq",
  [`${BUILD}/6_edges.tsv`]: "postproc",
  "skills.tsv": "finalize",
};

export function rerun(path: string): string {
  const stage = STAGE_OF[path];
  if (!stage) throw new Error(`no stage writes ${path}. Add it to STAGE_OF.`);
  return `Run: deno run -A pipeline.ts ${stage}`;
}

// Status scores a NotFound as 0; every other caller crashes on it.
export function need(path: string): string {
  try {
    Deno.statSync(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    throw new Deno.errors.NotFound(`${path}: missing. ${rerun(path)}`);
  }
  return path;
}

export const TAGGED = `${BUILD}/3b_tagged_deduped.tsv`;

// Rows of a header-first table. The header is rows[0].
function headed(path: string, rows: string[][]): string[][] {
  if (!rows.length || rows[0].every((c) => !c)) {
    throw new Error(
      `${path}: expected a header row, received an empty file. Re-download the file.`,
    );
  }
  return rows;
}

export function readTsv(path: string): string[][] {
  const rows: string[][] = [];
  Deno.readTextFileSync(path).split("\n").forEach((l, i) => {
    l = l.replace(/\r$/, "");
    if (!l) return;
    const r = l.split("\t");
    if (rows.length && r.length !== rows[0].length) {
      throw new Error(
        `${path}:${i + 1}: expected ${
          rows[0].length
        } tab-separated fields like the header, received ${r.length}. Re-download the file.`,
      );
    }
    rows.push(r);
  });
  return headed(path, rows);
}

export function readCsv(path: string): string[][] {
  const text = Deno.readTextFileSync(path);
  try {
    return headed(path, parseCsvText(text, { fieldsPerRecord: 0 }));
  } catch (e) {
    throw new Error(
      `${path}: expected RFC 4180 CSV with a constant field count, received ${
        (e as Error).message
      }. Re-download the file.`,
    );
  }
}

// The index of a header column, or a throw that names the file.
export function col(rows: string[][], name: string, path: string): number {
  const i = rows[0].indexOf(name);
  if (i < 0) {
    throw new Error(
      `${path}: expected a column "${name}" in the header, received ${
        JSON.stringify(rows[0])
      }. The source changed its schema; update the reader or re-download the file.`,
    );
  }
  return i;
}

export function writeStats(
  stage: string | number,
  stats: Record<string, unknown>,
) {
  const path = `${BUILD}/${stage}_stats.json`;
  Deno.writeTextFileSync(path, JSON.stringify(stats, null, 2));
  console.log(`[stage ${stage}] stats → ${path}`);
}

// A missing cache reads as empty: it has no rows before its first write.
export function loadTsvCache(path: string): Map<string, string> {
  let text = "";
  try {
    text = Deno.readTextFileSync(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  // Writers end every row with a newline, so a missing one is a torn append.
  if (text && !text.endsWith("\n")) {
    throw new Error(
      `${path}: expected a newline after the last row, received "${
        text.slice(text.lastIndexOf("\n") + 1).slice(0, 80)
      }". A run stopped mid-write; delete that last row.`,
    );
  }
  const m = new Map<string, string>();
  text.split("\n").forEach((line, i) => {
    if (!line) return;
    const tab = line.indexOf("\t");
    if (tab < 0) {
      throw new Error(
        `${path}:${i + 1}: expected "key<TAB>value", received "${
          line.slice(0, 80)
        }". Delete that row and rerun the stage that writes it.`,
      );
    }
    if (!m.has(line.slice(0, tab))) {
      m.set(line.slice(0, tab), line.slice(tab + 1));
    }
  });
  return m;
}

export function forEachLine(path: string, fn: (line: string) => void) {
  for (const l of Deno.readTextFileSync(need(path)).split("\n")) if (l) fn(l);
}

export const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "for",
  "to",
  "and",
  "or",
  "is",
  "at",
  "by",
  "with",
  "from",
  "as",
  "be",
  "that",
  "this",
]);

export const SIG_STOP = new Set([
  ...STOPWORDS,
  "are",
  "their",
  "its",
  "these",
  "those",
]);

// ---------- ollama ----------

const OLLAMA = "http://localhost:11434";
const EMBED_MODEL = "nomic-embed-text";
export const EMBED_DIM = 768;

// Junk topics. Stage dedupe and stage finalize both filter them.
export const FRAMEWORK_RE =
  /-standards|-20\d\d|^sced-|^content-khan|^ccss$|^ngss$|next-generation-science|k-5-mathematics|adult-basic-education|cte-standards|curriculum|course-codes|^skills$|^content$|^learning-stage-|\d{4}-\d{4}|\d{2}-\d{2}-updates|scope-and-sequence|-sy\d{4}|-effective-starting|early-childhood-standards/;
export const WIKI_CAT_RE =
  /-officials-and-employees$|-by-country$|-by-region$|-by-type$|-by-year$|-by-nationality$|-introduced-in-|-established-in-|-disestablished-in-|-founded-in-|-born-in-|-died-in-|-set-in-|^people-in-|-people$|-in-history$|^wikiproject-|-templates$|^years-in-|^decades-in-|^centuries-in-|-matches$|-aircraft$|-records$|-(judges|officials|employees|members|persons)$/;
export const YEAR_RE = /(^|-)(19|20)\d\d(-|$)|^\d+$/;
export const isJunkTopic = (t: string): boolean =>
  FRAMEWORK_RE.test(t) || WIKI_CAT_RE.test(t) || YEAR_RE.test(t);

const GEN_MODEL = "gpt-oss:20b";
export const CACHE_PATH = `${BUILD}/2_cache.bin`;
const CACHE_RECORD_BYTES = 32 + EMBED_DIM * 4;

// A cold model load takes tens of seconds; a request past this bound has hung.
const OLLAMA_TIMEOUT_MS = 300_000;

// Retries a transient failure (network, timeout, 429, 5xx) once.
async function ollama(
  path: string,
  body: { model: string; [key: string]: unknown },
): Promise<Record<string, unknown>> {
  const t0 = performance.now();
  let received = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    let status = 0;
    try {
      const res = await fetch(`${OLLAMA}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      });
      if (res.ok) {
        const j = await res.json();
        if (typeof j !== "object" || j === null || "error" in j) {
          throw new Error(
            `ollama ${path}: expected a JSON object without "error", received ${
              JSON.stringify(j).slice(0, 200)
            }`,
          );
        }
        return j;
      }
      status = res.status;
      received = `HTTP ${status}: ${(await res.text()).slice(0, 200)}`;
    } catch (e) {
      if ((e as Error).message.startsWith(`ollama ${path}:`)) throw e;
      received = (e as Error).message;
    }
    if (status && status !== 429 && status < 500) break;
  }
  throw new Error(
    `ollama ${path}: expected HTTP 200, received ${received} after ${
      ((performance.now() - t0) / 1000).toFixed(0)
    }s. Check that ${OLLAMA} serves ${body.model}: ollama serve; ollama pull ${body.model}`,
  );
}

async function embedOne(content: string): Promise<Float32Array> {
  const { embedding } = await ollama("/api/embeddings", {
    model: EMBED_MODEL,
    prompt: content,
  });
  if (!Array.isArray(embedding) || embedding.length !== EMBED_DIM) {
    throw new Error(
      `ollama ${EMBED_MODEL}: expected a ${EMBED_DIM}-float embedding, received length ${
        Array.isArray(embedding) ? embedding.length : typeof embedding
      } for "${content.slice(0, 60)}"`,
    );
  }
  return new Float32Array(embedding);
}

async function generateOne(prompt: string, numPredict = 120): Promise<string> {
  const { response } = await ollama("/api/generate", {
    model: GEN_MODEL,
    prompt,
    stream: false,
    options: { temperature: 0.1, num_predict: numPredict },
  });
  if (typeof response !== "string") {
    throw new Error(
      `ollama ${GEN_MODEL}: expected a string response, received ${typeof response}`,
    );
  }
  return response.replace(/[\t\n\r]/g, " ").trim();
}

const REFUSAL_RE =
  /(cannot|unable to|not familiar with|not (?:able|aware|sure)|do(?:n't| not) have|no (?:recognized |clear |standard )?(?:definition|meaning)|without (?:more |further |additional )?(?:context|information)|could you (?:provide|clarify|specify)|recognized definition|clear workplace skill)/i;

export function cleanDef(raw: string): string {
  const trimmed = raw.trim()
    .replace(/^[\s"'*_-]+|[\s"'*_-]+$/g, "")
    .replace(/\s+/g, " ");
  if (!trimmed) return "";
  if (REFUSAL_RE.test(trimmed)) return "";
  if (/^skip$/i.test(trimmed)) return "";
  if (trimmed.length <= 400) return trimmed;
  const head = trimmed.slice(0, 400);
  const lastSent = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("? "),
    head.lastIndexOf("! "),
  );
  if (lastSent > 200) return head.slice(0, lastSent + 1).trim();
  const lastSpace = head.lastIndexOf(" ");
  return (lastSpace > 200 ? head.slice(0, lastSpace) : head).trim() + "…";
}

export async function resumableOllama<T extends { id: string }>(
  label: string,
  cachePath: string,
  targets: T[],
  promptFn: (t: T) => string,
  opts: {
    numPredict?: number;
    clean?: (raw: string, item: T) => string;
  } = {},
): Promise<void> {
  const cache = loadTsvCache(cachePath);
  const todo = targets.filter((t) => !cache.has(t.id));
  console.log(
    `[${label}] targets=${targets.length} cached=${cache.size} todo=${todo.length} → ${cachePath}`,
  );
  if (!todo.length) return;

  const queue = [...todo];
  const fh = Deno.openSync(cachePath, { create: true, append: true });
  const enc = new TextEncoder();
  const cleanFn = opts.clean ?? cleanDef;
  const t0 = performance.now();
  let done = 0, rejected = 0, firstRejected = "";
  let failure: Error | undefined;
  const worker = async () => {
    while (queue.length && !failure) {
      const item = queue.shift()!;
      try {
        const raw = await generateOne(promptFn(item), opts.numPredict);
        const cleaned = cleanFn(raw, item);
        if (cleaned) fh.writeSync(enc.encode(`${item.id}\t${cleaned}\n`));
        else {
          rejected++;
          firstRejected ||= raw;
        }
      } catch (e) {
        // Stop every worker; in-flight successes still reach the cache.
        failure ??= new Error(
          `[${label}] Ollama failed on "${item.id}" after ${done} items: ${
            (e as Error).message
          }. Rerun once it is fixed; the cache keeps finished items.`,
          { cause: e },
        );
        return;
      }
      done++;
      // A healthy model answers most prompts; mostly rejects means it is broken.
      if (done >= 200 && rejected / done > 0.5) {
        failure ??= new Error(
          `[${label}] expected under 50% rejected answers, received ${rejected}/${done}. First rejected answer: "${
            firstRejected.slice(0, 200)
          }". Check the prompt and ${GEN_MODEL}, then rerun.`,
        );
        return;
      }
      if (done % 200 === 0) {
        const rate = done / ((performance.now() - t0) / 1000);
        console.log(
          `  ${done}/${queue.length + done} (${rate.toFixed(1)}/s, eta ${
            (queue.length / rate / 60).toFixed(1)
          }min, rejected=${rejected})`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  fh.close();
  if (failure) throw failure;
  console.log(
    `[${label}] done ${done} (rejected=${rejected}) in ${
      ((performance.now() - t0) / 1000).toFixed(0)
    }s`,
  );
}

// Stage dedupe can merge a canonical id again, so aliases form chains.
export function loadAliasesCollapsed(): Map<string, string> {
  const path = `${BUILD}/3b_aliases.tsv`;
  const raw = new Map<string, string>();
  for (const [d, c] of uniqueIds(path, readRows(path, ALIAS_HEADER))) {
    if (d === c) {
      throw new Error(
        `${path}: expected an alias to name another id, received "${d}" → itself. ${
          rerun(path)
        }`,
      );
    }
    raw.set(d, c);
  }
  const collapsed = new Map<string, string>();
  for (const [d] of raw) {
    let cur = d;
    const seen = new Set<string>([cur]);
    for (let next = raw.get(cur); next !== undefined; next = raw.get(cur)) {
      if (seen.has(next) || seen.size > 64) {
        throw new Error(
          `${path}: expected alias chains to end, received a ${
            seen.has(next) ? "cycle" : "chain over 64 hops"
          } from "${d}" through "${next}". ${rerun(path)}`,
        );
      }
      seen.add(next);
      cur = next;
    }
    if (cur !== d) collapsed.set(d, cur);
  }
  return collapsed;
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function loadEmbCache(): Map<string, Float32Array> {
  const cache = new Map<string, Float32Array>();
  let data: Uint8Array;
  try {
    data = Deno.readFileSync(CACHE_PATH);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return cache;
    throw e;
  }
  if (data.byteLength % CACHE_RECORD_BYTES !== 0) {
    const whole = data.byteLength - data.byteLength % CACHE_RECORD_BYTES;
    throw new Error(
      `${CACHE_PATH}: expected a multiple of ${CACHE_RECORD_BYTES} bytes, received ${data.byteLength}. A run stopped mid-write; keep the whole records: truncate -s ${whole} ${CACHE_PATH}`,
    );
  }
  const n = data.byteLength / CACHE_RECORD_BYTES;
  for (let i = 0; i < n; i++) {
    const off = i * CACHE_RECORD_BYTES;
    const hash = hex(data.subarray(off, off + 32));
    const vec = new Float32Array(
      data.buffer.slice(
        data.byteOffset + off + 32,
        data.byteOffset + off + CACHE_RECORD_BYTES,
      ),
    );
    cache.set(hash, vec);
  }
  return cache;
}

export async function embedBatch(
  contents: string[],
  label: string,
): Promise<Float32Array[]> {
  const cache = loadEmbCache();
  const fh = Deno.openSync(CACHE_PATH, { create: true, append: true });
  const hashes = await Promise.all(contents.map(async (c) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(c)),
    )
  ));
  const hashHex = hashes.map(hex);
  const missing: number[] = [];
  for (let i = 0; i < contents.length; i++) {
    if (!cache.has(hashHex[i])) missing.push(i);
  }
  console.log(
    `[${label}] embedding ${contents.length} (${missing.length} new)`,
  );
  let done = 0;
  const t0 = performance.now();
  const queue = [...missing];
  async function worker() {
    while (queue.length) {
      const i = queue.shift()!;
      const vec = await embedOne(contents[i]);
      cache.set(hashHex[i], vec);
      const rec = new Uint8Array(CACHE_RECORD_BYTES);
      rec.set(hashes[i], 0);
      rec.set(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength), 32);
      fh.writeSync(rec);
      done++;
      if (done % 500 === 0) {
        const el = (performance.now() - t0) / 1000;
        console.log(
          `  ${done}/${missing.length} (${(done / el).toFixed(1)}/s)`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, () => worker()));
  fh.close();
  return contents.map((_, i) => cache.get(hashHex[i])!);
}

export function normalize(v: Float32Array, what: string): Float32Array {
  let sq = 0;
  for (let i = 0; i < v.length; i++) sq += v[i] * v[i];
  if (!(sq > 0)) {
    throw new Error(
      `embedding of ${what}: expected a nonzero, finite vector, received squared norm ${sq}. Rerun: deno run -A pipeline.ts embed`,
    );
  }
  const inv = 1 / Math.sqrt(sq);
  const r = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) r[i] = v[i] * inv;
  return r;
}

export function loadRawEmbeddings(): {
  ids: string[];
  emb: Float32Array;
  idToEmbIdx: Map<string, number>;
} {
  const ids = Deno.readTextFileSync(need(`${BUILD}/2_ids.tsv`)).split("\n")
    .filter((l) => l.length);
  const binPath = `${BUILD}/2_embeddings.bin`;
  const bin = Deno.readFileSync(need(binPath));
  if (bin.byteLength !== ids.length * EMBED_DIM * 4) {
    throw new Error(
      `${binPath}: expected ${
        ids.length * EMBED_DIM * 4
      } bytes (${ids.length} ids × ${EMBED_DIM} × 4), received ${bin.byteLength}. ${
        rerun(binPath)
      }`,
    );
  }
  const emb = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
  const idToEmbIdx = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) {
    if (idToEmbIdx.has(ids[i])) {
      throw new Error(
        `${BUILD}/2_ids.tsv:${i + 1}: expected unique ids, received a second "${
          ids[i]
        }". ${rerun(binPath)}`,
      );
    }
    idToEmbIdx.set(ids[i], i);
  }
  return { ids, emb, idToEmbIdx };
}

export function normalizedEmbeddingsForSkills(
  skillIds: string[],
): Float32Array {
  const { emb, idToEmbIdx } = loadRawEmbeddings();
  const vecs = new Float32Array(skillIds.length * EMBED_DIM);
  for (let i = 0; i < skillIds.length; i++) {
    const ei = idToEmbIdx.get(skillIds[i]);
    if (ei === undefined) {
      throw new Error(
        `${BUILD}/2_ids.tsv: expected an embedding for "${
          skillIds[i]
        }", received none. ${rerun(`${BUILD}/2_ids.tsv`)}`,
      );
    }
    vecs.set(
      normalize(
        emb.subarray(ei * EMBED_DIM, (ei + 1) * EMBED_DIM),
        `"${skillIds[i]}"`,
      ),
      i * EMBED_DIM,
    );
  }
  return vecs;
}

// ---------- MOOCCubeX ----------

export const TRANSLATE_CACHE = `${BUILD}/1f_translate.tsv`;
export const HAN_RE = /\p{Script=Han}/u;

type MoocPair = { domain: string; c1: string; c2: string };

// The cache value that seed-edges accepts as a translation.
export const isTranslation = (t: string | undefined): t is string =>
  !!t?.trim() && !HAN_RE.test(t) && !/[\t\r\n]/.test(t);

// Expert-confirmed (ground_truth 1) prereq pairs, c1 → c2.
export async function readMoocPairs(): Promise<MoocPair[]> {
  const pairs: MoocPair[] = [];
  for (const domain of ["cs", "math", "psy"]) {
    const path = `data/mooccubex/${domain}.json.gz`;
    let text: string;
    try {
      const stream = new Blob([Deno.readFileSync(path)]).stream().pipeThrough(
        new DecompressionStream("gzip"),
      );
      text = await new Response(stream).text();
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) throw e;
      throw new Error(
        `${path}: expected a gzip file of JSON lines, received an error: ${
          (e as Error).message
        }. Re-download it: deno run -A data/download.ts`,
      );
    }
    const before = pairs.length;
    text.split("\n").forEach((line, i) => {
      if (!line) return;
      const where = `${path}:${i + 1}`;
      let o: { c1?: unknown; c2?: unknown; ground_truth?: unknown };
      try {
        o = JSON.parse(line);
      } catch {
        throw new Error(
          `${where}: expected a JSON object, received ${line.slice(0, 80)}`,
        );
      }
      if (typeof o !== "object" || o === null || Array.isArray(o)) {
        throw new Error(
          `${where}: expected a JSON object, received ${line.slice(0, 80)}`,
        );
      }
      if (![-1, 0, 1].includes(o.ground_truth as number)) {
        throw new Error(
          `${where}: expected ground_truth as the number -1, 0, or 1, received ${
            JSON.stringify(o.ground_truth)
          }`,
        );
      }
      if (o.ground_truth !== 1) return;
      if (
        typeof o.c1 !== "string" || typeof o.c2 !== "string" || !o.c1 ||
        !o.c2 || /[\t\n]/.test(o.c1 + o.c2)
      ) {
        throw new Error(
          `${where}: expected labels c1 and c2 as non-empty strings without tabs, received ${
            JSON.stringify([o.c1, o.c2])
          }`,
        );
      }
      pairs.push({ domain, c1: o.c1, c2: o.c2 });
    });
    if (pairs.length === before) {
      throw new Error(
        `${path}: expected at least one pair with ground_truth 1, received none. Re-download it: deno run -A data/download.ts`,
      );
    }
  }
  return pairs;
}

// Unchecked: each caller validates the fields it reads.
export function readJson<T = unknown>(path: string): T {
  const text = Deno.readTextFileSync(path);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `${path}: expected JSON, received ${(e as Error).message}. ${
        path.startsWith(`${BUILD}/`) ? rerun(path) : "Re-download the file."
      }`,
    );
  }
}

// Kahn order, prereqs first. Nodes on a cycle never enter the order.
export function topoOrder(
  skills: { id: string; prereqs: string[] }[],
): string[] {
  const ids = new Set(skills.map((s) => s.id));
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const s of skills) {
    const ps = s.prereqs.filter((p) => p !== s.id && ids.has(p));
    indeg.set(s.id, ps.length);
    for (const p of ps) dependents.set(p, [...dependents.get(p) ?? [], s.id]);
  }
  const order = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  for (let i = 0; i < order.length; i++) {
    for (const d of dependents.get(order[i]) ?? []) {
      const left = indeg.get(d)! - 1;
      indeg.set(d, left);
      if (left === 0) order.push(d);
    }
  }
  return order;
}

// ---------- build tables ----------

export const LIST_HEADER = "id\ttitle\tdescription\tsources\ttags";
export const TAGGED_HEADER = `${LIST_HEADER}\toccupations\ttopics`;
export const DIFFICULTY_HEADER = "id\tdifficulty\tdifficulty_raw";
export const SEED_HEADER =
  "src_id\tdst_id\tsource\tconfidence\tholdout\tfallback";
export const EDGES_HEADER = "skill_id\tprereq_id";
export const PREREQ_CACHE = `${BUILD}/5_prereqs.tsv`;

// Rows of a build table after its header, which must match exactly.
export function readRows(path: string, header: string): string[][] {
  const lines = Deno.readTextFileSync(need(path)).split("\n").filter((l) =>
    l.length
  );
  if (lines[0] !== header) {
    throw new Error(
      `${path}: unexpected header.\n  expected: ${
        JSON.stringify(header)
      }\n  received: ${
        lines[0] === undefined ? "an empty file" : JSON.stringify(lines[0])
      }\n  ${rerun(path)}`,
    );
  }
  const n = header.split("\t").length;
  return lines.slice(1).map((l, i) => {
    const c = l.split("\t");
    if (c.length !== n) {
      throw new Error(
        `${path}:${i + 2}: expected ${n} columns, received ${c.length}. ${
          rerun(path)
        }`,
      );
    }
    return c;
  });
}

export const ALIAS_HEADER = "dropped_id\tcanonical_id";

// A skill table with no rows means its stage failed upstream.
function nonEmpty(path: string, rows: string[][]): string[][] {
  if (!rows.length) {
    throw new Error(
      `${path}: expected at least one row after the header, received none. ${
        rerun(path)
      }`,
    );
  }
  return rows;
}

// The rows, after a check that the first column is unique and present.
export function uniqueIds(path: string, rows: string[][]): string[][] {
  const seen = new Set<string>();
  rows.forEach((c, i) => {
    if (!c[0] || seen.has(c[0])) {
      throw new Error(
        `${path}:${i + 2}: expected unique ids, received a second "${c[0]}". ${
          rerun(path)
        }`,
      );
    }
    seen.add(c[0]);
  });
  return rows;
}

export type Tagged = {
  id: string;
  title: string;
  description: string;
  sources: string;
  tags: string;
  occupations: string;
  topics: string;
};

export function readTagged(path = TAGGED): Tagged[] {
  return nonEmpty(path, uniqueIds(path, readRows(path, TAGGED_HEADER))).map((
    [id, title, description, sources, tags, occupations, topics],
  ) => ({ id, title, description, sources, tags, occupations, topics }));
}

export function readDifficulty(): Map<string, { band: number; raw: number }> {
  const path = `${BUILD}/4_difficulty.tsv`;
  return new Map(
    nonEmpty(path, uniqueIds(path, readRows(path, DIFFICULTY_HEADER))).map(
      (c, i) => {
        const band = Number(c[1]), raw = Number(c[2]);
        if (!/^\d+$/.test(c[1]) || band < 1 || band > 20) {
          throw new Error(
            `${path}:${
              i + 2
            }: expected difficulty as an integer 1–20, received "${c[1]}". ${
              rerun(path)
            }`,
          );
        }
        if (c[2] === "" || !Number.isFinite(raw)) {
          throw new Error(
            `${path}:${i + 2}: expected a finite difficulty_raw, received "${
              c[2]
            }". ${rerun(path)}`,
          );
        }
        return [c[0], { band, raw }];
      },
    ),
  );
}

// 5_prereqs.tsv has no header: `skill\tp1,p2` or `skill\tnone`.
export function readPrereqPicks(): { skill: string; picks: string[] }[] {
  const text = Deno.readTextFileSync(need(PREREQ_CACHE));
  if (!text.endsWith("\n")) {
    throw new Error(
      `${PREREQ_CACHE}: expected rows that end in a newline, received ${
        text
          ? `a torn last row "${text.slice(text.lastIndexOf("\n") + 1)}"`
          : "an empty file"
      }. Delete the torn row. ${rerun(PREREQ_CACHE)}`,
    );
  }
  const seen = new Set<string>();
  return text.split("\n").filter((l) => l.length).map((l, i) => {
    const c = l.split("\t");
    if (c.length !== 2 || !c[0] || !c[1] || l.includes("\r")) {
      throw new Error(
        `${PREREQ_CACHE}:${
          i + 1
        }: expected "skill<TAB>p1,p2" or "skill<TAB>none", received ${
          JSON.stringify(l)
        }. ${rerun(PREREQ_CACHE)}`,
      );
    }
    if (seen.has(c[0])) {
      throw new Error(
        `${PREREQ_CACHE}:${
          i + 1
        }: expected one row per skill, received a second "${
          c[0]
        }". Delete one of the two rows.`,
      );
    }
    seen.add(c[0]);
    return { skill: c[0], picks: c[1] === "none" ? [] : c[1].split(",") };
  });
}

// Expert seed edges outside the holdout, with dedupe aliases applied.
export function readSeeds(): { pre: string; dep: string }[] {
  const alias = loadAliasesCollapsed();
  const path = `${BUILD}/1e_seed_edges.tsv`;
  return readRows(path, SEED_HEADER).filter((c, i) => {
    if (c[4] !== "0" && c[4] !== "1") {
      throw new Error(
        `${path}:${i + 2}: expected holdout 0 or 1, received "${c[4]}". ${
          rerun(path)
        }`,
      );
    }
    return c[4] === "0";
  }).map((c) => ({
    pre: alias.get(c[0]) ?? c[0],
    dep: alias.get(c[1]) ?? c[1],
  }));
}

// A stage-trees file: slug → ancestor slugs, nearest first.
export function readTree(path: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  Deno.readTextFileSync(need(path)).split("\n").forEach((line, i) => {
    if (!line) return;
    const [slug, anc, extra] = line.split("\t");
    if (!slug || !anc || extra !== undefined) {
      throw new Error(
        `${path}:${i + 1}: expected "slug<TAB>a1,a2", received "${
          line.slice(0, 80)
        }". ${rerun(path)}`,
      );
    }
    m.set(slug, anc.split(","));
  });
  return m;
}

// ---------- shared by two stage files ----------

export const TOPIC_REFS = `${BUILD}/1l_topic_refs.tsv`;

// Lookups from a skill title or slug to its id, for resolveConcept.
export function skillIndex(skills: { id: string; title: string }[]): {
  idSet: Set<string>;
  titleToId: Map<string, string>;
  slugToId: Map<string, string>;
} {
  const idSet = new Set<string>();
  const titleToId = new Map<string, string>();
  const slugToId = new Map<string, string>();
  for (const { id, title } of skills) {
    idSet.add(id);
    const t = title.toLowerCase().trim();
    if (t && !titleToId.has(t)) titleToId.set(t, id);
    slugToId.set(id, id);
    const altSlug = slugify(title);
    if (altSlug && !slugToId.has(altSlug)) slugToId.set(altSlug, id);
  }
  return { idSet, titleToId, slugToId };
}

export function resolveConcept(
  raw: string,
  idx: {
    idSet: Set<string>;
    titleToId: Map<string, string>;
    slugToId: Map<string, string>;
  },
): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/_/g, " ").replace(/\([^)]*\)/g, " ").replace(
    /\s+/g,
    " ",
  ).trim();
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

export function gradeToDifficulty(token: string): number | null {
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

export const SKILLS_HEADER =
  "id\ttitle\tdisplay_title\tdescription\tdifficulty\tprereqs\toccupations\ttopics\tgrade_start\tgrade_end";
