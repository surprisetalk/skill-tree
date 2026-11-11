import {
  ALIASES,
  ancestorsOf,
  BUILD,
  claudeNow,
  col,
  DIFFICULTY,
  easier,
  EDGES,
  EMBED_DIM,
  embedBatch,
  embeddingFallback,
  expertScores,
  FRAMEWORK_RE,
  gradeToDifficulty,
  loadAliasesCollapsed,
  loadTsvCache,
  normalize,
  normalizedEmbeddingsForSkills,
  PATHOLOGICAL,
  PREREQ_CACHE,
  PREREQS,
  readDifficulty,
  readLectureBank,
  readSeeds,
  readTable,
  readTree,
  readTsv,
  rerun,
  resolveConcept,
  resumableClaude,
  SEEDS,
  SIG_STOP,
  skillIndex,
  SKILLS_OUT,
  slugify,
  STOPWORDS,
  stronglyConnected,
  TAGGED,
  TAGGED_DEDUPED,
  topoOrder,
  WIKI_CAT_RE,
  writeStats,
  writeTable,
  YEAR_RE,
} from "./lib.ts";

// ---------- stage prereq ----------

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
    let gs = Infinity, ge = -Infinity;
    for (const m of s.tags.matchAll(/grade:([A-Za-z0-9-]+)/g)) {
      const d = gradeToDifficulty(m[1]);
      if (d !== null) {
        gs = Math.min(gs, d);
        ge = Math.max(ge, d);
      }
    }
    return {
      ...s,
      gradeStart: Number.isFinite(gs) ? gs : -2,
      gradeEnd: Number.isFinite(ge) ? ge : -2,
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

function computePrereqCandidates(): Map<string, number[]> {
  const { skills, diff, raw } = parseSkillsWithDifficulty();
  const vecs = normalizedEmbeddingsForSkills(skills.map((s) => s.id));
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
  const K = 15;
  const ANCESTOR_K = 5;
  const GLOBAL_K = 5;
  // A foundation skill names the topic of FOUNDATION_MIN skills
  // (linear-algebra, probability). Each skill gets FOUNDATION_K slots for the
  // nearest foundations, whatever its topics: 233 of 248 missed expert
  // positives shared no topic with their prereq.
  const FOUNDATION_K = 2;
  const FOUNDATION_MIN = 20;
  const foundations = skills.flatMap((s, j) =>
    (topicIdx.get(s.id)?.length ?? 0) >= FOUNDATION_MIN ? [j] : []
  );
  // Shorter tokens ("prepar") link prepare-medication to prepare-pasta.
  const TOK_MIN = 7;
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
    if (isSced[j]) return false; // R1
    if (isStudyMeta[j] && !isStudyMeta[i]) return false; // R4
    const lj = slugLangs[j];
    if (lj && slugLangs[i] && lj !== slugLangs[i]) return false; // R6
    if (gradeGapReject(i, j)) return false; // R2
    // REVIEW: A candidate only needs a lower raw than its target. Expert seed
    // pairs sit close in difficulty: a 1.5 gap admitted 22% of them, fewer than
    // the 38% of random pairs it admitted, and a 0 gap admits 60%. Alternative:
    // read the seed-ordered band (51%), or restore the old seed raw, which set
    // a prereq 1.0 below its dependent and so still failed the 1.5 gap.
    return raw[j] < raw[i] || diff[j] < diff[i]; // DR1 hard guard, as `easier`
  };

  const out = new Map<string, number[]>();
  const t0 = performance.now();
  // Seconds per part, summed over skills: the CSP scale needs the slow one.
  const secs: Record<string, number> = {};
  let tl = performance.now(), fullScans = 0;
  const lap = (part: string) => {
    const now = performance.now();
    secs[part] = (secs[part] ?? 0) + (now - tl) / 1000;
    tl = now;
  };
  for (let i = 0; i < skills.length; i++) {
    lap("other");
    const topics = skills[i].topics.split(",").filter(Boolean);
    const occsI = skills[i].occupations.split(",").filter(Boolean);
    const myOccs = new Set<string>(occsI);
    const myToks = new Set<string>();
    for (const t of topics) {
      for (const tok of t.split("-")) {
        if (tok.length >= TOK_MIN) myToks.add(tok);
      }
    }

    // R3 within-topic shared-token guard: candidate must share ≥1 topic token,
    // OR share an occupation, OR be in FOUNDATION_IDS.
    const withinTopicOk = (j: number): boolean => {
      if (FOUNDATION_IDS.has(skills[j].id)) return true;
      for (const oc of skills[j].occupations.split(",")) {
        if (oc && myOccs.has(oc)) return true;
      }
      for (const tok of skills[j].id.split("-")) {
        if (tok.length >= TOK_MIN && myToks.has(tok)) return true;
      }
      for (const t of skills[j].topics.split(",")) {
        for (const tok of t.split("-")) {
          if (tok.length >= TOK_MIN && myToks.has(tok)) return true;
        }
      }
      return false;
    };

    const pool = new Set<number>();
    for (const t of topics) {
      const arr = topicIdx.get(t);
      if (!arr) continue;
      for (const j of arr) if (candOk(i, j) && withinTopicOk(j)) pool.add(j);
    }
    lap("topic_pool");
    let cands: number[];
    if (pool.size >= K) cands = [...pool];
    else if (
      skills[i].sources.split(",").filter(Boolean).length >= 2 && pool.size < 3
    ) {
      // M1: multi-source skill with sparse pool — skip global fallback, let LLM say "none"
      cands = [...pool];
    } else {
      cands = [];
      for (let j = 0; j < skills.length; j++) if (candOk(i, j)) cands.push(j);
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
        const arr = topicIdx.get(t);
        if (!arr) continue;
        const sorted = [...arr].sort((a, b) => raw[a] - raw[b]);
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
    const inTopicSlots = Math.max(
      1,
      K - ancestorSet.size - GLOBAL_K - FOUNDATION_K,
    );
    for (const j of cands) {
      if (ancestorSet.has(j)) continue;
      let sc = 0;
      const aOff = j * EMBED_DIM;
      for (let d = 0; d < EMBED_DIM; d++) sc += vecs[sOff + d] * vecs[aOff + d];
      if (top.length < inTopicSlots) {
        top.push({ idx: j, score: sc });
        if (top.length === inTopicSlots) top.sort((a, b) => a.score - b.score);
      } else if (sc > top[0].score) {
        top[0] = { idx: j, score: sc };
        top.sort((a, b) => a.score - b.score);
      }
    }
    top.sort((a, b) => b.score - a.score);
    lap("cosine_top");
    const inTop = new Set([...ancestorSet, ...top.map((t) => t.idx), i]);
    const foundTop = foundations.filter((j) => !inTop.has(j) && candOk(i, j))
      .map((j) => {
        let sc = 0;
        const aOff = j * EMBED_DIM;
        for (let d = 0; d < EMBED_DIM; d++) {
          sc += vecs[sOff + d] * vecs[aOff + d];
        }
        return { idx: j, score: sc };
      }).sort((a, b) => b.score - a.score).slice(0, FOUNDATION_K);
    lap("foundation");
    const picked = new Set<number>([...inTop, ...foundTop.map((t) => t.idx)]);
    if (GLOBAL_K > 0 && (topics.length > 0 || skills[i].occupations)) {
      const crossPool = new Set<number>();
      for (const [ot, oi] of topicIdx) {
        let shared = false;
        for (const tok of ot.split("-")) {
          if (tok.length >= TOK_MIN && myToks.has(tok)) {
            shared = true;
            break;
          }
        }
        if (!shared) continue;
        for (const j of oi) crossPool.add(j);
      }
      for (const j of crossPool) {
        if (picked.has(j)) continue;
        if (!candOk(i, j)) continue;
        if (frameworkOnly[j]) continue; // H2: framework-only skills never enter global pool
        if (myOccs.size) {
          let occShared = false;
          for (const o of skills[j].occupations.split(",")) {
            if (o && myOccs.has(o)) {
              occShared = true;
              break;
            }
          }
          if (!occShared) {
            let tokShared = 0;
            for (const t of skills[j].topics.split(",")) {
              for (const tok of t.split("-")) {
                if (tok.length >= TOK_MIN && myToks.has(tok)) {
                  tokShared++;
                  break;
                }
              }
              if (tokShared >= 2) break;
            }
            if (tokShared < 2) continue;
          }
        } else {
          let tokShared = 0;
          for (const t of skills[j].topics.split(",")) {
            for (const tok of t.split("-")) {
              if (tok.length >= TOK_MIN && myToks.has(tok)) {
                tokShared++;
                break;
              }
            }
            if (tokShared >= 2) break;
          }
          if (tokShared < 2) continue;
        }
        let sc = 0;
        const aOff = j * EMBED_DIM;
        for (let d = 0; d < EMBED_DIM; d++) {
          sc += vecs[sOff + d] * vecs[aOff + d];
        }
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
      ...foundTop.map((t) => ({ ...t, src: "top" as const })),
      ...top.map((t) => ({ ...t, src: "top" as const })),
      ...globalTop.map((t) => ({ ...t, src: "global" as const })),
    ];
    const DUP_COS = 0.97;
    const dropped = new Set<number>();
    for (let a = 0; a < allPicks.length; a++) {
      if (dropped.has(a)) continue;
      const aIdx = allPicks[a].idx;
      const aOff = aIdx * EMBED_DIM;
      for (let b = a + 1; b < allPicks.length; b++) {
        if (dropped.has(b)) continue;
        const bIdx = allPicks[b].idx;
        const bOff = bIdx * EMBED_DIM;
        let sc = 0;
        for (let d = 0; d < EMBED_DIM; d++) {
          sc += vecs[aOff + d] * vecs[bOff + d];
        }
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
    out.set(skills[i].id, idxs);
    lap("dedupe");
    if ((i + 1) % 5000 === 0) {
      const el = (performance.now() - t0) / 1000;
      console.log(
        `  candidates ${i + 1}/${skills.length} (${
          ((i + 1) / el).toFixed(0)
        }/s)`,
      );
    }
  }
  lap("other");
  console.log(
    `[prereq] candidate seconds: ${
      Object.entries(secs).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(" ")
    }; full scans ${fullScans}/${skills.length}; foundations ${foundations.length}`,
  );
  return out;
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

export async function stagePrereq() {
  const { skills, diff, raw } = parseSkillsWithDifficulty();
  // A cache row is stale when it names an id outside this build (a rename or
  // a merge), or a pick no easier than its skill: raw difficulty moved, and
  // the pool the pick came from is gone. Drop it, so its prompt goes out again.
  const dOf = new Map(
    skills.map((s, i) => [s.id, { band: diff[i], raw: raw[i] }]),
  );
  // A repeated key (a torn append) keeps one row, as loadTsvCache reads it.
  const cache = loadTsvCache(PREREQ_CACHE);
  const lines = cache.size &&
    Deno.readTextFileSync(PREREQ_CACHE).split("\n").length - 1;
  const fresh = [...cache].filter(([s, ps]) => {
    const ds = dOf.get(s);
    return ds !== undefined &&
      (ps === "none" || ps.split(",").every((p) => easier(dOf.get(p), ds)));
  });
  if (fresh.length < lines) {
    // A missing cache reads as empty; an empty table does not write.
    if (fresh.length) writeTable(PREREQS, fresh);
    else Deno.removeSync(PREREQ_CACHE);
    console.log(
      `[prereq] dropped ${
        lines - fresh.length
      } of ${lines} cache rows: a gone id, a pick no easier than its skill, or a repeated key`,
    );
  }
  // SKIP_LLM=1 reuses the cache, less stale rows: a regression build needs no
  // generator.
  if (Deno.env.get("SKIP_LLM") === "1") {
    console.log("[prereq] SKIP_LLM=1: using existing cache only");
    return;
  }
  const candidates = computePrereqCandidates();
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
      // "" rejects the reply; "none" caches an empty pick list.
      clean: (raw, job) => {
        const picks = parsePrereqResponse(raw, job.cands.length);
        if (!picks) return "";
        return picks.map((p) => skills[job.cands[p]].id).join(",") || "none";
      },
    },
  );
}

// ---------- stage postproc ----------

// REVIEW: A skill is a subject area when its id is the topic of 50 or more
// skills (problem-solving, geometry, mathematics); the cutoff is your decision
// of 10 Nov. An edge drops when its prereq is a subject area and its dependent
// carries that area as a topic: "mathematics → arithmetic" orders nothing.
// "linear-algebra → dimensionality-reduction" stays. Alternative: drop every
// edge of a subject area, as todo.md first said. Then 59 of the 258 expert
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
  const rawDiff = new Map([...diffs].map(([id, d]) => [id, d.raw]));
  const band = new Map([...diffs].map(([id, d]) => [id, d.band]));

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
  console.log(`[postproc] raw edges: ${raw.length}`);

  // Load seed edges for exemption
  const seeds = readSeeds();
  const seedEdgeKeys = new Set(seeds.map((e) => `${e.dep}\t${e.pre}`));
  const isSeed = (s: string, p: string): boolean =>
    seedEdgeKeys.has(`${s}\t${p}`);
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

  // Filter 0: band-inverted
  let bandExempt = 0;
  const beforeBand = raw.length;
  raw = raw.filter(([s, p]) => {
    if ((band.get(p) ?? 0) <= (band.get(s) ?? 20)) return true;
    if (isSeed(s, p)) {
      bandExempt++;
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
    const sR = rawDiff.get(s);
    const pR = rawDiff.get(p);
    if (sR === undefined || pR === undefined) return true;
    if (pR <= sR - RAW_EPS || band.get(p)! < band.get(s)!) return true;
    if (isSeed(s, p)) {
      rawExempt++;
      return true;
    }
    return false;
  });
  console.log(
    `[postproc] dropped ${
      beforeRaw - raw.length
    } raw-inverted (${rawExempt} seed exempt)`,
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
    const pRaw = rawDiff.get(prereqId) ?? 0;
    edges.sort((a, b) =>
      Math.abs((rawDiff.get(a[0]) ?? 0) - pRaw) -
      Math.abs((rawDiff.get(b[0]) ?? 0) - pRaw)
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
  const wordToSkills = new Map<string, string[]>();
  for (const [id] of skill) {
    for (const w of id.split("-")) {
      if (w.length >= 5) {
        const arr = wordToSkills.get(w) ?? [];
        arr.push(id);
        wordToSkills.set(w, arr);
      }
    }
  }
  const stopWords = new Set<string>();
  for (const [w, list] of wordToSkills) if (list.length > 300) stopWords.add(w);
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
      b[1] - a[1] ||
      (heurUseCount.get(a[0]) ?? 0) - (heurUseCount.get(b[0]) ?? 0) ||
      (rawDiff.get(a[0]) ?? 0) - (rawDiff.get(b[0]) ?? 0)
    );
    for (const [candId] of ranked) {
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
  const sigTok2 = (id: string): Set<string> => {
    const out = new Set<string>();
    for (const w of id.split("-")) {
      if (w.length >= 4 && !stopWords.has(w)) out.add(w);
    }
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
  {
    const existing = new Set(final.map(([s, p]) => `${s}\t${p}`));
    for (const { pre: src, dep: dst } of seeds) {
      if (!skill.has(src) || !skill.has(dst) || src === dst) {
        seedMissing++;
        continue;
      }
      const key = `${dst}\t${src}`;
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
    `[postproc] seeds: added=${seedAdded}, dup=${seedDup}, missing=${seedMissing}`,
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
          gap: (rawDiff.get(s) ?? 0) - (rawDiff.get(p) ?? 0),
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
            while (
              ins < ready.length &&
              (rawDiff.get(ready[ins]) ?? 0) <= (rawDiff.get(v) ?? 0)
            ) ins++;
            ready.splice(ins, 0, v);
          }
        }
      }
      const leftover = [...seedCycleNodes].sort((a, b) =>
        (rawDiff.get(a) ?? 0) - (rawDiff.get(b) ?? 0)
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

export function stageFinalize() {
  const skills = readTable(TAGGED_DEDUPED);
  const diff = new Map([...readDifficulty()].map(([id, d]) => [id, d.band]));
  const skillIdSet = new Set<string>(skills.map((s) => s.id));
  [...diff.keys()].forEach((id, i) => {
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
    const d = diff.get(s.id);
    if (d === undefined) throw new Error(`skill ${s.id} missing difficulty`);
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
  const emittedSet = new Set<string>();
  for (const r of rows) emittedSet.add(r[0]);
  let violations = 0;
  for (const r of pending) {
    if (!r.ps) continue;
    for (const p of r.ps.split(",")) {
      if (!emittedSet.has(p)) {
        if (violations < 5) {
          console.error(`[finalize] orphan edge: ${r.id} → ${p}`);
        }
        violations++;
      }
    }
  }
  if (violations > 0) {
    throw new Error(
      `finalize: expected every prereq to name an emitted skill, received ${violations} that do not (first 5 above). skills.tsv is unchanged. Rerun: deno run -A pipeline.ts postproc`,
    );
  }
  const graph = pending.map((r) => ({
    id: r.id,
    prereqs: r.ps ? r.ps.split(",") : [],
  }));
  const ordered = topoOrder(graph).length;
  if (!pending.length || ordered < pending.length) {
    throw new Error(
      `finalize: expected a DAG of at least one skill, received ${pending.length} skills of which ${
        pending.length - ordered
      } sit on or below a cycle. skills.tsv is unchanged. Rerun: deno run -A pipeline.ts postproc`,
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

// ---------- stage pilot ----------

// The pilot grows a prereq tree top-down from data/_pilot_roots.tsv. Claude
// lists each node's prereqs, and each prereq snaps to a skill of
// 3b_tagged_deduped.tsv or becomes a new node. It runs on request only.
const PILOT_ROOTS = "data/_pilot_roots.tsv";
// Both caches key on the node, not the prompt: after a change to a prompt,
// a schema, or EXPAND_MODEL, delete them, or the pilot reports old answers.
const EXPAND_CACHE = `${BUILD}/pilot_expand.tsv`;
const SNAP_CACHE = `${BUILD}/pilot_snap.tsv`;
const PILOT_DEPTH_CAP = 30;
// A tree that never converges stops here. The caches keep every answer.
const PILOT_NODE_CAP = 10_000;
const SNAP_K = 10;
// REVIEW: The expand step runs on Claude Sonnet 5.5, the snap step on Haiku
// 5.5 (the resumableClaude default). The pilot decides the design of the
// build, so a weak model must not pass for a weak approach. Alternative: Haiku
// for both. It costs a few times less, but a chain that stops short then
// says nothing about the approach.
const EXPAND_MODEL = "claude-sonnet-5-5";

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

type PilotNode = {
  id: string;
  title: string;
  description: string;
  kind: "root" | "skill" | "new";
  via: string | null;
};

export async function stagePilot() {
  const vocab = readTable(TAGGED_DEDUPED);
  const byId = new Map(vocab.map((s) => [s.id, s]));
  const idx = skillIndex(vocab);
  // A K or grade-1 standard: every grade tag sits at grade 1 or below.
  const early = (id: string) => {
    const ds = [...(byId.get(id)?.tags ?? "").matchAll(/grade:([^,]+)/g)]
      .map((m) => gradeToDifficulty(m[1]));
    return ds.length > 0 && ds.every((d) => d !== null && d <= 2);
  };

  const nodes = new Map<string, PilotNode>();
  const prereqs = new Map<string, string[]>();
  const leaf = new Map<string, "k-standard" | "primitive">();
  const mentions = { exact: 0, snapped: 0, new: 0 };
  let rejectedCycles = 0, selfSnaps = 0;

  const rows = readTsv(PILOT_ROOTS);
  const [iKind, iId, iTitle, iDesc] = ["kind", "id", "title", "description"]
    .map((c) => col(rows, c, PILOT_ROOTS));
  const roots = rows.slice(1).map((r, k) => {
    if (!["course", "occupation", "job", "sanity"].includes(r[iKind])) {
      throw new Error(
        `${PILOT_ROOTS}:${
          k + 2
        }: expected kind course, occupation, job, or sanity, received "${
          r[iKind]
        }".`,
      );
    }
    if (r[iKind] === "sanity" && !byId.has(r[iId])) {
      throw new Error(
        `${PILOT_ROOTS}:${k + 2}: expected a skill id of ${TAGGED}, received "${
          r[iId]
        }". A rename moved it: put its new id in the file.`,
      );
    }
    if (nodes.has(r[iId])) {
      throw new Error(
        `${PILOT_ROOTS}:${k + 2}: expected a unique id, received "${
          r[iId]
        }" twice.`,
      );
    }
    nodes.set(r[iId], {
      id: r[iId],
      title: r[iTitle],
      description: r[iDesc],
      kind: "root",
      via: null,
    });
    return r[iId];
  });

  // Does `from` reach `to` along prereq edges?
  const reaches = (from: string, to: string) => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const u = stack.pop()!;
      if (u === to) return true;
      if (seen.has(u)) continue;
      seen.add(u);
      stack.push(...prereqs.get(u) ?? []);
    }
    return false;
  };
  const pathTo = (id: string) => {
    const path = [id];
    for (let v = nodes.get(id)!.via; v; v = nodes.get(v)!.via) path.push(v);
    return path.reverse();
  };

  let mat: Float32Array | null = null;
  const shortlist = async (names: string[]): Promise<string[][]> => {
    mat ??= normalizedEmbeddingsForSkills(vocab.map((s) => s.id));
    // Stage embed pads short text the same way; nomic-embed-text collapses it.
    const vecs = await embedBatch(
      names.map((n) => n.length < 40 ? `${n}. Skill: ${n}. ${n}.` : n),
      "pilot:snap",
    );
    return vecs.map((raw, li) => {
      const v = normalize(raw, `prereq name "${names[li]}"`);
      const top: { i: number; s: number }[] = [];
      for (let i = 0; i < vocab.length; i++) {
        let dot = 0;
        const off = i * EMBED_DIM;
        for (let k = 0; k < EMBED_DIM; k++) dot += v[k] * mat![off + k];
        if (top.length < SNAP_K || dot > top[top.length - 1].s) {
          top.push({ i, s: dot });
          top.sort((a, b) => b.s - a.s);
          if (top.length > SNAP_K) top.pop();
        }
      }
      return top.map((t) => vocab[t.i].id);
    });
  };

  let frontier = roots.filter((id) => {
    if (early(id)) leaf.set(id, "k-standard");
    return !early(id);
  });
  // The report is written before a cap crash, so the crash carries data.
  let capped: Error | null = null;
  grow: for (let depth = 0; frontier.length; depth++) {
    if (depth >= PILOT_DEPTH_CAP) {
      const path = pathTo(frontier[0]);
      capped = new Error(
        `pilot: expected every chain to end within ${PILOT_DEPTH_CAP} levels, received ${frontier.length} open nodes at depth ${depth}. Root "${
          path[0]
        }", path ${
          path.join(" → ")
        }. Read the answers along that path in ${EXPAND_CACHE}; ${BUILD}/pilot_stats.json holds the report.`,
      );
      break;
    }
    console.log(
      `[pilot] depth ${depth}: expand ${frontier.length}, nodes ${nodes.size}`,
    );
    await claudeNow(
      "pilot:expand",
      EXPAND_CACHE,
      frontier.map((id) => nodes.get(id)!),
      (n) =>
        `${EXPAND_PROMPT}\n\nSkill: ${n.title}${
          n.description ? `\nDescription: ${n.description.slice(0, 2500)}` : ""
        }`,
      {
        numPredict: 200,
        schema: EXPAND_SCHEMA,
        model: EXPAND_MODEL,
        clean: (raw) => {
          const names = parseExpand(raw);
          return names === null ? "" : names.join("; ") || "none";
        },
      },
    );
    const answers = loadTsvCache(EXPAND_CACHE);
    const missing = frontier.filter((id) => !answers.has(id));
    if (missing.length) {
      throw new Error(
        `pilot: expected an answer for every open node, received none for ${missing.length}: ${
          missing.slice(0, 5).join(", ")
        }. The model gave a name over 8 words, or a reply cut at max_tokens; the log above shows the first. Rerun to ask again; ${EXPAND_CACHE} keeps the rest.`,
      );
    }
    const asked = frontier.map((id) => {
      const a = answers.get(id)!;
      return [id, a === "none" ? [] : a.split("; ")] as const;
    });

    const snaps = loadTsvCache(SNAP_CACHE);
    const resolved = new Map<string, string | null>();
    const how = new Map<string, keyof typeof mentions>();
    const toSnap = new Map<string, { id: string; name: string; dep: string }>();
    for (const [dep, names] of asked) {
      for (const name of names) {
        if (resolved.has(name)) continue;
        const exact = resolveConcept(name, idx);
        if (exact) {
          resolved.set(name, exact);
          how.set(name, "exact");
          continue;
        }
        const key = slugify(name);
        if (!toSnap.has(key)) toSnap.set(key, { id: key, name, dep });
        resolved.set(name, null);
      }
    }
    const ask = [...toSnap.values()].filter((t) => !snaps.has(t.id));
    if (ask.length) {
      const lists = await shortlist(ask.map((t) => t.name));
      const jobs = ask.map((t, i) => ({ ...t, cands: lists[i] }));
      await claudeNow(
        "pilot:snap",
        SNAP_CACHE,
        jobs,
        (j) =>
          `${SNAP_PROMPT}\n\nSkill: ${j.name} (a prerequisite of ${
            nodes.get(j.dep)!.title
          })\n\nCandidates:\n${
            j.cands.map((id, i) => {
              const s = byId.get(id)!;
              return `${i + 1}. ${s.title}${
                s.description ? ` — ${s.description.slice(0, 100)}` : ""
              }`;
            }).join("\n")
          }`,
        {
          numPredict: 20,
          schema: SNAP_SCHEMA,
          clean: (raw, j) => {
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
          },
        },
      );
    }
    const snapped = loadTsvCache(SNAP_CACHE);
    for (const [name, exact] of resolved) {
      if (exact) continue;
      const key = slugify(name);
      const v = snapped.get(key);
      if (v === undefined) {
        throw new Error(
          `pilot: expected a snap answer for "${name}", received none. The reply was cut at max_tokens or refused; the log above shows the first. Rerun to ask again; ${SNAP_CACHE} keeps the rest.`,
        );
      }
      if (v !== "none" && !byId.has(v)) {
        throw new Error(
          `${SNAP_CACHE}: expected a skill id of ${TAGGED} for "${key}", received "${v}". A rebuild renamed it: delete that row and rerun.`,
        );
      }
      if (v !== "none") resolved.set(name, v);
      how.set(name, v === "none" ? "new" : "snapped");
    }

    const next: string[] = [];
    for (const [dep, names] of asked) {
      if (!names.length) leaf.set(dep, "primitive");
      for (const name of names) {
        const sid = resolved.get(name) ?? null;
        const id = sid ?? slugify(name);
        mentions[how.get(name)!]++;
        if (id === dep) {
          selfSnaps++;
          continue;
        }
        if (prereqs.get(dep)?.includes(id)) continue;
        if (reaches(id, dep)) {
          rejectedCycles++;
          continue;
        }
        (prereqs.get(dep) ?? prereqs.set(dep, []).get(dep)!).push(id);
        if (nodes.has(id)) continue;
        const s = sid ? byId.get(sid)! : null;
        nodes.set(id, {
          id,
          title: s?.title ?? name,
          description: s?.description ?? "",
          kind: s ? "skill" : "new",
          via: dep,
        });
        if (nodes.size > PILOT_NODE_CAP) {
          capped = new Error(
            `pilot: expected at most ${PILOT_NODE_CAP} nodes, received ${nodes.size} at depth ${depth}. The tree does not converge: read ${EXPAND_CACHE} for prereqs that are no simpler than their skill; ${BUILD}/pilot_stats.json holds the report.`,
          );
          break grow;
        }
        if (sid && early(sid)) leaf.set(id, "k-standard");
        else next.push(id);
      }
    }
    frontier = next;
  }

  // Height: the longest and the shortest path down to a node with no prereq.
  const hi = new Map<string, number>(), lo = new Map<string, number>();
  const height = (id: string): [number, number] => {
    if (!hi.has(id)) {
      const ps = prereqs.get(id) ?? [];
      const hs = ps.map(height);
      hi.set(id, ps.length ? 1 + Math.max(...hs.map((h) => h[0])) : 0);
      lo.set(id, ps.length ? 1 + Math.min(...hs.map((h) => h[1])) : 0);
    }
    return [hi.get(id)!, lo.get(id)!];
  };
  const above = ancestorsOf(prereqs);
  const chain = (id: string) => {
    const out = [nodes.get(id)!.title];
    for (let ps = prereqs.get(id) ?? []; ps.length;) {
      id = ps.reduce((a, b) => height(b)[0] > height(a)[0] ? b : a);
      out.push(nodes.get(id)!.title);
      ps = prereqs.get(id) ?? [];
    }
    return out.join(" → ");
  };
  const all = [...nodes.values()];
  const count = (k: PilotNode["kind"]) =>
    all.filter((n) => n.kind === k).length;
  const below = all.length - roots.length;

  // Expert pairs both ends of which the pilot reached, scored on the pilot
  // and on skills.tsv.
  const { pairs } = readLectureBank();
  const labels = [...new Set(pairs.flatMap((p) => [p.pre, p.dep]))];
  const lbIdx = skillIndex([...vocab, ...all.filter((n) => n.kind === "new")]);
  const ids = new Map(labels.map((l) => [l, resolveConcept(l, lbIdx)]));
  const misses = labels.filter((l) => !ids.get(l));
  if (misses.length) {
    const fb = await embeddingFallback(misses, vocab, "pilot");
    for (const [l, id] of fb.matched) ids.set(l, id);
  }
  const reached = pairs.flatMap((p) => {
    const pre = ids.get(p.pre), dep = ids.get(p.dep);
    return pre && dep && nodes.has(pre) && nodes.has(dep)
      ? [{ pre, dep, positive: p.positive }]
      : [];
  });
  const built = readTable(SKILLS_OUT);
  const ratio = (a: number, b: number) => b ? a / b : null;
  // A pair is negative when no set marks it positive, as in expertScores.
  const negatives = [
    ...new Set(
      reached.filter((p) => p.pre !== p.dep).map((p) => `${p.pre}\t${p.dep}`),
    ),
  ].filter((k) =>
    !reached.some((p) => p.positive && `${p.pre}\t${p.dep}` === k)
  );
  const score = (g: Map<string, string[]>) => {
    const r = expertScores(g, reached);
    // A closure that holds most nodes recalls every pair. The negatives it
    // holds say how much of the recall is real.
    const above = ancestorsOf(g);
    const negIn = negatives.filter((k) => {
      const [pre, dep] = k.split("\t");
      return above(dep).has(pre);
    }).length;
    return {
      ...r,
      precision: ratio(r.hits, r.predicted),
      recall: ratio(r.recovered, r.positives),
      negatives: negatives.length,
      negatives_in_closure: negIn,
    };
  };

  const sanityPath = "data/_sanity.tsv";
  const sanity = readTsv(sanityPath);
  const [sId, sFrom, sTo] = ["id", "grade_from", "grade_to"].map((c) =>
    col(sanity, c, sanityPath)
  );
  const bandOf = new Map(built.map((s) => [s.id, s.difficulty]));

  writeStats("pilot", {
    // Nodes still open when a cap stopped the run; 0 when it ended.
    open_at_cap: capped ? frontier.length : 0,
    nodes: all.length,
    roots: roots.length,
    snapped_nodes: count("skill"),
    new_nodes: count("new"),
    new_share: ratio(count("new"), below),
    prereq_mentions: mentions,
    leaves: {
      k_standard: [...leaf.values()].filter((r) => r === "k-standard").length,
      primitive: [...leaf.values()].filter((r) => r === "primitive").length,
      // Every prereq it named closed a cycle.
      cut_by_cycles: all.filter((n) =>
        !leaf.has(n.id) && !prereqs.get(n.id)?.length
      ).length,
    },
    rejected_cycles: rejectedCycles,
    // A prereq that snapped to its own skill.
    self_snaps: selfSnaps,
    per_root: Object.fromEntries(roots.map((r) => {
      const [h, l] = height(r);
      const up = above(r);
      return [r, {
        height_max: h,
        height_min: l,
        nodes_below: up.size,
        reaches_k_standard: [...up].some((id) => leaf.get(id) === "k-standard"),
        longest_chain: chain(r),
      }];
    })),
    expert: {
      // Distinct pairs: the four sets annotate some pairs more than once.
      reached_pairs: new Set(reached.map((p) => `${p.pre}\t${p.dep}`)).size,
      pilot: score(prereqs),
      skills_tsv: score(new Map(built.map((s) => [s.id, s.prereqs]))),
    },
    // Edges whose ends both carry a skills.tsv band. An inverted edge puts the
    // prereq in a higher band: the chain climbs instead of descending.
    band_inversions: (() => {
      const pairs = [...prereqs].flatMap(([dep, ps]) =>
        ps.flatMap((p) => {
          const bd = bandOf.get(dep), bp = bandOf.get(p);
          return bd !== undefined && bp !== undefined
            ? [{ dep, p, rise: bp - bd }]
            : [];
        })
      );
      const up = pairs.filter((e) => e.rise > 0).sort((a, b) =>
        b.rise - a.rise
      );
      return {
        pairs: pairs.length,
        inverted: up.length,
        worst: up.slice(0, 10).map((e) =>
          `${nodes.get(e.dep)!.title} (band ${bandOf.get(e.dep)}) ← ${
            nodes.get(e.p)!.title
          } (band ${bandOf.get(e.p)})`
        ),
      };
    })(),
    sanity: sanity.slice(1).filter((r) => nodes.has(r[sId])).map((r) => ({
      id: r[sId],
      grades: `${r[sFrom]}-${r[sTo]}`,
      height_max: height(r[sId])[0],
      band: bandOf.get(r[sId]) ?? null,
    })),
  });
  if (capped) throw capped;
}
