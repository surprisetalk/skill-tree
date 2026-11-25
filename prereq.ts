import {
  ALIASES,
  BUILD,
  DIFFICULTY,
  dot,
  easier,
  EDGES,
  EMBED_DIM,
  embedBatch,
  EXPAND,
  FRAMEWORK_RE,
  inWorkers,
  type Ivf,
  IVF_EXACT_MAX,
  ivfIndex,
  ivfTop,
  loadAliasesCollapsed,
  loadTsvCache,
  normalize,
  normalizedEmbeddingsForSkills,
  PATHOLOGICAL,
  PREREQ_CACHE,
  PREREQS,
  readDifficulty,
  readSeeds,
  readTable,
  readTree,
  rerun,
  resolveConcept,
  resumableClaude,
  SEEDS,
  SIG_STOP,
  skillIndex,
  SKILLS_OUT,
  slugify,
  SNAP,
  STOPWORDS,
  stronglyConnected,
  TAGGED_DEDUPED,
  tagGrades,
  topoOrder,
  WIKI_CAT_RE,
  writeTable,
  YEAR_RE,
} from "./lib.ts";
import type { Columns, Schema } from "./lib.ts";
import { oakPriorNames } from "./sources.ts";

// ---------- stage prereq ----------

// A skill's Skills England levels, 2 (GCSE) to 7 (master's): one per standard
// that states it.
const seLevels = (tags: string): number[] =>
  [...tags.matchAll(/(?:^|,)skillsengland:level:(\d)/g)].map((m) =>
    Number(m[1])
  );
// REVIEW: A prereq whose lowest Skills England level sits above its
// dependent's highest level is no prereq: a level-6 statement does not lead
// to a level-2 one. Stage prereq leaves it out of the candidate pool, and
// stage postproc drops such a named edge. Alternative: a status condition
// that counts them. It reports such edges but ships them.
const seMin = (tags: string) => Math.min(...seLevels(tags), 99);
const seMax = (tags: string) => Math.max(...seLevels(tags), 0);
const seInverted = (depTags: string, preTags: string) => {
  const d = seLevels(depTags), p = seLevels(preTags);
  return d.length > 0 && p.length > 0 && seMin(preTags) > seMax(depTags);
};

type SkillWithDiff = {
  id: string;
  title: string;
  description: string;
  topics: string;
  occupations: string;
  sources: string;
  tags: string;
  gradeStart: number; // -2 = unknown
  gradeEnd: number; // -2 = unknown
};

function parseSkillsWithDifficulty(): {
  skills: SkillWithDiff[];
  diff: Int32Array;
  raw: Float32Array;
} {
  const skills: SkillWithDiff[] = readTable(TAGGED_DEDUPED).map((s) => {
    const gs = tagGrades(s.tags);
    return {
      ...s,
      gradeStart: gs.length ? Math.min(...gs) : -2,
      gradeEnd: gs.length ? Math.max(...gs) : -2,
    };
  });
  const dm = readDifficulty();
  const diff = new Int32Array(skills.length);
  const raw = new Float32Array(skills.length);
  for (let i = 0; i < skills.length; i++) {
    const e = dm.get(skills[i].id);
    if (!e) {
      throw new Error(
        `${BUILD}/4_difficulty.tsv: expected a row for "${
          skills[i].id
        }", received none. ${rerun(`${BUILD}/4_difficulty.tsv`)}`,
      );
    }
    diff[i] = e.band;
    raw[i] = e.raw;
  }
  return { skills, diff, raw };
}

// One language is never a prereq of another.
const LANG_TOKENS = [
  "spanish",
  "french",
  "german",
  "italian",
  "portuguese",
  "chinese",
  "japanese",
  "greek",
  "latin",
  "arabic",
  "korean",
  "russian",
  "hebrew",
  "swazi",
  "kanuri",
  "pulaar",
];
export function langTokenOf(id: string): string | null {
  for (const t of LANG_TOKENS) {
    if (
      id === t || id.startsWith(`${t}-`) || id.includes(`-${t}-`) ||
      id.endsWith(`-${t}`)
    ) return t;
  }
  return null;
}

// Study skills are never candidate prereqs.
const STUDY_SKILL_RE =
  /^(take[- ]notes?|mental[- ]concentration|find[- ]a[- ]dedicated|test[- ]anxiety|time[- ]management|study[- ]space|ask[- ]for[- ]help)/i;

// Cross-domain foundation whitelist — these are cross-domain prereqs we want to
// preserve in within-topic shared-token guards (R3). Mirrors the postproc FOUNDATION set.
const FOUNDATION_IDS = new Set([
  "mathematics",
  "math",
  "arithmetic",
  "reading",
  "writing",
  "literacy",
  "numeracy",
  "problem-solving",
  "critical-thinking",
  "research",
  "communication",
  "algebra",
  "geometry",
  "statistics",
  "probability",
]);

// One worker's share of the candidate search: skills w, w + of, w + 2·of, …
// The arrays sit on SharedArrayBuffers, so no worker copies them.
export type CandidateShare = {
  job: "candidates";
  vecs: Float32Array;
  cent: Float32Array;
  // The IVF lists end to end: list c is members[starts[c]..starts[c + 1]].
  members: Int32Array;
  starts: Int32Array;
  w: number;
  of: number;
};

export function candidateShare(
  { vecs, cent, members, starts, w, of }: CandidateShare,
): {
  out: [number, number[]][];
  secs: Record<string, number>;
  fullScans: number;
} {
  const ivf = {
    cent,
    lists: Array.from(
      { length: starts.length - 1 },
      (_, c) => [...members.subarray(starts[c], starts[c + 1])],
    ),
  };
  const { skills, diff, raw } = parseSkillsWithDifficulty();
  const topicIdx = new Map<string, number[]>();
  for (let i = 0; i < skills.length; i++) {
    for (const t of skills[i].topics.split(",")) {
      if (!t) continue;
      let arr = topicIdx.get(t);
      if (!arr) {
        arr = [];
        topicIdx.set(t, arr);
      }
      arr.push(i);
    }
  }
  const pathological = new Set(readTable(PATHOLOGICAL).map((r) => r.id));
  // TODO: Stage prereq reaches more expert prereq pairs in its candidate
  // pool, and classifies with Cloudflare Clef where Clef beats Haiku 5.5.
  // Facts: `@cf/cloudflare/clef-flash` (9B), `noul` yes/no questions, 1–64 per
  // call, $0.038/M input, 10k neurons a day free. CLOUDFLARE_API_TOKEN is in
  // .env. Snap stays on Haiku: on 50 disagreements an Opus judge finds Haiku
  // right 35 times, Clef 13 (build/clef/snap_labels.tsv; you spot-check rows
  // 2, 4, 11, 14, 22, 26, 29, 32, 49, 50). Pool (14 Nov, LectureBank 258
  // positives): 44% fail the easier-than guard in candOk, 37% share no topic
  // with the dependent, 15% rank past the top slots, 2% reach the pool. Junyi:
  // 17 of 70 reach it. Picks on Junyi (68 dependents): clef-flash p ≥ 0.5 8/8,
  // Haiku 5/5; too few graded edges to decide. Expert labels resolve at most 1
  // in 6 even with loose matching: about 60% name a concept the graph lacks
  // (LectureBank is ML, NLP, vision, bio). Study scripts: build/clef/.
  //   1. Add 20 exact-cosine slots from all valid skills, any topic, at the
  //      end of candidateShare (K 15 → 35). Measured: LectureBank 5 → 12 of
  //      258, Junyi 17 → 24 of 70. Cost: 2.3× prompt tokens a skill, which
  //      voids the CSP spend estimate. Leave the easier-than guard on: a
  //      harder candidate yields inverted edges.
  //   2. Rerun the Junyi and LectureBank pick trials on the 35-candidate
  //      pools. Switch prereq to clef-flash only if its precision holds on at
  //      least 20 graded edges.
  const K = 15;
  // Shorter tokens ("prepar") link prepare-medication to prepare-pasta.
  const TOK_MIN = 7;
  // Each skill's fields, split once: the filters read them for every pair.
  const longToks = (s: string) =>
    s.split("-").filter((t) => t.length >= TOK_MIN);
  const topicsOf = skills.map((s) => s.topics.split(",").filter(Boolean));
  const occsOf = skills.map((s) => s.occupations.split(",").filter(Boolean));
  const idToksOf = skills.map((s) => longToks(s.id));
  const topicToksOf = topicsOf.map((ts) => ts.map(longToks));
  const isPathological = skills.map((s) => pathological.has(s.id));
  const isFoundation = skills.map((s) => FOUNDATION_IDS.has(s.id));
  // Each topic's members by raw difficulty, easiest first, for the ancestors.
  const byRaw = new Map(
    [...topicIdx].map((
      [t, arr],
    ) => [t, arr.toSorted((a, b) => raw[a] - raw[b])]),
  );
  // Each long topic token → the topics that hold it, in topicIdx order, so a
  // skill finds its cross-topic pool without a pass over every topic.
  const topicsOfTok = new Map<string, number[]>();
  const topicList = [...topicIdx.values()];
  [...topicIdx.keys()].forEach((t, ti) => {
    for (const tok of new Set(t.split("-"))) {
      if (tok.length < TOK_MIN) continue;
      const arr = topicsOfTok.get(tok) ?? [];
      arr.push(ti);
      topicsOfTok.set(tok, arr);
    }
  });
  const ANCESTOR_K = 5;
  const GLOBAL_K = 5;
  // A skill whose only topics are framework slugs becomes a phantom hub in the
  // global pool.
  const frameworkOnly = new Uint8Array(skills.length);
  const FRAME_RE =
    /-standards|^sced-|-\d{4}|framework|curriculum|scope-and-sequence/;
  for (let i = 0; i < skills.length; i++) {
    const topics = skills[i].topics.split(",").filter(Boolean);
    if (topics.length === 0) frameworkOnly[i] = 1;
    else if (topics.every((t) => FRAME_RE.test(t))) frameworkOnly[i] = 1;
  }
  // Precompute per-skill grade caps and filter flags
  const slugLangs = skills.map((s) => langTokenOf(s.id));
  const isSced = skills.map((s) =>
    s.tags.includes("sced:catalog") &&
    !/\b(esco|onet|lightcast)\b/.test(s.sources)
  );
  const isStudyMeta = skills.map((s) => STUDY_SKILL_RE.test(s.id));
  const seTags = skills.map((s) => s.tags.includes("skillsengland:level:"));
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
    if (isPathological[j]) return false;
    if (isSced[j]) return false; // R1
    if (isStudyMeta[j] && !isStudyMeta[i]) return false; // R4
    const lj = slugLangs[j];
    if (lj && slugLangs[i] && lj !== slugLangs[i]) return false; // R6
    if (gradeGapReject(i, j)) return false; // R2
    if (seTags[i] && seTags[j] && seInverted(skills[i].tags, skills[j].tags)) {
      return false;
    }
    // REVIEW: A candidate only needs a lower raw than its target. Expert seed
    // pairs sit close in difficulty: a 1.5 gap admitted 22% of them, fewer than
    // the 38% of random pairs it admitted, and a 0 gap admits 60%. Alternative:
    // read the seed-ordered band (51%), or restore the old seed raw, which set
    // a prereq 1.0 below its dependent and so still failed the 1.5 gap.
    return raw[j] < raw[i] || diff[j] < diff[i]; // DR1 hard guard, as `easier`
  };

  const out: [number, number[]][] = [];
  // Seconds per part, summed over skills: the CSP scale needs the slow one.
  const secs: Record<string, number> = {};
  let tl = performance.now(), fullScans = 0;
  const lap = (part: string) => {
    const now = performance.now();
    secs[part] = (secs[part] ?? 0) + (now - tl) / 1000;
    tl = now;
  };
  for (let i = w; i < skills.length; i += of) {
    lap("other");
    const topics = topicsOf[i];
    const myOccs = new Set<string>(occsOf[i]);
    const myToks = new Set<string>(topicToksOf[i].flat());
    const sharesTok = (toks: string[]) => toks.some((t) => myToks.has(t));
    // How many of j's topics hold one of i's tokens, counted up to 2.
    const topicsSharingTok = (j: number) => {
      let n = 0;
      for (const toks of topicToksOf[j]) if (sharesTok(toks) && ++n >= 2) break;
      return n;
    };

    // R3 within-topic shared-token guard: candidate must share ≥1 topic token,
    // OR share an occupation, OR be in FOUNDATION_IDS.
    const withinTopicOk = (j: number): boolean =>
      isFoundation[j] || occsOf[j].some((o) => myOccs.has(o)) ||
      sharesTok(idToksOf[j]) || topicToksOf[j].some(sharesTok);

    const pool = new Set<number>();
    for (const t of topics) {
      const arr = topicIdx.get(t);
      if (!arr) continue;
      for (const j of arr) if (candOk(i, j) && withinTopicOk(j)) pool.add(j);
    }
    lap("topic_pool");
    // null: every skill that passes candOk.
    let cands: number[] | null;
    if (pool.size >= K) cands = [...pool];
    else if (
      skills[i].sources.split(",").filter(Boolean).length >= 2 && pool.size < 3
    ) {
      // M1: multi-source skill with sparse pool — skip global fallback, let LLM say "none"
      cands = [...pool];
    } else {
      cands = null;
      fullScans++;
    }
    lap("full_scan");

    // Ancestor candidates — foundations within same topic (or expanded for advanced skills)
    const ancestorSet = new Set<number>();
    // R9/R10: top-quintile OR specialized-tool skills get relaxed ancestor gap (0.1 vs 2)
    const isSpecialized = skills[i].sources.includes("lightcast") &&
      /specialized-skill|-package$|-framework$|-library$|-middleware$|-software$/
        .test(skills[i].id + "|" + skills[i].tags);
    const ancestorMin = (raw[i] >= topQuintileRaw || isSpecialized) ? 0.1 : 2;
    if (topics.length > 0 && ANCESTOR_K > 0) {
      const aMax = raw[i] - ancestorMin;
      for (const t of topics) {
        const sorted = byRaw.get(t);
        if (!sorted) continue;
        for (
          let k = 0;
          k < sorted.length && ancestorSet.size < ANCESTOR_K;
          k++
        ) {
          const j = sorted[k];
          if (raw[j] > aMax) break;
          if (!candOk(i, j)) continue;
          ancestorSet.add(j);
        }
        if (ancestorSet.size >= ANCESTOR_K) break;
      }
    }
    lap("ancestor");

    const sOff = i * EMBED_DIM;
    const top: { idx: number; score: number }[] = [];
    const globalTop: { idx: number; score: number }[] = [];
    const inTopicSlots = Math.max(1, K - ancestorSet.size - GLOBAL_K);
    const consider = (j: number) => {
      if (ancestorSet.has(j)) return;
      const sc = dot(vecs, sOff, vecs, j * EMBED_DIM);
      if (top.length < inTopicSlots) {
        top.push({ idx: j, score: sc });
        if (top.length === inTopicSlots) top.sort((a, b) => a.score - b.score);
      } else if (sc > top[0].score) {
        top[0] = { idx: j, score: sc };
        top.sort((a, b) => a.score - b.score);
      }
    };
    if (cands && cands.length <= IVF_EXACT_MAX) cands.forEach(consider);
    else {
      const inPool = cands ? new Set(cands) : null;
      top.push(
        ...ivfTop(
          ivf,
          vecs,
          vecs.subarray(sOff, sOff + EMBED_DIM),
          inTopicSlots,
          (j) => !ancestorSet.has(j) && (inPool ? inPool.has(j) : candOk(i, j)),
        ),
      );
    }
    top.sort((a, b) => b.score - a.score);
    lap("cosine_top");
    const picked = new Set<number>([
      ...ancestorSet,
      ...top.map((t) => t.idx),
      i,
    ]);
    if (GLOBAL_K > 0 && (topics.length > 0 || skills[i].occupations)) {
      const crossTopics = new Set<number>();
      for (const tok of myToks) {
        for (const ti of topicsOfTok.get(tok) ?? []) crossTopics.add(ti);
      }
      const crossPool = new Set<number>();
      for (const ti of [...crossTopics].sort((a, b) => a - b)) {
        for (const j of topicList[ti]) crossPool.add(j);
      }
      for (const j of crossPool) {
        if (picked.has(j)) continue;
        if (!candOk(i, j)) continue;
        if (frameworkOnly[j]) continue; // H2: framework-only skills never enter global pool
        const occShared = occsOf[j].some((o) => myOccs.has(o));
        if (!occShared && topicsSharingTok(j) < 2) continue;
        const sc = dot(vecs, sOff, vecs, j * EMBED_DIM);
        if (globalTop.length < GLOBAL_K) {
          globalTop.push({ idx: j, score: sc });
          if (globalTop.length === GLOBAL_K) {
            globalTop.sort((a, b) => a.score - b.score);
          }
        } else if (sc > globalTop[0].score) {
          globalTop[0] = { idx: j, score: sc };
          globalTop.sort((a, b) => a.score - b.score);
        }
      }
      globalTop.sort((a, b) => b.score - a.score);
    }
    lap("cross_topic");

    // S5-3: near-duplicate cluster dedup — if >2 candidates have pairwise cosine ≥0.97,
    // keep only the highest-scoring. Prevents identical K-grade standards flooding slots.
    const allPicks: {
      idx: number;
      score: number;
      src: "anc" | "top" | "global";
    }[] = [
      ...[...ancestorSet].map((idx) => ({
        idx,
        score: 0,
        src: "anc" as const,
      })),
      ...top.map((t) => ({ ...t, src: "top" as const })),
      ...globalTop.map((t) => ({ ...t, src: "global" as const })),
    ];
    const DUP_COS = 0.97;
    const dropped = new Set<number>();
    for (let a = 0; a < allPicks.length; a++) {
      if (dropped.has(a)) continue;
      const aOff = allPicks[a].idx * EMBED_DIM;
      for (let b = a + 1; b < allPicks.length; b++) {
        if (dropped.has(b)) continue;
        const sc = dot(vecs, aOff, vecs, allPicks[b].idx * EMBED_DIM);
        if (sc >= DUP_COS) {
          // keep higher-scoring (or lower index for ancestors — score 0)
          if (allPicks[a].score >= allPicks[b].score) dropped.add(b);
          else {
            dropped.add(a);
            break;
          }
        }
      }
    }
    const kept = allPicks.filter((_, k) => !dropped.has(k));
    const idxs = kept.map((p) => p.idx).slice(0, K);
    out.push([i, idxs]);
    lap("dedupe");
  }
  lap("other");
  return { out, secs, fullScans };
}

// REVIEW: Workers split the candidate search, one per core, and at least
// WORKER_SKILLS skills each: a worker first reads the skill tables itself.
// Each skill's candidates read only shared data, so the output is the same
// for any split. At 93k: 157 s on one thread, 22 s on 10 workers.
// Alternative: one thread. It took 41 min at 392k skills.
const WORKER_SKILLS = 10_000;
async function prereqCandidates(
  vecs: Float32Array,
  ivf: Ivf,
  ids: string[],
): Promise<Map<string, number[]>> {
  const shared = <T extends Float32Array | Int32Array>(
    make: (b: SharedArrayBuffer) => T,
    from: ArrayLike<number>,
  ): T => {
    const a = make(new SharedArrayBuffer(from.length * 4));
    a.set(from);
    return a;
  };
  const starts = [0];
  for (const l of ivf.lists) starts.push(starts.at(-1)! + l.length);
  const share = {
    job: "candidates" as const,
    vecs,
    cent: shared((b) => new Float32Array(b), ivf.cent),
    members: shared((b) => new Int32Array(b), ivf.lists.flat()),
    starts: shared((b) => new Int32Array(b), starts),
  };
  const of = Math.max(
    1,
    Math.min(
      navigator.hardwareConcurrency,
      Math.ceil(ids.length / WORKER_SKILLS),
    ),
  );
  const t0 = performance.now();
  const shares = await inWorkers<
    CandidateShare,
    ReturnType<typeof candidateShare>
  >(
    Array.from({ length: of }, (_, w) => ({ ...share, w, of })),
    "prereq",
    "candidate lists",
  );
  const secs: Record<string, number> = {};
  for (const r of shares) {
    for (const [k, v] of Object.entries(r.secs)) secs[k] = (secs[k] ?? 0) + v;
  }
  console.log(
    `[prereq] candidates: ${of} workers, ${
      ((performance.now() - t0) / 1000).toFixed(1)
    } s; worker seconds ${
      Object.entries(secs).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(" ")
    }; full scans ${shares.reduce((n, r) => n + r.fullScans, 0)}/${ids.length}`,
  );
  const byIdx: number[][] = [];
  for (const r of shares) for (const [i, c] of r.out) byIdx[i] = c;
  return new Map(ids.map((id, i) => [id, byIdx[i]]));
}

const PREREQ_PROMPT =
  `You identify true prerequisites for a skill. Given a skill and a numbered list of candidate prerequisites (all from easier/earlier material), return the numbers of candidates that MUST be understood first before learning the skill. Be strict — only include genuinely foundational dependencies, not merely related or adjacent topics. Return ONLY a comma-separated list of numbers (e.g. "2,5,9") or the word "none". No explanation.`;

const PREREQ_PICK_CAP = 8;

// Candidate indexes from "none" or "2,5,9", or null for any other reply: an
// empty or prose reply is a failed answer, not a "no prereqs" answer.
function parsePrereqResponse(text: string, n: number): number[] | null {
  const t = text.trim().toLowerCase().replace(/\.$/, "");
  if (t === "none" || t === "n/a") return [];
  if (!/^\d+(\s*,\s*\d+)*$/.test(t)) return null;
  const ks = [...new Set(t.split(",").map(Number))];
  if (ks.some((k) => k < 1 || k > n)) return null;
  return ks.map((k) => k - 1).slice(0, PREREQ_PICK_CAP);
}

// Rewrites a cache without its stale rows, so their prompts go out again. A
// repeated key (a torn append) keeps one row, as loadTsvCache reads it.
function prune<C extends Columns>(
  t: Schema<C>,
  keep: (key: string, value: string) => boolean,
): void {
  const cache = loadTsvCache(t.path);
  if (!cache.size) return;
  const lines = Deno.readTextFileSync(t.path).split("\n").length - 1;
  const fresh = [...cache].filter(([k, v]) => keep(k, v));
  if (fresh.length === lines) return;
  // An empty table does not write; a missing cache reads as empty.
  if (fresh.length) writeTable(t, fresh);
  else Deno.removeSync(t.path);
  console.log(
    `[prereq] dropped ${
      lines - fresh.length
    } of ${lines} rows of ${t.path}: a gone id, a stale pick, or a repeated key`,
  );
}

export async function stagePrereq() {
  const { skills, diff, raw } = parseSkillsWithDifficulty();
  // A cache row is stale when it names an id outside this build (a rename or
  // a merge), or a pick no easier than its skill: raw difficulty moved, and
  // the pool the pick came from is gone.
  const dOf = new Map(
    skills.map((s, i) => [s.id, { band: diff[i], raw: raw[i] }]),
  );
  prune(PREREQS, (s, ps) => {
    const ds = dOf.get(s);
    return ds !== undefined &&
      (ps === "none" || ps.split(",").every((p) => easier(dOf.get(p), ds)));
  });
  prune(EXPAND, (s) => dOf.has(s));
  // SKIP_LLM=1 reuses the caches, less stale rows: a regression build needs no
  // generator.
  if (Deno.env.get("SKIP_LLM") === "1") {
    console.log("[prereq] SKIP_LLM=1: using existing caches only");
    return;
  }
  const vecs = normalizedEmbeddingsForSkills(skills.map((s) => s.id));
  const tIvf = performance.now();
  const ivf = ivfIndex(vecs, skills.length);
  console.log(
    `[prereq] ivf: ${ivf.lists.length} lists in ${
      ((performance.now() - tIvf) / 1000).toFixed(1)
    } s`,
  );
  const candidates = await prereqCandidates(
    vecs,
    ivf,
    skills.map((s) => s.id),
  );
  const jobs = skills.flatMap((s) => {
    const cands = candidates.get(s.id);
    return cands?.length ? [{ ...s, cands }] : [];
  });
  await resumableClaude(
    "prereq",
    PREREQ_CACHE,
    jobs,
    (job) => {
      const desc = job.description
        ? `\nDescription: ${job.description.slice(0, 200)}`
        : "";
      const list = job.cands.map((j, i) => `${i + 1}. ${skills[j].title}`)
        .join("\n");
      return `${PREREQ_PROMPT}\n\nSkill: ${job.title}${desc}\n\nCandidates:\n${list}\n\nPrerequisite numbers (or "none"):`;
    },
    {
      numPredict: 600,
      think: true,
      // "" rejects the reply; "none" caches an empty pick list.
      clean: (raw, job) => {
        const picks = parsePrereqResponse(raw, job.cands.length);
        if (!picks) return "";
        return picks.map((p) => skills[job.cands[p]].id).join(",") || "none";
      },
    },
  );

  // REVIEW: Claude also names each skill's prereqs, and each name snaps to a
  // skill: retrieval cannot reach a cross-domain prereq (linear-algebra →
  // computer-vision). On the 85 dependents of 252 missed expert pairs (11 Nov,
  // Haiku 5.5) it named 28 of them. Haiku runs both steps, as in the trial.
  // Alternative: Sonnet 5.5 for the names; a few times the
  // cost over every skill. Alternative: no expand. It saves about a quarter of
  // the cost, but in the 14 Nov build LectureBank recall falls from 0.207 to
  // 0.039 and Junyi recall from 0.173 to 0.128 without the named edges.
  await resumableClaude(
    "prereq:expand",
    EXPAND.path,
    skills,
    (s) =>
      `${EXPAND_PROMPT}\n\nSkill: ${s.title}${
        s.description ? `\nDescription: ${s.description.slice(0, 2500)}` : ""
      }`,
    {
      numPredict: 200,
      schema: EXPAND_SCHEMA,
      clean: (raw) => {
        const names = parseExpand(raw);
        return names === null ? "" : names.join("; ") || "none";
      },
    },
  );
}

// ---------- stage snap ----------

// Matches each named prereq to a skill: Claude's expand names, and Oak's
// prior-knowledge statements. An exact match needs no prompt; else Claude
// picks from the name's SNAP_K nearest skills.
// REVIEW: Every inexact name gets a prompt. Alternative: take the nearest
// skill above a cosine gate without one. Over 21,634 cached answers, 0.5% of
// names reach 0.90, and there Claude chose the nearest skill only 51% of the
// time.
export async function stageSnap() {
  const { skills } = parseSkillsWithDifficulty();
  const ids = new Set(skills.map((s) => s.id));
  // A merge in stage dedupe renames a match; postproc follows the alias.
  const alias = loadAliasesCollapsed();
  prune(SNAP, (_, m) => m === "none" || ids.has(alias.get(m) ?? m));
  if (Deno.env.get("SKIP_LLM") === "1") {
    console.log("[snap] SKIP_LLM=1: using existing caches only");
    return;
  }
  const named: { dep: string; name: string }[] = [
    ...[...loadTsvCache(EXPAND.path)].flatMap(([dep, names]) =>
      names === "none" || !ids.has(dep)
        ? []
        : names.split("; ").map((name) => ({ dep, name }))
    ),
    ...oakPriorNames(skills),
  ];
  const vecs = normalizedEmbeddingsForSkills(skills.map((s) => s.id));
  const ivf = ivfIndex(vecs, skills.length);
  const idx = skillIndex(skills);
  const snapped = loadTsvCache(SNAP.path);
  const exact: string[][] = [];
  const toSnap = new Map<string, { id: string; name: string; dep: string }>();
  for (const { dep, name } of named) {
    const key = slugify(name);
    if (snapped.has(key) || toSnap.has(key)) continue;
    const id = resolveConcept(name, idx);
    if (id) {
      snapped.set(key, id);
      exact.push([key, id]);
    } else toSnap.set(key, { id: key, name, dep });
  }
  // An exact match needs no prompt; it joins the cache as an answer.
  if (exact.length) {
    Deno.writeTextFileSync(
      SNAP.path,
      exact.map((r) => r.join("\t") + "\n").join(""),
      { append: true },
    );
  }
  const byId = new Map(skills.map((s) => [s.id, s]));
  const ask = [...toSnap.values()];
  console.log(
    `[snap] ${exact.length} exact, ${ask.length} to snap`,
  );
  const vecsOf = await embedBatch(
    ask.map((t) =>
      t.name.length < 40 ? `${t.name}. Skill: ${t.name}. ${t.name}.` : t.name
    ),
    "snap",
  );
  const snapJobs = ask.map((t, k) => ({
    ...t,
    cands: ivfTop(
      ivf,
      vecs,
      normalize(vecsOf[k], `prereq name "${t.name}"`),
      SNAP_K,
      () => true,
    ).map((c) => skills[c.idx].id),
  }));
  await resumableClaude(
    "snap",
    SNAP.path,
    snapJobs,
    (j) =>
      `${SNAP_PROMPT}\n\nSkill: ${j.name} (a prerequisite of ${
        byId.get(j.dep)!.title
      })\n\nCandidates:\n${
        j.cands.map((id, i) => {
          const c = byId.get(id)!;
          return `${i + 1}. ${c.title}${
            c.description ? ` — ${c.description.slice(0, 100)}` : ""
          }`;
        }).join("\n")
      }`,
    { numPredict: 20, schema: SNAP_SCHEMA, clean: snapClean },
  );
}

// ---------- stage postproc ----------

// REVIEW: A skill is a subject area when its id is the topic of 50 or more
// skills (problem-solving, geometry, mathematics); the cutoff is your decision
// of 10 Nov. An edge drops when its prereq is a subject area and its dependent
// carries that area as a topic: "mathematics → arithmetic" orders nothing.
// "linear-algebra → dimensionality-reduction" stays. Alternative: drop every
// edge of a subject area, the first plan. Then 59 of the 258 expert
// positives (linear-algebra → word-embedding, …) can never be recalled.
// Topics come from 3b_tagged_deduped.tsv: stage finalize adds LCSH ancestors
// after this stage, and the areas must not move under the filter.
export const SUBJECT_MIN = 50;

export function subjectAreaEdge(
  skills: { id: string; topics: string[] }[],
): (dep: string, pre: string) => boolean {
  const n = new Map<string, number>();
  const topicsOf = new Map<string, Set<string>>();
  for (const s of skills) {
    const ts = new Set(s.topics);
    topicsOf.set(s.id, ts);
    for (const t of ts) n.set(t, (n.get(t) ?? 0) + 1);
  }
  return (dep, pre) =>
    (n.get(pre) ?? 0) >= SUBJECT_MIN && (topicsOf.get(dep)?.has(pre) ?? false);
}

export function stagePostproc() {
  const skill = new Map(
    readTable(TAGGED_DEDUPED).map((s) => [s.id, {
      title: s.title,
      tags: s.tags,
      topics: new Set(s.topics.split(",").filter(Boolean)),
    }]),
  );
  const diffs = readDifficulty();
  for (const id of skill.keys()) {
    if (!diffs.has(id)) {
      throw new Error(
        `${BUILD}/4_difficulty.tsv: expected a row for "${id}", received none. ${
          rerun(`${BUILD}/4_difficulty.tsv`)
        }`,
      );
    }
  }
  const diffOf = (id: string) => {
    const d = diffs.get(id);
    if (!d) {
      throw new Error(
        `${BUILD}/4_difficulty.tsv: expected a difficulty row for "${id}", received none. ${
          rerun(`${BUILD}/4_difficulty.tsv`)
        }`,
      );
    }
    return d;
  };

  // Both tables name skills from before dedupe, so an alias maps them in.
  const alias = loadAliasesCollapsed();
  // Stage prereq resumes from its cache, so a rerun keeps a stale row.
  const fix = (path: string) =>
    path === PREREQS.path
      ? `${rerun(path)}. It drops the rows that name a gone id and asks again.`
      : rerun(path);
  const inSkills = (id: string, path: string, line: number) => {
    if (!skill.has(alias.get(id) ?? id)) {
      throw new Error(
        `${path}:${line}: expected a skill id from ${TAGGED_DEDUPED.path}, received "${id}". ${
          fix(path)
        }`,
      );
    }
  };
  let raw: [string, string][] = readTable(PREREQS).flatMap(
    ({ skill: s, picks }, i) =>
      picks.map((p): [string, string] => {
        inSkills(s, PREREQS.path, i + 1);
        inSkills(p, PREREQS.path, i + 1);
        return [alias.get(s) ?? s, alias.get(p) ?? p];
      }).filter(([a, b]) => a !== b),
  );
  readTable(SEEDS).forEach((r, i) => {
    inSkills(r.src_id, SEEDS.path, i + 2);
    inSkills(r.dst_id, SEEDS.path, i + 2);
  });
  // Named prereqs: stage prereq's expand names, snapped to skills.
  const snapOf = new Map<string, string>();
  readTable(SNAP).forEach(({ name, match }, i) => {
    if (match !== "none") inSkills(match, SNAP.path, i + 1);
    snapOf.set(name, match);
  });
  const named = new Set<string>();
  let names = 0, unsnapped = 0;
  const addNamed = (s: string, name: string) => {
    names++;
    const m = snapOf.get(slugify(name));
    if (m === undefined) unsnapped++;
    if (m === undefined || m === "none") return;
    const p = alias.get(m) ?? m;
    if (p !== s) named.add(`${s}\t${p}`);
  };
  readTable(EXPAND).forEach(({ skill: s0, names: ns }, i) => {
    if (ns === "none") return;
    inSkills(s0, EXPAND.path, i + 1);
    for (const name of ns.split("; ")) addNamed(alias.get(s0) ?? s0, name);
  });
  for (const { dep, name } of oakPriorNames(readTable(TAGGED_DEDUPED))) {
    addNamed(dep, name);
  }
  // A rejected snap reply stays unanswered, as a rejected prereq reply does.
  // More than that means stage prereq did not finish.
  if (unsnapped > names * 0.05) {
    throw new Error(
      `${SNAP.path}: expected an answer for at least 95% of the ${names} names in ${EXPAND.path}, received none for ${unsnapped}. ${
        rerun(SNAP.path)
      }`,
    );
  }
  const before = new Set(raw.map(([s, p]) => `${s}\t${p}`));
  for (const k of named) {
    if (!before.has(k)) raw.push(k.split("\t") as [string, string]);
  }
  console.log(
    `[postproc] raw edges: ${raw.length} (${named.size} named, ${unsnapped} of ${names} names unsnapped)`,
  );

  // Load seed edges for exemption
  const seeds = readSeeds();
  const seedEdgeKeys = new Set(seeds.map((e) => `${e.dep}\t${e.pre}`));
  const isSeed = (s: string, p: string): boolean =>
    seedEdgeKeys.has(`${s}\t${p}`);
  // REVIEW: A course-catalog seed whose prereq sits in a higher band than its
  // dependent drops; an expert seed stays. A catalog names a course
  // requirement ("calculus → probability"), and stage difficulty orders course
  // seeds last, so an inverted one contradicts the anchors and expert pairs.
  // Alternative: drop every course seed. Recall fell 54 → 31 at CSP scale.
  const expertKeys = new Set(
    seeds.filter((e) => e.source !== "courses").map((e) =>
      `${e.dep}\t${e.pre}`
    ),
  );
  console.log(`[postproc] seed keys: ${seeds.length}`);

  // K-3 ELA frameworks give holiday-retell leaves 1,800+ dependents, and the
  // hub caps miss them.
  const LEAF_PATTERN =
    /retell-stories-related-to-.*-day|customs-around-.*-day|-national-independence-day|classify-character-traits-and-their-influence|understand-object-naming-and-naming-conventions/;
  const beforeLeaf = raw.length;
  let leafExempt = 0;
  raw = raw.filter(([s, p]) => {
    if (!LEAF_PATTERN.test(p)) return true;
    if (isSeed(s, p)) {
      leafExempt++;
      return true;
    }
    return false;
  });
  console.log(
    `[postproc] dropped ${
      beforeLeaf - raw.length
    } leaf-pattern edges (${leafExempt} seed exempt)`,
  );

  // Candidate generation drops a cross-language pair; a named prereq skips it.
  const beforeLang = raw.length;
  raw = raw.filter(([s, p]) => {
    const ls = langTokenOf(s), lp = langTokenOf(p);
    return !ls || !lp || ls === lp || isSeed(s, p);
  });
  console.log(
    `[postproc] dropped ${beforeLang - raw.length} cross-language edges`,
  );
  const beforeSe = raw.length;
  raw = raw.filter(([s, p]) =>
    isSeed(s, p) || !seInverted(skill.get(s)!.tags, skill.get(p)!.tags)
  );
  console.log(
    `[postproc] dropped ${
      beforeSe - raw.length
    } edges whose prereq has a higher Skills England level`,
  );

  // Filter 0: band-inverted
  let bandExempt = 0;
  const beforeBand = raw.length;
  // REVIEW: A named prereq of an unanchored skill skips filters 0 and 0a.
  // The dependent sits in the band-11 pile, so a true prereq (linear-algebra
  // for computer-vision) is rarely easier; the chain lift in stage finalize
  // then orders the bands. In the trial the guard blocked half the named
  // prereqs, 90% with an unanchored dependent, and all 14 lost expert pairs.
  // Alternative: the guard for every edge; recall stays under the floor.
  // You approved this on 11 Nov.
  const liftable = (s: string, p: string) =>
    named.has(`${s}\t${p}`) && !diffOf(s).anchored;
  let namedExempt = 0;
  raw = raw.filter(([s, p]) => {
    if (diffOf(p).band <= diffOf(s).band) return true;
    if (isSeed(s, p)) {
      bandExempt++;
      return true;
    }
    if (liftable(s, p)) {
      namedExempt++;
      return true;
    }
    return false;
  });
  console.log(
    `[postproc] dropped ${
      beforeBand - raw.length
    } band-inverted (${bandExempt} seed exempt)`,
  );

  // Filter 0a: raw-difficulty monotonicity (catches same-band reversals)
  const RAW_EPS = 0.05;
  let rawExempt = 0;
  const beforeRaw = raw.length;
  raw = raw.filter(([s, p]) => {
    const sR = diffOf(s).raw;
    const pR = diffOf(p).raw;
    if (pR <= sR - RAW_EPS || diffOf(p).band < diffOf(s).band) return true;
    if (isSeed(s, p)) {
      rawExempt++;
      return true;
    }
    if (liftable(s, p)) {
      namedExempt++;
      return true;
    }
    return false;
  });
  console.log(
    `[postproc] dropped ${
      beforeRaw - raw.length
    } raw-inverted (${rawExempt} seed exempt)`,
  );
  console.log(
    `[postproc] filters 0 and 0a kept ${namedExempt} named prereqs of unanchored skills`,
  );

  // Filter 0b: domain-skill specificity guard.
  // A broad domain skill (≤2 tokens in its slug, e.g. "arithmetic", "algebra", "geometry")
  // should not have highly-specific prereqs (e.g. "partial-fraction-decomposition") chosen
  // by the LLM. Those are usually sub-concepts mis-picked as prereqs. Only allow seed edges
  // or prereqs that are themselves broad (≤ skill.tokens + 1).
  const tokenCount = (id: string): number => {
    let n = 0;
    for (const w of id.split("-")) if (w.length >= 2) n++;
    return n;
  };
  const beforeDomain = raw.length;
  let domainExempt = 0;
  raw = raw.filter(([s, p]) => {
    const sTok = tokenCount(s);
    if (sTok > 2) return true;
    const pTok = tokenCount(p);
    if (pTok <= sTok + 1) return true;
    if (isSeed(s, p)) {
      domainExempt++;
      return true;
    }
    return false;
  });
  console.log(
    `[postproc] dropped ${
      beforeDomain - raw.length
    } domain-specificity (${domainExempt} seed exempt)`,
  );

  // Filter 0b: hypernym
  const sigSlugToks = (id: string): Set<string> => {
    const out = new Set<string>();
    for (const w of id.split("-")) {
      if (w.length >= 3 && !SIG_STOP.has(w)) out.add(w);
    }
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
  for (const [s, p] of raw) {
    const arr = bySkill.get(s) ?? [];
    arr.push(p);
    bySkill.set(s, arr);
  }
  let droppedTech = 0;
  const techFiltered: [string, string][] = [];
  for (const [s, prereqs] of bySkill) {
    const ssk = skill.get(s);
    const sIsTech = ssk?.tags.includes("onet:tech") ?? false;
    const sRaw = diffOf(s).raw;
    const kept = prereqs.filter((p) => {
      if (isSeed(s, p)) return true;
      const psk = skill.get(p);
      if (!psk) return true;
      const pIsTech = psk.tags.includes("onet:tech");
      if (!pIsTech) return true;
      if (sIsTech) return sRaw - diffOf(p).raw >= 2.0;
      if (ssk?.topics.has(p)) return true;
      return false;
    });
    let final = kept;
    if (final.length === 0 && !sIsTech && prereqs.length > 0) {
      const firstNonTech = prereqs.find((p) =>
        !(skill.get(p)?.tags.includes("onet:tech") ?? false)
      );
      if (firstNonTech) final = [firstNonTech];
    }
    droppedTech += prereqs.length - final.length;
    for (const p of final) techFiltered.push([s, p]);
  }
  raw = techFiltered;
  console.log(`[postproc] dropped ${droppedTech} onet:tech edges`);

  // Filter 2: per-topic + global hub cap
  const PER_TOPIC_CAP = 30;
  const GLOBAL_CAP = 150;
  const TECH_HUB_CAP = 15;
  const downstream = new Map<string, [string, string][]>();
  for (const e of raw) {
    const arr = downstream.get(e[1]) ?? [];
    arr.push(e);
    downstream.set(e[1], arr);
  }
  let droppedHub = 0, droppedPerTopic = 0;
  const keep = new Set<string>();
  for (const [prereqId, edges] of downstream) {
    const pIsTech = skill.get(prereqId)?.tags.includes("onet:tech") ?? false;
    const pRaw = diffOf(prereqId).raw;
    edges.sort((a, b) =>
      Math.abs(diffOf(a[0]).raw - pRaw) -
      Math.abs(diffOf(b[0]).raw - pRaw)
    );
    if (pIsTech) {
      for (let i = 0; i < edges.length; i++) {
        const [s, p] = edges[i];
        if (isSeed(s, p)) {
          keep.add(`${s}\t${p}`);
          continue;
        }
        if (i < TECH_HUB_CAP) keep.add(`${s}\t${p}`);
        else droppedHub++;
      }
      continue;
    }
    const perTopic = new Map<string, number>();
    let kept = 0;
    for (const [s, p] of edges) {
      if (isSeed(s, p)) {
        keep.add(`${s}\t${p}`);
        kept++;
        continue;
      }
      const ct = skill.get(s)?.topics;
      const topics = ct && ct.size ? [...ct] : ["_notopic"];
      const allowed = topics.filter((t) =>
        (perTopic.get(t) ?? 0) < PER_TOPIC_CAP
      );
      if (allowed.length === 0) {
        droppedPerTopic++;
        continue;
      }
      if (kept >= GLOBAL_CAP) {
        droppedHub++;
        continue;
      }
      keep.add(`${s}\t${p}`);
      for (const t of allowed) perTopic.set(t, (perTopic.get(t) ?? 0) + 1);
      kept++;
    }
  }
  let final: [string, string][] = raw.filter((e) =>
    keep.has(`${e[0]}\t${e[1]}`)
  );
  console.log(
    `[postproc] hub caps: dropped ${droppedPerTopic} per-topic, ${droppedHub} global/tech`,
  );

  // Heuristic orphan fix
  const orphanSkills = new Set<string>();
  const hasEdge = new Set(final.map(([s]) => s));
  for (const id of skill.keys()) if (!hasEdge.has(id)) orphanSkills.add(id);
  const wordCount = new Map<string, number>();
  for (const [id] of skill) {
    for (const w of id.split("-")) {
      if (w.length >= 5) wordCount.set(w, (wordCount.get(w) ?? 0) + 1);
    }
  }
  const stopWords = new Set<string>();
  for (const [w, n] of wordCount) if (n > 300) stopWords.add(w);
  const heurUseCount = new Map<string, number>();
  const HEUR_CAP = 15;
  const HEUR_MIN_GAP = 4;
  let orphanFixed = 0;
  const orphanTitleTok = (id: string): Set<string> => {
    const out = new Set<string>();
    for (const w of id.split("-")) {
      if (w.length >= 4 && !stopWords.has(w)) out.add(w);
    }
    return out;
  };
  for (const orphanId of orphanSkills) {
    const sRaw = diffOf(orphanId).raw;
    // A candidate is a skill whose whole id is one word of the orphan's title.
    const ranked: string[] = [];
    for (const w of orphanTitleTok(orphanId)) {
      const c = skill.get(w);
      if (w.length < 5 || w === orphanId || !c) continue;
      if (c.tags.includes("onet:tech")) continue;
      if (sRaw - diffOf(w).raw < HEUR_MIN_GAP) continue;
      ranked.push(w);
    }
    ranked.sort((a, b) =>
      (heurUseCount.get(a) ?? 0) - (heurUseCount.get(b) ?? 0) ||
      diffOf(a).raw - diffOf(b).raw
    );
    for (const candId of ranked) {
      const n = heurUseCount.get(candId) ?? 0;
      if (n >= HEUR_CAP) continue;
      final.push([orphanId, candId]);
      heurUseCount.set(candId, n + 1);
      orphanFixed++;
      break;
    }
  }
  console.log(
    `[postproc] orphan fix: added ${orphanFixed}/${orphanSkills.size}`,
  );

  // Cross-domain filter
  const FOUNDATION = new Set([
    "mathematics",
    "math",
    "arithmetic",
    "reading",
    "writing",
    "reading-comprehension",
    "written-expression",
    "active-listening",
    "speaking",
    "problem-solving",
    "critical-thinking",
    "complex-problem-solving",
    "deductive-reasoning",
    "inductive-reasoning",
    "active-learning",
    "learning-strategies",
  ]);
  const MIN_OVERLAP = 0.0001;
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
    const st = orphanTitleTok(p), dt = orphanTitleTok(s);
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
  let seedAdded = 0, seedDup = 0, seedMissing = 0, courseInverted = 0;
  {
    const existing = new Set(final.map(([s, p]) => `${s}\t${p}`));
    for (const { pre: src, dep: dst } of seeds) {
      if (!skill.has(src) || !skill.has(dst) || src === dst) {
        seedMissing++;
        continue;
      }
      const key = `${dst}\t${src}`;
      if (!expertKeys.has(key) && diffOf(src).band > diffOf(dst).band) {
        courseInverted++;
        continue;
      }
      if (existing.has(key)) {
        seedDup++;
        continue;
      }
      final.push([dst, src]);
      existing.add(key);
      seedAdded++;
    }
  }
  console.log(
    `[postproc] seeds: added=${seedAdded}, dup=${seedDup}, missing=${seedMissing}, inverted course seeds dropped=${courseInverted}`,
  );

  // A subject area is no prereq of a skill inside it (SUBJECT_MIN), seed
  // edges included.
  {
    const areaEdge = subjectAreaEdge(
      [...skill].map(([id, s]) => ({ id, topics: [...s.topics] })),
    );
    const gone = final.filter(([s, p]) => areaEdge(s, p));
    final = final.filter(([s, p]) => !areaEdge(s, p));
    console.log(
      `[postproc] subject areas: dropped ${gone.length} edges (${
        gone.filter(([s, p]) => isSeed(s, p)).length
      } seed)`,
    );
  }

  // Cycle breaker (Tarjan + rank-based back-edge drop)
  let cyclesBroken = 0, cyclesSeedDropped = 0;
  for (let round = 0;; round++) {
    const adj = new Map<string, string[]>();
    for (const [s, p] of final) {
      const arr = adj.get(p) ?? [];
      arr.push(s);
      adj.set(p, arr);
    }
    const sccs = stronglyConnected(adj);
    if (sccs.length === 0) break;
    if (round === 100) {
      throw new Error(
        `postproc: expected a DAG within 100 cycle-breaker rounds, received ${sccs.length} cycles still left. Check the rank rule in the cycle breaker.`,
      );
    }
    const toDrop = new Set<string>();
    for (const scc of sccs) {
      const sccSet = new Set(scc);
      const internal: { s: string; p: string; gap: number; seed: boolean }[] =
        [];
      for (const [s, p] of final) {
        if (!sccSet.has(s) || !sccSet.has(p)) continue;
        internal.push({
          s,
          p,
          gap: diffOf(s).raw - diffOf(p).raw,
          seed: isSeed(s, p),
        });
      }
      const seedInDeg = new Map<string, number>(),
        seedAdj = new Map<string, string[]>();
      for (const n of scc) seedInDeg.set(n, 0);
      for (const e of internal) {
        if (e.seed) {
          const arr = seedAdj.get(e.p) ?? [];
          arr.push(e.s);
          seedAdj.set(e.p, arr);
          seedInDeg.set(e.s, (seedInDeg.get(e.s) ?? 0) + 1);
        }
      }
      const rankFor = new Map<string, number>();
      const ready: string[] = [...scc].filter((n) =>
        (seedInDeg.get(n) ?? 0) === 0
      );
      ready.sort((a, b) => diffOf(a).raw - diffOf(b).raw);
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
            while (
              ins < ready.length &&
              diffOf(ready[ins]).raw <= diffOf(v).raw
            ) ins++;
            ready.splice(ins, 0, v);
          }
        }
      }
      const leftover = [...seedCycleNodes].sort((a, b) =>
        diffOf(a).raw - diffOf(b).raw
      );
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
        internal.sort((
          a,
          b,
        ) => (a.seed === b.seed ? a.gap - b.gap : a.seed ? 1 : -1));
        const e = internal[0];
        toDrop.add(`${e.s}\t${e.p}`);
        if (e.seed) cyclesSeedDropped++;
      }
    }
    const before = final.length;
    for (let i = final.length - 1; i >= 0; i--) {
      if (toDrop.has(`${final[i][0]}\t${final[i][1]}`)) final.splice(i, 1);
    }
    if (before === final.length) {
      throw new Error(
        `postproc: expected round ${round} of the cycle breaker to drop an edge from ${sccs.length} cycles, received none. Check the rank rule in the cycle breaker.`,
      );
    }
    cyclesBroken += before - final.length;
  }
  console.log(
    `[postproc] cycle-breaker: ${cyclesBroken} edges (${cyclesSeedDropped} seed)`,
  );

  // Transitive reduction: drop s -> p when another prereq of s reaches p.
  // REVIEW: Per node, walk the prereqs nearest first and mark what each walk
  // reaches. Memory is O(nodes + edges). Alternative: one reachability bitset
  // per node. It is faster, but it costs nodes^2 / 8 bytes, 1.25 GB at 10^5.
  {
    // An alias can fold two picks into one edge. A repeat would mark itself redundant.
    final = [...new Map(final.map((e) => [`${e[0]}\t${e[1]}`, e])).values()];
    const ids = [...new Set(final.flat())];
    const idx = new Map(ids.map((id, i) => [id, i]));
    const pres: number[][] = ids.map(() => []);
    const deps: number[][] = ids.map(() => []);
    for (const [s, p] of final) {
      pres[idx.get(s)!].push(idx.get(p)!);
      deps[idx.get(p)!].push(idx.get(s)!);
    }
    // Kahn order: every prereq comes before its dependents.
    const left = pres.map((a) => a.length);
    const pos = new Int32Array(ids.length).fill(-1);
    const queue = left.flatMap((n, i) => n === 0 ? [i] : []);
    for (let head = 0; head < queue.length; head++) {
      pos[queue[head]] = head;
      for (const d of deps[queue[head]]) if (--left[d] === 0) queue.push(d);
    }
    if (queue.length !== ids.length) {
      throw new Error(
        `postproc: expected a DAG before the transitive reduction, received ${
          ids.length - queue.length
        } of ${ids.length} nodes on or below a cycle. Check the cycle breaker.`,
      );
    }
    const MAX_STEPS = 2_000_000_000;
    let steps = 0;
    const mark = new Int32Array(ids.length).fill(-1);
    const redundant = new Set<string>();
    for (let s = 0; s < ids.length; s++) {
      for (const p of pres[s].toSorted((a, b) => pos[b] - pos[a])) {
        if (mark[p] === s) {
          redundant.add(`${ids[s]}\t${ids[p]}`);
          continue;
        }
        mark[p] = s;
        const stack = [p];
        while (stack.length) {
          for (const q of pres[stack.pop()!]) {
            if (++steps > MAX_STEPS) {
              throw new Error(
                `postproc: expected the transitive reduction within ${MAX_STEPS} edge visits, received ${steps} at node ${s} of ${ids.length} (${
                  ids[s]
                }). Cap the edges per skill in the hub caps, or switch to bitsets.`,
              );
            }
            if (mark[q] !== s) {
              mark[q] = s;
              stack.push(q);
            }
          }
        }
      }
    }
    final = final.filter(([s, p]) => !redundant.has(`${s}\t${p}`));
    const seedsImplied = [...redundant].filter((k) => seedEdgeKeys.has(k));
    console.log(
      `[postproc] transitive reduction: dropped ${redundant.size} edges (${seedsImplied.length} seed, each implied by a path) in ${steps} visits`,
    );
  }

  // Write (sorted for deterministic output across runs)
  final.sort((a, b) =>
    a[0] === b[0]
      ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
      : (a[0] < b[0] ? -1 : 1)
  );
  writeTable(EDGES, final);
}

// ---------- stage finalize ----------

// The chain lift moves an unanchored skill at most 4 bands (decision, 12 Nov).
// At 93k skills, cap 4 recovers 37 expert pairs and cap 3 recovers 36;
// precision is 7/26 and 7/24.
const LIFT_CAP = 4;

export function stageFinalize() {
  const skills = readTable(TAGGED_DEDUPED);
  const dm = readDifficulty();
  const skillIdSet = new Set<string>(skills.map((s) => s.id));
  [...dm.keys()].forEach((id, i) => {
    if (!skillIdSet.has(id)) {
      throw new Error(
        `${DIFFICULTY.path}:${i + 2}: expected a skill id, received "${id}". ${
          rerun(DIFFICULTY.path)
        }`,
      );
    }
  });

  const alias = loadAliasesCollapsed();
  const remap = (id: string) => alias.get(id) ?? id;

  const prereqs = new Map<string, string[]>();
  const edgesPath = EDGES.path;
  readTable(EDGES).forEach(({ skill_id: s0, prereq_id: p0 }, i) => {
    const s = remap(s0), p = remap(p0);
    // postproc wrote these edges from the same skills and aliases.
    for (const id of [s, p]) {
      if (!skillIdSet.has(id)) {
        throw new Error(
          `${edgesPath}:${i + 2}: expected a skill id, received "${id}". ${
            rerun(edgesPath)
          }`,
        );
      }
    }
    if (s === p) {
      throw new Error(
        `${edgesPath}:${
          i + 2
        }: expected two skills, received "${s0}" → "${p0}", which aliases to one. ${
          rerun(edgesPath)
        }`,
      );
    }
    const arr = prereqs.get(s) ?? [];
    if (!arr.includes(p)) arr.push(p);
    prereqs.set(s, arr);
  });

  // REVIEW: Chain lift. In prereq order, an unanchored skill sits at least one
  // band above each prereq, and below each anchored skill that depends on it
  // through a chain. A long chain then carries a skill past grade 12 with no
  // anchor there: algebra (8) → linear algebra → regression → neural networks
  // (12+). Alternative: college-level anchors (you, 11 Nov: no). Risk: one
  // wrong edge lifts each skill above it, so status bounds the lifts. A tight
  // ceiling can leave a prereq in its dependent's band: an anchor outranks the
  // lift, and status allows equal bands.
  const order = topoOrder(
    skills.map((s) => ({ id: s.id, prereqs: prereqs.get(s.id) ?? [] })),
  );
  if (order.length !== skills.length) {
    throw new Error(
      `${edgesPath}: expected a DAG over ${skills.length} skills, received a cycle through ${
        skills.length - order.length
      } of them. ${rerun(edgesPath)}`,
    );
  }
  const bandOf = (id: string) => {
    const d = dm.get(id);
    if (d === undefined) {
      throw new Error(
        `${DIFFICULTY.path}: expected a row for skill "${id}", received none. ${
          rerun(DIFFICULTY.path)
        }`,
      );
    }
    return d;
  };
  const dependents = new Map<string, string[]>();
  for (const [s, ps] of prereqs) {
    for (const p of ps) dependents.set(p, [...dependents.get(p) ?? [], s]);
  }
  // The highest band each skill may take: one below its lowest anchored
  // dependent through any chain, and never below its own band.
  const ceiling = new Map<string, number>();
  for (const id of order.toReversed()) {
    const d = bandOf(id);
    let c = d.anchored ? d.band : 20;
    if (!d.anchored) {
      for (const x of dependents.get(id) ?? []) {
        c = Math.min(c, ceiling.get(x)! - 1);
      }
    }
    ceiling.set(id, Math.max(c, d.band));
  }
  // REVIEW: An edge the lift cannot order drops: its prereq ends above the
  // dependent's ceiling or cap. Seeds stay. Each drop counts in status. The
  // transitive reduction ran before this step, so a dropped edge also loses
  // each edge its path implied. Alternative: keep the edge inverted; one
  // inverted edge puts every skill above it below a transitive prereq.
  const seedKeys = new Set(readSeeds().map((e) => `${e.dep}\t${e.pre}`));
  const diff = new Map<string, number>();
  let unfit = 0;
  for (const id of order) {
    const d = bandOf(id);
    const top = d.anchored
      ? d.band
      : Math.min(ceiling.get(id)!, d.band + LIFT_CAP);
    const kept: string[] = [];
    for (const p of prereqs.get(id) ?? []) {
      if (diff.get(p)! <= top || seedKeys.has(`${id}\t${p}`)) kept.push(p);
      else unfit++;
    }
    if (kept.length) prereqs.set(id, kept);
    else prereqs.delete(id);
    let b = d.band;
    for (const p of kept) b = Math.max(b, diff.get(p)! + 1);
    diff.set(id, Math.min(b, top));
  }
  console.log(`[finalize] chain lift dropped ${unfit} edges it cannot order`);

  // Framework/wiki-category filters (module-scope FRAMEWORK_RE, WIKI_CAT_RE, YEAR_RE)
  const STOP = new Set([...STOPWORDS, "these", "those"]);
  const sigTokens = (id: string) =>
    new Set(id.split("-").filter((t) => t.length >= 4 && !STOP.has(t)));

  // Cruft drop
  const aliasCanonicals = new Set(
    readTable(ALIASES).map((r) => r.canonical_id),
  );
  const childCount = new Map<string, number>();
  for (const [, p] of prereqs) {
    for (const pid of p) childCount.set(pid, (childCount.get(pid) ?? 0) + 1);
  }
  const isOrphanLeaf = (id: string) =>
    (prereqs.get(id) || []).length === 0 && (childCount.get(id) ?? 0) === 0;
  const isCruft = (
    s: { id: string; title: string; description: string; topics: string },
  ) => {
    if (aliasCanonicals.has(s.id)) return false;
    const desc = (s.description || "").trim();
    const topics = (s.topics || "").split(",").filter(Boolean);
    if (!desc && !topics.length) return true;
    // Empty description AND only 1 topic: not enough signal for a skill node.
    if (!desc && topics.length < 2) return true;
    if (s.id.split("-").length >= 5 && desc.length < 60) return true;
    if (/^review-records|^prepare-inserts|^seal-containers/.test(s.id)) {
      return true;
    }
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
    const lastDot = Math.max(
      head.lastIndexOf(". "),
      head.lastIndexOf("? "),
      head.lastIndexOf("! "),
    );
    if (lastDot > 30) return head.slice(0, lastDot + 1).trim();
    const trim = title.slice(0, 79);
    const lastSpace = trim.lastIndexOf(" ");
    return (lastSpace > 30 ? trim.slice(0, lastSpace) : trim).trim() + "…";
  };

  // Load LCSH + DBpedia ancestor chains
  const lcshTree = readTree(`${BUILD}/1j_lcsh_tree.tsv`);
  for (const [slug, anc] of readTree(`${BUILD}/1k_dbpedia_tree.tsv`)) {
    const existing = lcshTree.get(slug);
    lcshTree.set(slug, existing ? [...new Set([...existing, ...anc])] : anc);
  }
  console.log(
    `[finalize] loaded ${lcshTree.size} LCSH/DBpedia ancestor chains`,
  );

  type Row = {
    id: string;
    title: string;
    display: string;
    desc: string;
    d: number;
    ps: string;
    occ: string;
    topics: string[];
    gStart: string;
    gEnd: string;
  };
  const pending: Row[] = [];
  const TOPIC_CAP = 5;
  for (const s of skills) {
    if (isOrphanLeaf(s.id) && isCruft(s)) continue;
    const d = diff.get(s.id)!;
    const ps = (prereqs.get(s.id) ?? []).join(",");
    const existing = s.topics.split(",").filter(Boolean);
    const skillTokens = sigTokens(s.id);
    for (const tok of sigTokens(s.title.toLowerCase().replace(/\s+/g, "-"))) {
      skillTokens.add(tok);
    }
    for (
      const tok of sigTokens(
        (s.description || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ")
          .replace(/\s+/g, "-"),
      )
    ) skillTokens.add(tok);
    for (const t of s.occupations.split(",").filter(Boolean)) {
      for (const tok of sigTokens(t)) {
        skillTokens.add(tok);
      }
    }
    const filtered = existing.filter((t) =>
      !FRAMEWORK_RE.test(t) && !WIKI_CAT_RE.test(t) && !YEAR_RE.test(t) &&
      sigTokens(t).size > 0
    );
    // LCSH/DBpedia ancestor enrichment
    const lcshTopics: string[] = [];
    for (const cand of [s.id, slugify(s.title), ...filtered]) {
      const anc = lcshTree.get(cand);
      if (!anc) continue;
      for (const a of anc) {
        if (
          lcshTopics.includes(a) || YEAR_RE.test(a) || WIKI_CAT_RE.test(a) ||
          FRAMEWORK_RE.test(a)
        ) continue;
        if (sigTokens(a).size === 0) continue;
        const aToks = sigTokens(a);
        let ovl = 0;
        for (const tok of aToks) {
          if (skillTokens.has(tok)) {
            ovl++;
            break;
          }
        }
        if (!ovl) continue;
        lcshTopics.push(a);
        if (lcshTopics.length >= 3) break;
      }
      if (lcshTopics.length >= 3) break;
    }
    const topics = [...new Set([...filtered, ...lcshTopics])].slice(
      0,
      TOPIC_CAP,
    );
    const gradeMap: Record<string, number> = { "PK": -1, "K": 0 };
    const grades: number[] = [];
    for (const tag of s.tags.split(",")) {
      if (!tag.startsWith("grade:")) continue;
      const v = tag.slice(6).toUpperCase();
      const n = gradeMap[v] ?? (/^\d+$/.test(v) ? Number(v) : NaN);
      if (!Number.isNaN(n)) grades.push(n);
    }
    pending.push({
      id: s.id,
      title: s.title,
      display: deriveDisplay(s.title, s.tags),
      desc: s.description,
      d,
      ps,
      occ: s.occupations,
      topics,
      gStart: grades.length ? Math.min(...grades).toString() : "",
      gEnd: grades.length ? Math.max(...grades).toString() : "",
    });
  }

  // Topic frequency cap
  const topicFreq = new Map<string, number>();
  for (const r of pending) {
    for (const t of r.topics) topicFreq.set(t, (topicFreq.get(t) ?? 0) + 1);
  }
  const MAX_FREQ = Math.max(1200, Math.floor(pending.length * 0.013));
  const whitelist = new Set([
    "mathematics",
    "science",
    "biology",
    "chemistry",
    "physics",
    "engineering",
    "technology",
    "economics",
    "history",
    "literature",
    "philosophy",
    "medicine",
    "law",
    "education",
    "problem-solving",
    "critical-thinking",
    "communication",
    "management",
    "leadership",
    "computer-science",
    "software-engineering",
    "data-analysis",
    "statistics",
    "research",
    "information-skills",
    "management-skills",
    "nondestructive-testing",
    "mathematical-optimization",
    "handling-and-moving",
    "personnel-management",
    "working-with-machinery-and-specialised-equipment",
  ]);
  const blocklist = new Set([
    "photomechanical-processes",
    "flying-machines",
    "rome-officials-and-employees",
    "traffic-regulations",
    "units-of-measurement",
    "professional-employees",
    "employees",
    "persons",
    "specialists",
    "scientists",
    "workers",
    "people",
    "occupations",
    "officials",
    "personnel",
    "staff",
    "professionals",
    "practitioners",
    "technicians",
    "operators",
    "judaism-customs-and-practices",
    "descriptive-cataloging",
    "ibm-computers",
    "wikiproject-countries-projects",
    "wikiproject-africa-projects",
    "computer-input-output-equipment",
    "history-of-technology",
    "personality-tests",
    "diagnostic-equipment-industry",
    "industrial-equipment-industry",
    "portable-computers",
    "telecommunication-equipment-industry",
    "law-interpretation-and-construction",
  ]);
  // A topic with 2-3 members forms no useful cluster.
  const TOPIC_MIN_FREQ = 4;
  for (const r of pending) {
    r.topics = r.topics.filter((t) => {
      const f = topicFreq.get(t) ?? 0;
      if (f < TOPIC_MIN_FREQ) return false;
      if (blocklist.has(t)) return false;
      if (f > MAX_FREQ && !whitelist.has(t)) return false;
      return true;
    });
  }

  const rows: string[][] = [];
  for (const r of pending) {
    rows.push([
      r.id,
      r.title,
      r.display,
      r.desc,
      r.d.toString(),
      r.ps,
      r.occ,
      r.topics.join(","),
      r.gStart,
      r.gEnd,
    ]);
  }
  if (!pending.length) {
    throw new Error(
      `finalize: expected at least one skill, received none after the cruft drop. skills.tsv is unchanged. Check isCruft against ${TAGGED_DEDUPED.path}.`,
    );
  }

  writeTable(SKILLS_OUT, rows);
  const gz = new Deno.Command("gzip", { args: ["-kf", "skills.tsv"] })
    .outputSync();
  if (!gz.success) {
    throw new Error(
      `gzip -kf skills.tsv: expected exit 0, received ${gz.code}: ${
        new TextDecoder().decode(gz.stderr)
      }`,
    );
  }
  console.log(
    `[finalize] emitted ${rows.length} skills, ${
      [...prereqs.values()].reduce((s, a) => s + a.length, 0)
    } edges`,
  );
}

// ---------- expand and snap prompts ----------

const SNAP_K = 10;

const EXPAND_PROMPT =
  `You list the prerequisites of a skill, course, or occupation. Return the skills a learner MUST understand before learning it. Be strict — only genuinely foundational dependencies, not merely related or adjacent topics, and not its own subtopics. At most ${PREREQ_PICK_CAP}. Name each in 1-6 words, as a skill a curriculum teaches. Return an empty list when it is a primitive that needs no prior skill (e.g. counting, adding small numbers).`;

const EXPAND_SCHEMA = {
  type: "object",
  properties: { prereqs: { type: "array", items: { type: "string" } } },
  required: ["prereqs"],
  additionalProperties: false,
};

const SNAP_PROMPT =
  `You match a skill name to a list of skills. Answer the number of the candidate that names the same skill: the same concept at the same scope. A broader, narrower, or merely related skill is not a match. Answer "none" when no candidate matches.`;

const SNAP_SCHEMA = {
  type: "object",
  properties: {
    match: {
      type: "string",
      enum: ["none", ...Array.from({ length: SNAP_K }, (_, i) => `${i + 1}`)],
    },
  },
  required: ["match"],
  additionalProperties: false,
};

// A snap reply's skill id, "none", or "" (rejected) for any other reply.
function snapClean(raw: string, j: { cands: string[] }): string {
  let match: unknown;
  try {
    match = (JSON.parse(raw) as { match?: unknown })?.match;
  } catch {
    return "";
  }
  if (match === "none") return "none";
  return typeof match === "string" && /^[1-9]\d?$/.test(match)
    ? j.cands[Number(match) - 1] ?? ""
    : "";
}

// The names of an expand reply, or null when a name is a sentence (over 8
// words) or has no slug. The schema fixes the shape.
// The cache joins names with "; " and reads "none" as no prereqs, so a ";"
// splits a name, and a name "none" is no name.
function parseExpand(raw: string): string[] | null {
  let reply: unknown;
  try {
    reply = JSON.parse(raw);
  } catch {
    return null;
  }
  const prereqs = (reply as { prereqs?: unknown })?.prereqs;
  if (!Array.isArray(prereqs) || prereqs.some((n) => typeof n !== "string")) {
    return null;
  }
  const names = [
    ...new Set(
      (prereqs as string[]).flatMap((n) => n.split(/[;\t\r\n]/))
        .map((n) => n.trim()).filter((n) => n && !/^none$/i.test(n)),
    ),
  ];
  if (names.some((n) => n.split(/\s+/).length > 8 || !slugify(n))) {
    return null;
  }
  return names.slice(0, PREREQ_PICK_CAP);
}
