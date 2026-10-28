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

// NFKD leaves these Latin letters whole. Fold each to its ASCII spelling.
const FOLD: Record<string, string> = {
  ß: "ss",
  ø: "o",
  ł: "l",
  đ: "d",
  ı: "i",
  æ: "ae",
  œ: "oe",
  ð: "d",
  þ: "th",
};

const FOLD_RE = new RegExp(`[${Object.keys(FOLD).join("")}]`, "g");

export const slugify = (s: string) => {
  const base = decodeEntities(s).normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(FOLD_RE, (c) => FOLD[c])
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
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
  [`${BUILD}/1m_lc_ids.tsv`]: "list",
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
  const head = rows[0];
  const i = rows.findIndex((r, j) =>
    j > 0 && r.length === head.length && r.every((c, k) => c === head[k])
  );
  if (i > 0) {
    throw new Error(
      `${path}:${
        i + 1
      }: expected a data row, received a copy of the header. A file was concatenated twice; re-download it.`,
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
        const { response } = await ollama("/api/generate", {
          model: GEN_MODEL,
          prompt: promptFn(item),
          stream: false,
          options: { temperature: 0.1, num_predict: opts.numPredict ?? 120 },
        });
        if (typeof response !== "string") {
          throw new Error(
            `ollama ${GEN_MODEL}: expected a string response, received ${typeof response}`,
          );
        }
        const raw = response.replace(/[\t\n\r]/g, " ").trim();
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
  const path = ALIASES.path;
  const raw = new Map<string, string>();
  for (const { dropped_id: d, canonical_id: c } of readTable(ALIASES)) {
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
      const { embedding } = await ollama("/api/embeddings", {
        model: EMBED_MODEL,
        prompt: contents[i],
      });
      if (!Array.isArray(embedding) || embedding.length !== EMBED_DIM) {
        throw new Error(
          `ollama ${EMBED_MODEL}: expected a ${EMBED_DIM}-float embedding, received length ${
            Array.isArray(embedding) ? embedding.length : typeof embedding
          } for "${contents[i].slice(0, 60)}"`,
        );
      }
      const vec = new Float32Array(embedding);
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
  const ids = readTable(IDS).map((r) => r.id);
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
  const idToEmbIdx = new Map(ids.map((id, i) => [id, i]));
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

// ---------- University course prerequisites ----------

const TIMINGS = ["before", "concurrent", "before_or_concurrent"] as const;

// Mendeley fs2hvkps7z: a prerequisite edge names course codes, and a code means
// one course only inside its dataset (institution and edition). The join gives
// each code its title. Only timing "before" is a prerequisite. Each row of an
// OR group is its own pair.
// REVIEW: Treat each alternative of an OR group as a full prereq. Alternative:
// drop every is_alternative edge. It keeps only the mandatory edges and loses
// a quarter of the edges, and every course whose prereq is an "or".
// REVIEW: Key the pair on the two titles, so one pair stands for the many
// editions of a course. Alternative: keep one pair per edition. It counts a
// course once per catalog year and gives the 11-edition university 11 votes.
export async function readCoursePairs(): Promise<{
  pairs: { src: string; dst: string; raw: string }[];
  dropped: { from: string; to: string; raw: string; reason: string }[];
  timingCounts: Record<(typeof TIMINGS)[number], number>;
}> {
  const read = async (name: string): Promise<string[][]> => {
    const path = `data/courses/${name}.csv.gz`;
    try {
      const stream = new Blob([Deno.readFileSync(path)]).stream().pipeThrough(
        new DecompressionStream("gzip"),
      );
      return headed(
        path,
        parseCsvText(await new Response(stream).text(), { fieldsPerRecord: 0 }),
      );
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        throw new Deno.errors.NotFound(
          `${path}: missing. Run: deno run -A data/download.ts`,
        );
      }
      throw new Error(
        `${path}: expected a gzip file of RFC 4180 CSV with a constant field count, received ${
          (e as Error).message
        }. Re-download it: rm ${path}; deno run -A data/download.ts`,
      );
    }
  };
  const clean = (t: string) => t.replace(/\s+/g, " ").trim();
  const courses = await read("courses");
  const iDs = col(courses, "dataset", "data/courses/courses.csv.gz"),
    iCode = col(courses, "code", "data/courses/courses.csv.gz"),
    iTitle = col(courses, "title", "data/courses/courses.csv.gz");
  // A code printed twice with different titles is a parse artifact in the
  // source: the pair has no sure title. An empty title is no title.
  // REVIEW: A prereq code missing from `code` but present as `canonical_code`
  // stays no-course. Alternative: index canonical_code too. It may join a
  // different course, because the dataset does not say canonical_code is an alias.
  const titles = new Map<string, Set<string>>();
  for (const c of courses.slice(1)) {
    const k = `${c[iDs]}\t${c[iCode]}`;
    if (!titles.has(k)) titles.set(k, new Set());
    const t = clean(c[iTitle]);
    if (t) titles.get(k)!.add(t);
  }
  const edgesPath = "data/courses/prereq_edges.csv.gz";
  const edges = await read("prereq_edges");
  const iD = col(edges, "dataset", edgesPath),
    iS = col(edges, "source_prereq", edgesPath),
    iT = col(edges, "target_course", edgesPath),
    iAlt = col(edges, "is_alternative", edgesPath),
    iTiming = col(edges, "timing", edgesPath);
  const timingCounts = { before: 0, concurrent: 0, before_or_concurrent: 0 };
  const pairs: { src: string; dst: string; raw: string }[] = [];
  const dropped: { from: string; to: string; raw: string; reason: string }[] =
    [];
  const seen = new Set<string>();
  for (const [i, e] of edges.slice(1).entries()) {
    const timing = e[iTiming] as (typeof TIMINGS)[number];
    if (!TIMINGS.includes(timing)) {
      throw new Error(
        `${edgesPath}:${
          i + 2
        }: expected timing as before, concurrent, or before_or_concurrent, received ${
          JSON.stringify(e[iTiming])
        }. The source schema changed: read its data_dictionary.csv.`,
      );
    }
    if (e[iAlt] !== "0" && e[iAlt] !== "1") {
      throw new Error(
        `${edgesPath}:${i + 2}: expected is_alternative as 0 or 1, received ${
          JSON.stringify(e[iAlt])
        }. The source schema changed: read its data_dictionary.csv.`,
      );
    }
    timingCounts[timing]++;
    if (timing !== "before") continue;
    const raw = `${e[iD]}:${e[iS]}->${e[iT]}`;
    const title = (code: string): { t: string } | { reason: string } => {
      const t = titles.get(`${e[iD]}\t${code}`);
      if (!t) return { reason: "no-course" };
      if (t.size > 1) return { reason: "ambiguous-code" };
      const [only] = t;
      return only ? { t: only } : { reason: "no-title" };
    };
    const src = title(e[iS]), dst = title(e[iT]);
    if ("reason" in src || "reason" in dst) {
      const reason = "reason" in src
        ? src.reason
        : (dst as { reason: string }).reason;
      dropped.push({ from: e[iS], to: e[iT], raw, reason });
    } else if (!seen.has(`${src.t}\t${dst.t}`)) {
      seen.add(`${src.t}\t${dst.t}`);
      pairs.push({ src: src.t, dst: dst.t, raw });
    }
  }
  return { pairs, dropped, timingCounts };
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

// Tarjan, iterative. Returns each strongly connected component of 2+ nodes.
// `adj` maps a node to its successors; a node with no successors may be absent.
export function stronglyConnected<T>(adj: Map<T, T[]>): T[][] {
  const index = new Map<T, number>();
  const lowlink = new Map<T, number>();
  const onStack = new Set<T>();
  const stack: T[] = [];
  let idx = 0;
  const sccs: T[][] = [];
  const nodes = new Set<T>(adj.keys());
  for (const ws of adj.values()) for (const w of ws) nodes.add(w);
  const strongconnect = (v0: T) => {
    const callStack: { node: T; iter: Iterator<T>; minLink: number }[] = [];
    index.set(v0, idx);
    lowlink.set(v0, idx);
    idx++;
    stack.push(v0);
    onStack.add(v0);
    callStack.push({
      node: v0,
      iter: (adj.get(v0) || [])[Symbol.iterator](),
      minLink: lowlink.get(v0)!,
    });
    while (callStack.length) {
      const top = callStack[callStack.length - 1];
      const next = top.iter.next();
      if (next.done) {
        lowlink.set(top.node, top.minLink);
        if (lowlink.get(top.node) === index.get(top.node)) {
          const comp: T[] = [];
          while (true) {
            const w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
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
        index.set(w, idx);
        lowlink.set(w, idx);
        idx++;
        stack.push(w);
        onStack.add(w);
        callStack.push({
          node: w,
          iter: (adj.get(w) || [])[Symbol.iterator](),
          minLink: lowlink.get(w)!,
        });
      } else if (onStack.has(w)) {
        top.minLink = Math.min(top.minLink, index.get(w)!);
      }
    }
  };
  for (const n of nodes) if (!index.has(n)) strongconnect(n);
  return sccs;
}

// ---------- build tables ----------

// A cell checker: parse returns undefined to reject. `as` finishes "expected <column> as ...".
type Cell<T> = { as: string; parse: (s: string) => T | undefined };

const SLUG: Cell<string> = {
  as:
    "a slug (lowercase letters and digits joined by single hyphens, at most 80 characters)",
  parse: (s) =>
    s.length <= 80 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s) ? s : undefined,
};
const text: Cell<string> = { as: "text", parse: (s) => s };
const filled: Cell<string> = {
  as: "non-empty text",
  parse: (s) => s || undefined,
};
const int = (lo: number, hi: number): Cell<number> => ({
  as: `an integer ${lo}–${hi}`,
  parse: (s) => {
    const n = Number(s);
    return /^-?\d+$/.test(s) && n >= lo && n <= hi ? n : undefined;
  },
});
const finite: Cell<number> = {
  as: "a finite number",
  parse: (s) => /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : undefined,
};
const bit: Cell<boolean> = {
  as: "0 or 1",
  parse: (s) => s === "0" ? false : s === "1" ? true : undefined,
};
const grade: Cell<number | null> = {
  as: "an integer or empty",
  parse: (s) => s === "" ? null : /^-?\d+$/.test(s) ? Number(s) : undefined,
};
const slugs = (s: string): string[] | undefined => {
  const ids = s.split(",");
  return ids.every((i) => SLUG.parse(i) !== undefined) ? ids : undefined;
};
const slugList: Cell<string[]> = {
  as: "slugs joined by commas, or empty",
  parse: (s) => s === "" ? [] : slugs(s),
};
const picks: Cell<string[]> = {
  as: '"none" or slugs joined by commas',
  parse: (s) => s === "none" ? [] : slugs(s),
};

type Columns = Record<string, Cell<unknown>>;
type Schema<C extends Columns> = {
  path: string;
  columns: C;
  key?: keyof C & string;
  headerless?: true;
  empty?: true;
};
export type Row<C extends Columns> = {
  [K in keyof C]: C[K] extends Cell<infer T> ? T : never;
};
const table = <C extends Columns>(s: Schema<C>) => s;

const LIST_COLUMNS = {
  id: SLUG,
  title: filled,
  description: text,
  sources: filled,
  tags: text,
};
const TAGGED_COLUMNS = { ...LIST_COLUMNS, occupations: text, topics: text };
const SKILLS_COLUMNS = {
  id: SLUG,
  title: filled,
  display_title: filled,
  description: text,
  difficulty: int(1, 20),
  prereqs: slugList,
  occupations: slugList,
  topics: slugList,
  grade_start: grade,
  grade_end: grade,
};
export const PREREQ_CACHE = `${BUILD}/5_prereqs.tsv`;

export const SKILL_LIST = table({
  path: `${BUILD}/1_skills.tsv`,
  key: "id",
  columns: LIST_COLUMNS,
});
export const TAGGED_RAW = table({
  path: `${BUILD}/3_tagged.tsv`,
  key: "id",
  columns: TAGGED_COLUMNS,
});
export const TAGGED_DEDUPED = table({
  path: TAGGED,
  key: "id",
  columns: TAGGED_COLUMNS,
});
// Learning Commons node id to the skill id that holds it after stage list.
export const LC_IDS = table({
  path: `${BUILD}/1m_lc_ids.tsv`,
  key: "node_id",
  columns: { node_id: filled, skill_id: SLUG },
});
export const ALIASES = table({
  path: `${BUILD}/3b_aliases.tsv`,
  key: "dropped_id",
  empty: true,
  columns: { dropped_id: SLUG, canonical_id: SLUG },
});
export const DIFFICULTY = table({
  path: `${BUILD}/4_difficulty.tsv`,
  key: "id",
  columns: { id: SLUG, difficulty: int(1, 20), difficulty_raw: finite },
});
export const EDGES = table({
  path: `${BUILD}/6_edges.tsv`,
  empty: true,
  columns: { skill_id: SLUG, prereq_id: SLUG },
});
export const SEEDS = table({
  path: `${BUILD}/1e_seed_edges.tsv`,
  empty: true,
  columns: {
    src_id: SLUG,
    dst_id: SLUG,
    source: filled,
    confidence: finite,
    holdout: bit,
    fallback: bit,
  },
});
export const IDS = table({
  path: `${BUILD}/2_ids.tsv`,
  key: "id",
  headerless: true,
  columns: { id: SLUG },
});
export const PATHOLOGICAL = table({
  path: `${BUILD}/2_pathological.tsv`,
  key: "id",
  headerless: true,
  empty: true,
  columns: { id: SLUG },
});
export const PREREQS = table({
  path: PREREQ_CACHE,
  key: "skill",
  headerless: true,
  columns: { skill: SLUG, picks },
});
export const SKILLS_OUT = table({
  path: "skills.tsv",
  key: "id",
  columns: SKILLS_COLUMNS,
});

export type Tagged = Row<typeof TAGGED_COLUMNS>;

// Typed rows of a build table. Throws on the first row its writer would reject.
export function readTable<C extends Columns>(s: Schema<C>): Row<C>[] {
  return parseTable(s, Deno.readTextFileSync(need(s.path)));
}

function parseTable<C extends Columns>(s: Schema<C>, body: string): Row<C>[] {
  const fix = rerun(s.path);
  const fail = (line: number | null, msg: string): never => {
    throw new Error(`${s.path}${line ? `:${line}` : ""}: ${msg}. ${fix}`);
  };
  const names = Object.keys(s.columns);
  if (body && !body.endsWith("\n")) {
    fail(
      body.split("\n").length,
      `expected a newline after the last row, received "${
        body.slice(body.lastIndexOf("\n") + 1).slice(0, 80)
      }"`,
    );
  }
  const lines = body ? body.slice(0, -1).split("\n") : [];
  const first = s.headerless ? 1 : 2;
  if (!s.headerless && lines[0] !== names.join("\t")) {
    fail(
      1,
      `expected header ${JSON.stringify(names.join("\t"))}, received ${
        lines.length ? JSON.stringify(lines[0].slice(0, 200)) : "an empty file"
      }`,
    );
  }
  const data = lines.slice(first - 1);
  if (!data.length && !s.empty) {
    fail(
      null,
      `expected at least one row${
        s.headerless ? "" : " after the header"
      }, received none`,
    );
  }
  const seen = new Set<string>();
  return data.map((l, i) => {
    const line = first + i;
    const cells = l.split("\t");
    if (cells.length !== names.length) {
      fail(
        line,
        `expected ${names.length} tab-separated fields, received ${cells.length}`,
      );
    }
    const row: Record<string, unknown> = {};
    names.forEach((n, j) => {
      const v = s.columns[n].parse(cells[j]);
      if (v === undefined) {
        fail(
          line,
          `expected ${n} as ${s.columns[n].as}, received ${
            JSON.stringify(cells[j].slice(0, 80))
          }`,
        );
      }
      row[n] = v;
    });
    if (s.key) {
      const k = cells[names.indexOf(s.key)];
      if (seen.has(k)) {
        fail(line, `expected unique ${s.key}, received a second "${k}"`);
      }
      seen.add(k);
    }
    return row as Row<C>;
  });
}

// deno-lint-ignore no-explicit-any -- Schema<C> is invariant in C
type Write = [Schema<any>, string[][]] | [string, Uint8Array];

// Checks every table with readTable's checks, then renames them in order,
// so put the table that others depend on last.
export function writeTables(writes: Write[]) {
  const out = writes.map(([target, data]): [string, string | Uint8Array] => {
    if (typeof target === "string") return [target, data as Uint8Array];
    const names = Object.keys(target.columns);
    const lines = (data as string[][]).map((r) => r.join("\t"));
    const body = [...(target.headerless ? [] : [names.join("\t")]), ...lines]
      .map((l) => l + "\n").join("");
    parseTable(target, body);
    return [target.path, body];
  });
  for (const [path, data] of out) {
    const tmp = `${path}.tmp`;
    if (typeof data === "string") Deno.writeTextFileSync(tmp, data);
    else Deno.writeFileSync(tmp, data);
    Deno.renameSync(tmp, path);
  }
}

export const writeTable = <C extends Columns>(s: Schema<C>, rows: string[][]) =>
  writeTables([[s, rows]]);

export function readDifficulty(): Map<string, { band: number; raw: number }> {
  return new Map(
    readTable(DIFFICULTY).map((
      r,
    ) => [r.id, { band: r.difficulty, raw: r.difficulty_raw }]),
  );
}

// Expert seed edges outside the holdout, with dedupe aliases applied.
export function readSeeds(): { pre: string; dep: string }[] {
  const alias = loadAliasesCollapsed();
  return readTable(SEEDS).filter((r) => !r.holdout).map((r) => ({
    pre: alias.get(r.src_id) ?? r.src_id,
    dep: alias.get(r.dst_id) ?? r.dst_id,
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

// ---------- Learning Commons ----------

export type LearningCommons = {
  components: { id: string; text: string; grades: string[] }[];
  items: {
    id: string;
    text: string;
    code: string;
    type: string;
    grades: string[];
  }[];
  edges: {
    rel: "buildsTowards" | "hasStandardAlignment";
    from: string;
    to: string;
  }[];
};

export const LC_EXTRACT = "data/learningcommons/graph.jsonl.gz";

// The extract is the output of data/download.ts, one JSON object per line.
export function readLearningCommons(): LearningCommons {
  const fix = `Re-download it: rm ${LC_EXTRACT}; deno run -A data/download.ts`;
  const out = new Deno.Command("gzip", {
    args: ["-dc", LC_EXTRACT],
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (out.code !== 0) {
    throw new Error(
      `${LC_EXTRACT}: expected a gzip file, received gzip exit ${out.code}: ${
        new TextDecoder().decode(out.stderr).trim()
      }. ${fix}`,
    );
  }
  const lc: LearningCommons = { components: [], items: [], edges: [] };
  const ids = new Set<string>();
  let sawAttributions = false;
  const lines = new TextDecoder().decode(out.stdout).split("\n");
  if (lines.pop() !== "") {
    throw new Error(
      `${LC_EXTRACT}: expected a newline after the last row. ${fix}`,
    );
  }
  lines.forEach((line, i) => {
    const where = `${LC_EXTRACT}:${i + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch { /* the check below reports it */ }
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      throw new Error(
        `${where}: expected a JSON object, received ${
          line.slice(0, 80)
        }. ${fix}`,
      );
    }
    const o = parsed as Record<string, unknown>;
    const str = (k: string, nonEmpty = true): string => {
      const v = o[k];
      if (typeof v !== "string" || (nonEmpty && !v)) {
        throw new Error(
          `${where}: expected ${k} as ${
            nonEmpty ? "non-empty " : ""
          }text, received ${JSON.stringify(v)}. ${fix}`,
        );
      }
      return v;
    };
    const grades = (): string[] => {
      const v = o.grades;
      if (!Array.isArray(v) || !v.every((g) => typeof g === "string" && g)) {
        throw new Error(
          `${where}: expected grades as an array of text, received ${
            JSON.stringify(v)
          }. ${fix}`,
        );
      }
      return v;
    };
    const k = o.k;
    if (k === "attributions") {
      sawAttributions = true;
    } else if (k === "component" || k === "item") {
      const id = str("id");
      if (ids.has(id)) {
        throw new Error(
          `${where}: expected a unique id, received a second "${id}". ${fix}`,
        );
      }
      ids.add(id);
      if (k === "component") {
        lc.components.push({ id, text: str("text"), grades: grades() });
      } else {
        lc.items.push({
          id,
          text: str("text"),
          code: str("code", false),
          type: str("type", false),
          grades: grades(),
        });
      }
    } else if (k === "edge") {
      const rel = str("rel");
      if (rel !== "buildsTowards" && rel !== "hasStandardAlignment") {
        throw new Error(
          `${where}: expected rel as buildsTowards or hasStandardAlignment, received "${rel}". ${fix}`,
        );
      }
      lc.edges.push({ rel, from: str("from"), to: str("to") });
    } else {
      throw new Error(
        `${where}: expected k as attributions, component, item, or edge, received ${
          JSON.stringify(k)
        }. ${fix}`,
      );
    }
  });
  if (!sawAttributions) {
    throw new Error(
      `${LC_EXTRACT}: expected an attributions row, received none. ${fix}`,
    );
  }
  for (const e of lc.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      throw new Error(
        `${LC_EXTRACT}: expected both ends of ${e.rel} ${e.from} -> ${e.to} among the items, received a missing one. ${fix}`,
      );
    }
  }
  return lc;
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

// Labels with no exact skill, matched by embedding. A match needs cosine
// >= 0.90 and one shared token. `dropped` maps a label to its reason.
export async function embeddingFallback(
  labels: string[],
  skills: { id: string; title: string }[],
  stage: string,
): Promise<{ matched: Map<string, string>; dropped: Map<string, string> }> {
  const FALLBACK = 0.90;
  const sigTokens = (s: string): Set<string> => {
    const out = new Set<string>();
    for (
      const t of s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
        .filter(Boolean)
    ) {
      if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
    }
    return out;
  };
  const idSet = new Set(skills.map((s) => s.id));
  const titleById = new Map(skills.map((s) => [s.id, s.title]));
  const matched = new Map<string, string>();
  const dropped = new Map<string, string>();
  const { ids: embIds } = loadRawEmbeddings();
  const matIds = embIds.filter((id) => idSet.has(id));
  const mat = normalizedEmbeddingsForSkills(matIds);
  console.log(`[${stage}] active vectors: ${matIds.length}/${embIds.length}`);
  const labelVecs = (await embedBatch(labels, stage)).map((v, i) =>
    normalize(v, `label "${labels[i]}"`)
  );
  for (let li = 0; li < labels.length; li++) {
    const lv = labelVecs[li];
    let best = -1, bestScore = FALLBACK;
    for (let si = 0; si < matIds.length; si++) {
      const sv = mat.subarray(si * EMBED_DIM, (si + 1) * EMBED_DIM);
      let dot = 0;
      for (let k = 0; k < EMBED_DIM; k++) dot += lv[k] * sv[k];
      if (dot > bestScore) {
        bestScore = dot;
        best = si;
      }
    }
    if (best < 0) {
      dropped.set(labels[li], `below-cos-${FALLBACK}`);
      continue;
    }
    const lt = sigTokens(labels[li]);
    const tt = sigTokens(titleById.get(matIds[best]) || matIds[best]);
    let overlap = 0;
    for (const t of lt) if (tt.has(t)) overlap++;
    if (overlap === 0 || lt.size === 0) {
      dropped.set(labels[li], "no-token-overlap");
      continue;
    }
    matched.set(labels[li], matIds[best]);
  }
  console.log(
    `[${stage}] fallback matched ${matched.size}/${labels.length} @ cos≥${FALLBACK}`,
  );
  return { matched, dropped };
}

// ---------- LectureBank expert prerequisite pairs ----------

const LB = "data/lecturebank/LB-Paper";

export type ExpertPair = { pre: string; dep: string; positive: boolean };

// An annotation row `A,B,1` means topic A is a prerequisite of topic B. Each
// file lists every ordered pair of its topics, so a 0 is a real negative.
// REVIEW: A row naming a topic id that its topic file lacks counts as
// unresolved and is dropped, like a topic that matches no skill. LB1 has 829
// such rows, 8 of them positive: it names ids 210 and 211 but its topic file
// stops at 209. Alternative: throw. It blocks the whole eval on an upstream
// error that no code of ours can fix.
export function readLectureBank(): { pairs: ExpertPair[]; unnamed: number } {
  const sets: [string, RegExp, string, string][] = [
    // LB1 topics are `id,name,url`; the url is `NULL` for some, and a name may hold commas.
    [
      "",
      /^(\d+),(.+?)(?:,(?:NULL|https?:\/\/[^,]*))+$/,
      "208topics.csv",
      "prerequisite_annotation.csv",
    ],
    [
      "LectureBank2/data/",
      /^(\d+)\|(.+)$/,
      "322topics_final.tsv",
      "final_new_annotation.csv",
    ],
    [
      "LectureBankCD/data/",
      /^(\d+)\t(.+)$/,
      "CV.topics.tsv",
      "CV.annotation.csv",
    ],
    [
      "LectureBankCD/data/",
      /^(\d+)\t(.+)$/,
      "BIO.topics.tsv",
      "BIO.annotation.csv",
    ],
  ];
  const lines = (path: string): [number, string][] => {
    let text: string;
    try {
      text = Deno.readTextFileSync(path);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      throw new Deno.errors.NotFound(
        `${path}: missing. Run: deno run -A data/download.ts`,
      );
    }
    return text.split("\n").map((
      l,
      i,
    ): [number, string] => [i + 1, l.replace(/\r$/, "")]).filter(([, l]) => l);
  };
  const pairs: ExpertPair[] = [];
  let unnamed = 0;
  for (const [dir, topicRe, topicsFile, annFile] of sets) {
    const names = new Map<string, string>();
    for (const [n, l] of lines(`${LB}/${dir}${topicsFile}`)) {
      const m = l.match(topicRe);
      if (!m || names.has(m[1])) {
        throw new Error(
          `${LB}/${dir}${topicsFile}:${n}: expected a topic line with a new id, received ${
            JSON.stringify(l.slice(0, 80))
          }. The LectureBank format changed: update readLectureBank in lib.ts.`,
        );
      }
      names.set(m[1], m[2].trim());
    }
    for (const [n, l] of lines(`${LB}/${dir}${annFile}`)) {
      const m = l.match(/^(\d+),(\d+),([01])$/);
      if (!m) {
        throw new Error(
          `${LB}/${dir}${annFile}:${n}: expected "topic,topic,0|1", received ${
            JSON.stringify(l.slice(0, 80))
          }. The LectureBank format changed: update readLectureBank in lib.ts.`,
        );
      }
      const pre = names.get(m[1]), dep = names.get(m[2]);
      if (pre && dep) pairs.push({ pre, dep, positive: m[3] === "1" });
      else unnamed++;
    }
  }
  return { pairs, unnamed };
}

// Pairs are skill ids. `graph` maps a skill to its direct prereqs. A pair is
// annotated once, and positive when any set marks it so.
// REVIEW: Precision counts only the graph edges whose pair an expert annotated,
// because an unannotated edge has no label. Alternative: divide by every edge
// between matched topics. It reads a missing annotation as a wrong edge.
export function expertScores(
  graph: Map<string, string[]>,
  pairs: ExpertPair[],
): { positives: number; predicted: number; hits: number; recovered: number } {
  const annotated = new Map<string, boolean>();
  for (const p of pairs) {
    if (p.pre === p.dep) continue;
    const k = `${p.pre}\t${p.dep}`;
    annotated.set(k, annotated.get(k) || p.positive);
  }
  let predicted = 0, hits = 0;
  for (const [dep, pres] of graph) {
    for (const pre of pres) {
      const positive = annotated.get(`${pre}\t${dep}`);
      if (positive === undefined) continue;
      predicted++;
      if (positive) hits++;
    }
  }
  const ancestors = new Map<string, Set<string>>();
  const above = (id: string): Set<string> => {
    let seen = ancestors.get(id);
    if (seen) return seen;
    seen = new Set();
    const stack = [...graph.get(id) ?? []];
    while (stack.length) {
      const u = stack.pop()!;
      if (seen.has(u)) continue;
      seen.add(u);
      stack.push(...graph.get(u) ?? []);
    }
    ancestors.set(id, seen);
    return seen;
  };
  let positives = 0, recovered = 0;
  for (const [k, positive] of annotated) {
    if (!positive) continue;
    positives++;
    const [pre, dep] = k.split("\t");
    if (above(dep).has(pre)) recovered++;
  }
  return { positives, predicted, hits, recovered };
}
