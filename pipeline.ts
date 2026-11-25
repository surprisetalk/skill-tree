#!/usr/bin/env -S deno run --allow-all
// Usage: deno run -A pipeline.ts [stage]. With no stage, runs every stage in
// the order of `stages` below.

import { stageDedupe, stageDifficulty, stageEmbed, stageTag } from "./graph.ts";
import {
  ancestorsOf,
  BUILD,
  col,
  easier,
  EDGES,
  EMBED_DIM,
  embeddingFallback,
  type ExpertPair,
  expertScores,
  isJunkTopic,
  listDefects,
  loadRawEmbeddings,
  need,
  PREREQS,
  readDifficulty,
  readJson,
  readJunyi,
  readLectureBank,
  readSeeds,
  readTable,
  readTsv,
  rerun,
  resolveConcept,
  SKILL_LIST,
  skillIndex,
  SKILLS_OUT,
  TAGGED_DEDUPED,
  topoOrder,
  withRawEmbeddingsMemo,
} from "./lib.ts";
import {
  langTokenOf,
  stageFinalize,
  stagePostproc,
  stagePrereq,
  stageSnap,
  SUBJECT_MIN,
  subjectAreaEdge,
} from "./prereq.ts";
import {
  stageEnrich,
  stageList,
  stageSeedEdges,
  stageTrees,
} from "./sources.ts";

// ---------- status ----------

// snitch convention: 1.0 at the passing threshold, 0.0 at total failure.
function grade(value: number, pass: number, fail: number): number {
  const score = (value - fail) / (pass - fail);
  if (pass === fail || !Number.isFinite(score)) {
    throw new Error(
      `expected a finite measurement between distinct bounds, received value ${value}, pass ${pass}, fail ${fail}. A count the condition divides by is 0: a build file it reads is empty. Rerun the full build: deno run -A pipeline.ts`,
    );
  }
  return Math.max(0, score);
}

type StatusSkill = {
  id: string;
  title: string;
  band: number;
  prereqs: string[];
  occupations: string[];
  topics: string[];
};

function readSkillsTsv(): StatusSkill[] {
  return readTable(SKILLS_OUT).map((r) => ({
    id: r.id,
    title: r.title,
    band: r.difficulty,
    prereqs: r.prereqs,
    occupations: r.occupations,
    topics: r.topics,
  }));
}

const ANOMALOUS_HUB_RE =
  /retell-stories-related-to.*-day|^sced-|language-immersion-prior|understand-object-naming-and-naming-conventions|^(leadership|assisted-reading|corrective-reading|study-hall)$/;

// REVIEW: Floors from the first full Claude build: 258 positives, precision
// 6/12, recall 10/258 (0.039). Each floor tightens a placeholder and never
// loosens one. Recall keeps its 0.05 placeholder and fails, and the TODO at
// candidateShare tracks the fix. Alternative: set recall to 0.03 so status passes. Then the floor
// grades this build, not the goal. The positive count stays at 3, the
// fixture's count. Alternative: 200, which catches a resolver regression on
// the real build. It needs a fixture build with 200 positive pairs.
const EXPERT_PRECISION_FLOOR = 0.25;
const EXPERT_RECALL_FLOOR = 0.05;
const EXPERT_MIN_POSITIVES = 3;

const listTable = () => readTable(SKILL_LIST);

async function stageStatus() {
  let cached: StatusSkill[] | undefined;
  const skills = () => cached ??= readSkillsTsv();
  const byId = () => new Map(skills().map((s) => [s.id, s]));
  const edgeCount = () => skills().reduce((n, s) => n + s.prereqs.length, 0);
  const usedAsPrereq = () => new Set(skills().flatMap((s) => s.prereqs));
  let seedsCached: ReturnType<typeof readSeeds> | undefined;
  const seeds = () => seedsCached ??= readSeeds();
  let orderCached: string[] | undefined;
  const order = () => orderCached ??= topoOrder(skills());
  let listCached: ReturnType<typeof listTable> | undefined;
  const listRows = () => listCached ??= listTable();
  let aboveFn: ((id: string) => Set<string>) | undefined;
  const above = () =>
    aboveFn ??= ancestorsOf(new Map(skills().map((s) => [s.id, s.prereqs])));
  // The topics stage postproc filtered by, not the ones finalize adds.
  let areaEdgeFn: ((dep: string, pre: string) => boolean) | undefined;
  const areaEdge = () =>
    areaEdgeFn ??= subjectAreaEdge(
      readTable(TAGGED_DEDUPED).map((r) => ({
        id: r.id,
        topics: r.topics.split(",").filter(Boolean),
      })),
    );
  const stat = (key: string, file = "4_stats.json"): number => {
    const path = `${BUILD}/${file}`;
    const v = (readJson(need(path)) as Record<string, unknown>)[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(
        `${path}: expected "${key}" as a number, received ${
          JSON.stringify(v)
        }. ${rerun(path)}`,
      );
    }
    return v;
  };

  // Expert pairs, as skill ids. A pair whose topic matches no skill drops out.
  const experts = new Map<string, Promise<ReturnType<typeof expertScores>>>();
  const expertOf = (
    source: string,
    read: () => { pairs: ExpertPair[]; unnamed: number },
  ) => {
    const cached = experts.get(source);
    if (cached) return cached;
    const p = (async () => {
      const { pairs, unnamed } = read();
      const labels = [...new Set(pairs.flatMap((p) => [p.pre, p.dep]))];
      const idx = skillIndex(skills());
      const ids = new Map(labels.map((l) => [l, resolveConcept(l, idx)]));
      const misses = labels.filter((l) => !ids.get(l));
      if (misses.length) {
        const fb = await embeddingFallback(misses, skills(), "status");
        for (const [l, id] of fb.matched) ids.set(l, id);
      }
      const matched = pairs.flatMap((p) => {
        const pre = ids.get(p.pre), dep = ids.get(p.dep);
        return pre && dep ? [{ pre, dep, positive: p.positive }] : [];
      });
      const r = expertScores(
        new Map(skills().map((s) => [s.id, s.prereqs])),
        matched,
      );
      console.error(
        `${source} pairs: ${matched.length}/${pairs.length} annotated pairs resolve, ${unnamed} more name no topic; ${r.positives} positive, ${r.predicted} predicted edges, ${r.hits} hits, ${r.recovered} recovered`,
      );
      if (!r.positives || !r.predicted) {
        throw new Error(
          `${source}: expected at least 1 positive pair and 1 predicted edge among resolved topics, received ${r.positives} positive and ${r.predicted} predicted. Too few topics resolve to skills.tsv: rerun the full build, or check the topic names.`,
        );
      }
      return r;
    })();
    experts.set(source, p);
    return p;
  };
  const expertSources = [
    ["Expert", () => expertOf("data/lecturebank", readLectureBank)],
    ["Junyi crowd", () => expertOf("data/junyi", readJunyi)],
  ] as const;

  const conditions: [string, () => number | Promise<number>][] = [
    ["The prereq graph is a DAG, and every prereq names another skill.", () => {
      const ss = skills();
      const ids = new Set(ss.map((s) => s.id));
      const ordered = new Set(order());
      let bad = 0;
      for (const s of ss) {
        for (const p of s.prereqs) {
          if (p === s.id || !ids.has(p) || !ordered.has(s.id)) bad++;
        }
      }
      return grade(bad / edgeCount(), 0, 1);
    }],
    ["At most 5 skills share an embedding.", () => {
      const { ids, emb } = loadRawEmbeddings();
      const groups = new Map<string, number>();
      for (let i = 0; i < ids.length; i++) {
        const k = [0, 1, 2].map((j) => emb[i * EMBED_DIM + j].toFixed(4))
          .join("_");
        groups.set(k, (groups.get(k) ?? 0) + 1);
      }
      // A spread of 390k counts overflows the call stack.
      let most = 0;
      for (const n of groups.values()) most = Math.max(most, n);
      return grade(most, 5, Math.max(ids.length, 6));
    }],
    // REVIEW: One check, the rule stage prereq's purge applies: every row
    // names skills of this build, and every pick sits below its skill. It
    // fails when difficulty reruns after prereq. Alternative: keep "Under 8% of
    // LLM prereq picks sit above their skill's difficulty". The purge re-asks
    // those picks, and candidates are all easier, so it could not fail.
    [
      "Every 5_prereqs.tsv row names skills of the current difficulty stage, each pick easier than its skill.",
      () => {
        const d = readDifficulty();
        const rows = readTable(PREREQS);
        const stale = rows.filter((r) =>
          !d.has(r.skill) ||
          r.picks.some((p) => !easier(d.get(p), d.get(r.skill)))
        );
        return grade(stale.length / rows.length, 0, 1);
      },
    ],
    // A wrong edge lifts every skill above it. Stage finalize caps the lift
    // (LIFT_CAP) and drops each edge it cannot order, so many drops mean noisy
    // edges.
    ["Under 10% of postproc edges drop in the chain lift.", () => {
      const m = byId();
      const edges = readTable(EDGES);
      const gone = edges.filter((e) =>
        !m.get(e.skill_id)?.prereqs.includes(e.prereq_id)
      );
      return grade(gone.length / edges.length, 0.10, 1);
    }],
    ["Under 10% of seed edges put the prereq in a higher band.", () => {
      const m = byId();
      const both = seeds().filter((e) => m.has(e.pre) && m.has(e.dep));
      const bad = both.filter((e) => m.get(e.pre)!.band > m.get(e.dep)!.band);
      return grade(bad.length / both.length, 0.10, 1);
    }],
    // A transitively reduced DAG drops a seed edge that a path implies: the
    // path keeps the seed's order, so the seed counts as kept.
    // Stage postproc drops a subject area's edges on purpose, seeds included.
    ["At least 80% of seed edges survive into skills.tsv.", () => {
      const all = seeds().filter((e) => !areaEdge()(e.dep, e.pre));
      const kept = all.filter((e) => above()(e.dep).has(e.pre));
      return grade(kept.length / all.length, 0.8, 0);
    }],
    [
      "At least 95% of skills sit at or above every transitive prereq's band.",
      () => {
        const m = byId();
        const maxAbove = new Map<string, number>();
        let withPrereqs = 0, clean = 0;
        for (const id of order()) {
          const s = m.get(id)!;
          let top = -Infinity;
          for (const p of s.prereqs) {
            const ps = m.get(p);
            // The DAG condition grades a dangling prereq.
            if (!ps || p === id) continue;
            top = Math.max(top, ps.band, maxAbove.get(p) ?? -Infinity);
          }
          maxAbove.set(id, top);
          if (!s.prereqs.length) continue;
          withPrereqs++;
          if (top <= s.band) clean++;
        }
        return grade(clean / withPrereqs, 0.95, 0);
      },
    ],
    ["Under 20% of skills have no prereqs and no dependents.", () => {
      const used = usedAsPrereq();
      const alone = skills().filter((s) =>
        !s.prereqs.length && !used.has(s.id)
      );
      return grade(alone.length / skills().length, 0.2, 1);
    }],
    ["Under 20% of skills are roots.", () => {
      const used = usedAsPrereq();
      const roots = skills().filter((s) => !s.prereqs.length && used.has(s.id));
      return grade(roots.length / skills().length, 0.2, 1);
    }],
    [
      "Difficulty agrees with grade anchors: Kendall τ above 0.5.",
      () => grade(stat("kendall_tau_vs_anchor"), 0.5, 0),
    ],
    [
      "Under 5% of grade-anchored skills miss their band by more than 5.",
      () =>
        grade(
          stat("grade_band_inversions") / stat("grade_anchored_skills"),
          0.05,
          1,
        ),
    ],
    // REVIEW: Two anchors in one band count as a tie (seed_anchor_ties), not a
    // conflict. Alternative: count ties too. Then a grade-3 standard that
    // builds towards another grade-3 standard fails the condition, and only
    // half-grade bands could pass it.
    [
      "Under 1% of seed pairs fail to fit bands 1–20 around the anchors.",
      () => grade(stat("seed_anchor_conflicts") / stat("seed_pairs"), 0.01, 1),
    ],
    [
      "Under 1% of seed pairs sit inside a cycle.",
      () => grade(stat("seed_cycle_pairs") / stat("seed_pairs"), 0.01, 1),
    ],
    ["Under 0.1% of source titles drop for an empty key or slug.", () =>
      grade(
        (stat("empty_key_drops", "1_stats.json") +
          stat("empty_slug_drops", "1_stats.json")) /
          stat("raw_rows", "1_stats.json"),
        0.001,
        0.01,
      )],
    // REVIEW: This check is narrower now. It leaves out rows from frameworks
    // that grade no item (SCED, Praxis, nursing: about 2,200 of 11,594 rows),
    // so it reads 99% where every OpenSALT row reads about 80%. isChildOf
    // inheritance added only a few hundred grades. Alternative: keep every
    // row. Then it stays red until those rows get grades their source does
    // not give.
    [
      "At least 95% of OpenSALT skills from graded frameworks carry a grade tag.",
      () => {
        const rows = listRows().filter((r) =>
          r.sources.split(",").includes("opensalt") &&
          (/(^|,)grade:/.test(r.tags) ||
            !/(^|,)opensalt:ungraded-framework(,|$)/.test(r.tags))
        );
        const tagged = rows.filter((r) => /(^|,)grade:/.test(r.tags));
        return grade(tagged.length / rows.length, 0.95, 0);
      },
    ],
    [
      "No anomalous hub (holiday retells, SCED catalog) has over 200 dependents.",
      () => {
        const indeg = new Map<string, number>();
        for (const s of skills()) {
          for (const p of s.prereqs) indeg.set(p, (indeg.get(p) ?? 0) + 1);
        }
        const worst = Math.max(
          0,
          ...[...indeg].filter(([id]) => ANOMALOUS_HUB_RE.test(id)).map((
            [, n],
          ) => n),
        );
        return grade(worst, 200, Math.max(skills().length, 201));
      },
    ],
    ["No language skill has another language as a prereq.", () => {
      let bad = 0;
      for (const s of skills()) {
        const ls = langTokenOf(s.id);
        if (!ls) continue;
        for (const p of s.prereqs) {
          const lp = langTokenOf(p);
          if (lp && lp !== ls) bad++;
        }
      }
      return grade(bad / edgeCount(), 0, 1);
    }],
    // TODO: Every occupation id and skill id stays under the 80-character slug
    // cap. On 20 Nov 1,889 skills carry a hex-overflow occupation, all Skills
    // England standards with an option ("domestic-and-sexual-abuse-support-
    // worker-independent-sexual-violence-dfa103"), and 63 skills keep a long
    // title: enrich rejected 39 of their summaries.
    //   1. Name an occupation with an option by the option alone, if no two
    //      standards share it.
    //   2. Rerun enrich: it asks the rejected summaries again.
    [
      "No skill has a hex-overflow id, a junk topic, or a hex-overflow occupation.",
      () => {
        const hex = /-[a-f0-9]{6}$/;
        const junk = skills().filter((s) =>
          (s.id.length >= 70 && hex.test(s.id)) || s.topics.some(isJunkTopic) ||
          s.occupations.some((o) => hex.test(o))
        );
        return grade(junk.length / skills().length, 0, 1);
      },
    ],
    // REVIEW: data/_sanity.tsv holds 23 skills across subjects, each with the
    // grades where a learner first meets it. Claude wrote the ranges from its
    // sense of curricula, after it saw each skill's band, and cited standard
    // codes from memory. Correct any row, then drop this prefix. Do not tune a
    // stage to the list; it is the check, not the target. Alternative: no
    // sanity goal, and judge the band fix by eye on the overview page.
    // TODO: A skill's band says when a typical learner can first learn it.
    // After the CSP run (20 Nov) sanity fit is 10/23 (goal 80%), 13/23 with
    // the local commit that admits CSP grades. Decision (you, 11 Nov): no
    // college-level anchors. Decision (you, 20 Nov): trust CSP's anchors, so
    // reading-comprehension, pythagorean-theorem, and project-management admit
    // their CSP grades. Misses (band, expected): nutrition 13 (4–7), grammar
    // 12 (3–6), drawing 9 (2–4), chemical-reactions 11 (7–10),
    // machine-learning 12 (15–18); new since the CSP run: spreadsheets 12
    // (7–10), budgeting 11 (6–10), first-aid 11 (7–10), accounting 11
    // (12–15), probability 7 (8–9). Rejected (14 Nov): the median grade as the
    // anchor (sanity 12 → 11/23, a spot check fails, τ same). Rejected at 93k:
    // a topic pool under 15 anchors falls back to all anchors.
    //   1. For each miss, read the anchors that set its band in
    //      build/4_difficulty.tsv, and find the shared cause.
    ["At least 80% of the sanity skills sit in their expected band.", () => {
      const path = "data/_sanity.tsv";
      const rows = readTsv(path);
      const [iId, iFrom, iTo] = ["id", "grade_from", "grade_to"].map((c) =>
        col(rows, c, path)
      );
      const m = byId();
      // Band = grade + 2: K is band 2, grade 12 band 14.
      const band = (g: string) => (g === "K" ? 0 : Number(g)) + 2;
      const fit = rows.slice(1).filter((r, k) => {
        const s = m.get(r[iId]);
        if (!s) {
          throw new Error(
            `${path}:${k + 2}: expected a skill id in skills.tsv, received "${
              r[iId]
            }". A rename moved it: put its new id in the file.`,
          );
        }
        return band(r[iFrom]) <= s.band && s.band <= band(r[iTo]);
      });
      return grade(fit.length / (rows.length - 1), 0.8, 0);
    }],
    [
      `No subject area (the id of a topic of ${SUBJECT_MIN}+ skills) is a prereq of a skill inside it.`,
      () => {
        const bad = skills().filter((s) =>
          s.prereqs.some((p) => areaEdge()(s.id, p))
        );
        return grade(bad.length / skills().length, 0, 1);
      },
    ],
    [
      "Addition is a transitive prereq of multiplication.",
      () => above()("multiplication").has("addition") ? 1 : 0,
    ],
    [
      "Spot checks pass: known tags present, known false prereqs absent.",
      () => {
        const m = byId();
        const has = (id: string, p: string) => m.get(id)?.prereqs.includes(p);
        const js = m.get("javascript"), bio = m.get("biology");
        const add = m.get("addition"), calc = m.get("calculus");
        const checks = [
          !!js &&
          (js.occupations.some((o) => o.includes("software-developer")) ||
            js.topics.some((t) => t.includes("programming"))),
          !!bio && (bio.occupations.some((o) => o.includes("biologist")) ||
            bio.topics.some((t) => t.includes("biology"))),
          !!add && !!calc && add.band <= calc.band,
          !has(
            "describe-consequences-of-following-rules",
            "antisocial-personality-disorder",
          ),
          !has(
            "distinguish-lumber-categories",
            "pack-fragile-items-for-transportation",
          ),
          !has(
            "weigh-products-or-estimate-weight",
            "use-measures-of-dispersion",
          ),
        ];
        return grade(checks.filter((c) => !c).length / checks.length, 0, 1);
      },
    ],
    // The list test sees a sample of CSP sets; this sees every row.
    [
      "No list title has a junk prefix, emphasis, a short code:* tag, or double-encoded UTF-8.",
      () => {
        const rows = listRows();
        const d = listDefects(rows);
        const bad = Object.values(d).reduce((n, b) => n + b.length, 0);
        if (bad) {
          console.error(
            `list defects: ${
              Object.entries(d).filter(([, b]) => b.length).map(([k, b]) =>
                `${k} ${b.length} (${JSON.stringify(b[0]).slice(0, 80)})`
              ).join(", ")
            }`,
          );
        }
        return grade(bad / rows.length, 0, 1);
      },
    ],
    ...expertSources.flatMap(([who, expert]) =>
      [
        [
          `Enough ${who.toLowerCase()} prereq pairs resolve to skills to grade them.`,
          async () =>
            grade((await expert()).positives, EXPERT_MIN_POSITIVES, 0),
        ],
        [
          `${who} prereq edges have precision above the floor.`,
          async () => {
            const r = await expert();
            return grade(r.hits / r.predicted, EXPERT_PRECISION_FLOOR, 0);
          },
        ],
        [
          `${who} prereq pairs have recall above the floor.`,
          async () => {
            const r = await expert();
            return grade(r.recovered / r.positives, EXPERT_RECALL_FLOOR, 0);
          },
        ],
      ] as [string, () => Promise<number>][]
    ),
    // The three TODO conditions below share one sample: `occ` is every 45th
    // skill with an occupation at band 11 or above (about 2,000 of 90,000), so
    // that `above()` stays inside the 30 s limit. Define it once, above this
    // array, when the first condition goes live:
    //   const occ = () => skills().filter((s) => s.occupations.length && s.band >= 11).filter((_, i) => i % 45 === 0);
    //
    // TODO: An occupational skill's closure reaches a pre-K or kindergarten
    // skill. Fact (25 Nov, sample of 2,000): 84% reach band 2 or below, and 3%
    // have no prereq at all (`write-dialogues`).
    //   1. Uncomment, run `deno task status`, and list 30 skills that fail.
    //   2. Sort them by cause: no candidates in stage prereq, every pick
    //      dropped in stage postproc, or a chain that ends at a root above
    //      band 2. Print the counts.
    //   3. Fix the largest cause. Do not add an edge by hand.
    // ["At least 95% of occupational skills reach a skill in band 2 or below.", () => {
    //   const m = byId();
    //   const reach = occ().filter((s) => [...above()(s.id)].some((p) => m.get(p)!.band <= 2));
    //   return grade(reach.length / occ().length, 0.95, 0);
    // }],
    //
    // TODO: A goal closure lists each pre-K skill once. Fact (25 Nov): in the
    // median occupational closure, 68% of the skills sit in bands 1 and 2,
    // mostly one infant milestone that many state frameworks restate
    // (`notices-and-responds-to-emotions-displayed-by-others` and its twins).
    // `pod-security-admissions` has 3,245 closure skills, 1,211 in band 1.
    // The pass grade: bands 1 and 2 are 2 of the 12 bands under band 13, about
    // 17% of an even closure, and the grade allows twice that.
    //   1. Take 200 band 1 skills. For each, print its 5 nearest band 1
    //      neighbours with the cosine and the reason stage dedupe kept them
    //      apart (graph.ts, stageDedupe: threshold, grade tags, the CSP
    //      word-Jaccard rule at "Merge a CSP pair").
    //   2. Fix the rule that blocks the most true twins. Do not lower the
    //      threshold for every band.
    //   3. Rerun from stage dedupe with SKIP_LLM=1, then restore the paid
    //      caches (claude.md).
    // ["Under 35% of the median occupational closure sits in bands 1 and 2.", () => {
    //   const m = byId();
    //   const shares = occ().map((s) => [...above()(s.id)]).filter((c) => c.length)
    //     .map((c) => c.filter((p) => m.get(p)!.band <= 2).length / c.length).sort((a, b) => a - b);
    //   return grade(shares[shares.length >> 1], 0.35, 1);
    // }],
    //
    // TODO: A direct prereq sits near its skill in difficulty. Fact (25 Nov):
    // 33,744 of 1,012,594 edges (3.3%) span 9 or more bands. Many prereqs are
    // strand names that sit in band 2 (`data-and-analysis`,
    // `algorithms-and-programming`, `safety-rules-and-laws`) or share one word
    // with the skill: `initiates-explorations-investigations-and-interactions`
    // (band 1) → `conduct-or-oversee-the-conduct-of-investigations-on-matters`
    // (band 12).
    //   1. Read 50 such edges. Label each: right, strand name, one shared
    //      word, or wrong band. Print the counts.
    //   2. Find which step wrote each wrong edge. This needs the source
    //      column (TODO at EDGES, lib.ts).
    //   3. Fix that step. NOTE: Do not drop every long edge in postproc.
    //      Alternative: a span cap. It hides the step that writes the edge,
    //      and it drops true edges such as counting → cash handling.
    // ["Under 1% of prereq edges span 9 or more bands.", () => {
    //   const m = byId();
    //   const long = skills().flatMap((s) => s.prereqs.filter((p) => s.band - m.get(p)!.band >= 9));
    //   return grade(long.length / edgeCount(), 0.01, 1);
    // }],
    // NOTE: The status check grades no free disk space. Alternative: grade it here. It turns red in every project on the host when one disk fills.
  ];

  const report: Record<string, { "0": number }> = {};
  await withRawEmbeddingsMemo(async () => {
    for (const [name, fn] of conditions) {
      let score: number;
      try {
        score = await fn();
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
          throw new Error(`status "${name}": ${(e as Error).message}`, {
            cause: e,
          });
        }
        console.error(`${name}\n  ${e.message}`);
        score = 0;
      }
      report[name] = { "0": score };
    }
  });
  // Since process start. It fails above 30 s and scores 0 at 100 s, snitch's
  // limit for a status command.
  report["Stage status finishes in under 30 s."] = {
    "0": grade(performance.now() / 1000, 30, 100),
  };
  console.log(JSON.stringify(report, null, 2));
  if (Object.values(report).some((r) => !(r["0"] >= 1))) Deno.exit(1);
}

// ---------- dispatch ----------

const stages: Record<string, () => void | Promise<void>> = {
  list: stageList,
  enrich: stageEnrich,
  trees: stageTrees,
  embed: stageEmbed,
  tag: stageTag,
  dedupe: stageDedupe,
  // Reads the deduped ids and the embeddings, so it runs after dedupe.
  "seed-edges": stageSeedEdges,
  difficulty: stageDifficulty,
  prereq: stagePrereq,
  snap: stageSnap,
  postproc: stagePostproc,
  finalize: stageFinalize,
  status: stageStatus,
};

await Deno.mkdir(BUILD, { recursive: true });
const arg = Deno.args[0];
if (arg) {
  // hasOwn: "constructor" and "toString" are inherited, not stages.
  if (!Object.hasOwn(stages, arg)) {
    throw new Error(
      `unknown stage: ${arg}. known: ${Object.keys(stages).join(", ")}`,
    );
  }
  await stages[arg as keyof typeof stages]();
} else {
  for (const [name, fn] of Object.entries(stages)) {
    console.log(`\n=== ${name} ===`);
    await fn();
  }
}
