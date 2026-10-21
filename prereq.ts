import {
  BUILD,
  EDGES_HEADER,
  EMBED_DIM,
  FRAMEWORK_RE,
  gradeToDifficulty,
  loadAliasesCollapsed,
  need,
  normalizedEmbeddingsForSkills,
  PREREQ_CACHE,
  readDifficulty,
  readPrereqPicks,
  readRows,
  readSeeds,
  readTagged,
  readTree,
  rerun,
  resumableOllama,
  SIG_STOP,
  SKILLS_HEADER,
  slugify,
  STOPWORDS,
  WIKI_CAT_RE,
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
  const skills: SkillWithDiff[] = readTagged().map((s) => {
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
  const { skills, raw } = parseSkillsWithDifficulty();
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
  const pathological = new Set(
    Deno.readTextFileSync(need(`${BUILD}/2_pathological.tsv`)).split("\n")
      .filter((l) => l.length),
  );
  const K = 15;
  // At 0.3, 23% of picks had reversed difficulty.
  const MIN_DIFF = 1.5;
  const ANCESTOR_K = 5;
  const GLOBAL_K = 5;
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
    return raw[j] < raw[i] - MIN_DIFF; // DR1 hard guard
  };

  const out = new Map<string, number[]>();
  const t0 = performance.now();
  for (let i = 0; i < skills.length; i++) {
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
    }

    // Ancestor candidates — foundations within same topic (or expanded for advanced skills)
    const ancestorSet = new Set<number>();
    // R9/R10: top-quintile OR specialized-tool skills get relaxed ancestor MIN_DIFF (0.1 vs 1.5)
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

    const sOff = i * EMBED_DIM;
    const top: { idx: number; score: number }[] = [];
    const globalTop: { idx: number; score: number }[] = [];
    const inTopicSlots = Math.max(1, K - ancestorSet.size - GLOBAL_K);
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
    const picked = new Set<number>([
      ...ancestorSet,
      ...top.map((t) => t.idx),
      i,
    ]);
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
    if ((i + 1) % 5000 === 0) {
      const el = (performance.now() - t0) / 1000;
      console.log(
        `  candidates ${i + 1}/${skills.length} (${
          ((i + 1) / el).toFixed(0)
        }/s)`,
      );
    }
  }
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
  const { skills } = parseSkillsWithDifficulty();
  // SKIP_LLM=1 reuses the cache as is: a regression build needs no generator.
  if (Deno.env.get("SKIP_LLM") === "1") {
    console.log("[prereq] SKIP_LLM=1: using existing cache only");
    return;
  }
  const candidates = computePrereqCandidates();
  const jobs = skills.flatMap((s) => {
    const cands = candidates.get(s.id);
    return cands?.length ? [{ ...s, cands }] : [];
  });
  await resumableOllama(
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

export function stagePostproc() {
  const skill = new Map(
    readTagged().map((s) => [s.id, {
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

  let raw: [string, string][] = readPrereqPicks().flatMap(({ skill, picks }) =>
    picks.filter(Boolean).map((p): [string, string] => [skill, p])
  );

  // Apply dedupe aliases (transitive-collapsed)
  {
    const alias = loadAliasesCollapsed();
    if (alias.size) {
      raw = raw.map(([s, p]) =>
        [alias.get(s) ?? s, alias.get(p) ?? p] as [string, string]
      )
        .filter(([s, p]) => s !== p);
    }
  }

  const beforeOrphan = raw.length;
  raw = raw.filter(([s, p]) => skill.has(s) && skill.has(p));
  if (beforeOrphan - raw.length > 0) {
    console.log(
      `[postproc] dropped ${beforeOrphan - raw.length} orphan-ref edges`,
    );
  }
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
    if (pR <= sR - RAW_EPS) return true;
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
  const final: [string, string][] = raw.filter((e) =>
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

  // Cycle breaker (Tarjan + rank-based back-edge drop)
  let cyclesBroken = 0, cyclesSeedDropped = 0;
  for (let round = 0;; round++) {
    const adj = new Map<string, string[]>();
    for (const [s, p] of final) {
      const arr = adj.get(p) ?? [];
      arr.push(s);
      adj.set(p, arr);
    }
    const index = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    let idx = 0;
    const sccs: string[][] = [];
    const nodes = new Set<string>();
    for (const [s, p] of final) {
      nodes.add(s);
      nodes.add(p);
    }
    const strongconnect = (v0: string) => {
      const callStack: {
        node: string;
        iter: Iterator<string>;
        minLink: number;
      }[] = [];
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
            const comp: string[] = [];
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

  // Write (sorted for deterministic output across runs)
  final.sort((a, b) =>
    a[0] === b[0]
      ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
      : (a[0] < b[0] ? -1 : 1)
  );
  const fh = Deno.openSync(`${BUILD}/6_edges.tsv`, {
    create: true,
    write: true,
    truncate: true,
  });
  const enc = new TextEncoder();
  fh.writeSync(enc.encode("skill_id\tprereq_id\n"));
  for (const [s, p] of final) fh.writeSync(enc.encode(`${s}\t${p}\n`));
  fh.close();
}

// ---------- stage finalize ----------

export function stageFinalize() {
  const skills = readTagged();
  const diff = new Map([...readDifficulty()].map(([id, d]) => [id, d.band]));

  const alias = loadAliasesCollapsed();
  const remap = (id: string) => alias.get(id) ?? id;

  const skillIdSet = new Set<string>(skills.map((s) => s.id));
  const prereqs = new Map<string, string[]>();
  for (const [s0, p0] of readRows(`${BUILD}/6_edges.tsv`, EDGES_HEADER)) {
    const s = remap(s0), p = remap(p0);
    if (!skillIdSet.has(s) || !skillIdSet.has(p) || s === p) continue;
    const arr = prereqs.get(s) ?? [];
    if (!arr.includes(p)) arr.push(p);
    prereqs.set(s, arr);
  }

  // Framework/wiki-category filters (module-scope FRAMEWORK_RE, WIKI_CAT_RE, YEAR_RE)
  const STOP = new Set([...STOPWORDS, "these", "those"]);
  const sigTokens = (id: string) =>
    new Set(id.split("-").filter((t) => t.length >= 4 && !STOP.has(t)));

  // Cruft drop
  const aliasCanonicals = new Set(
    readRows(`${BUILD}/3b_aliases.tsv`, "dropped_id\tcanonical_id").map((c) =>
      c[1]
    ),
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

  const rows = [SKILLS_HEADER];
  for (const r of pending) {
    rows.push(
      [
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
      ].join("\t"),
    );
  }
  const emittedSet = new Set<string>();
  for (let i = 1; i < rows.length; i++) emittedSet.add(rows[i].split("\t")[0]);
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

  Deno.writeTextFileSync("skills.tsv", rows.join("\n") + "\n");
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
    `[finalize] emitted ${rows.length - 1} skills, ${
      [...prereqs.values()].reduce((s, a) => s + a.length, 0)
    } edges`,
  );
}
