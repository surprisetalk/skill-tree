#!/usr/bin/env -S deno run --allow-all
// Usage: deno run -A pipeline.ts [stage]. With no stage, runs every stage in
// the order of `stages` below.

import { stageDedupe, stageDifficulty, stageEmbed, stageTag } from "./graph.ts";
import {
  ancestorsOf,
  BUILD,
  col,
  EMBED_DIM,
  embeddingFallback,
  expertScores,
  HAN_RE,
  isJunkTopic,
  isTranslation,
  loadRawEmbeddings,
  loadTsvCache,
  need,
  PREREQS,
  readDifficulty,
  readJson,
  readLectureBank,
  readMoocPairs,
  readSeeds,
  readTable,
  readTsv,
  rerun,
  resolveConcept,
  SKILL_LIST,
  skillIndex,
  SKILLS_OUT,
  topoOrder,
  TRANSLATE_CACHE,
} from "./lib.ts";
import {
  langTokenOf,
  stageFinalize,
  stagePilot,
  stagePostproc,
  stagePrereq,
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

const readDifficultyRaw = () =>
  new Map([...readDifficulty()].map(([id, d]) => [id, d.raw]));

const ANOMALOUS_HUB_RE =
  /retell-stories-related-to.*-day|^sced-|language-immersion-prior|understand-object-naming-and-naming-conventions|^(leadership|assisted-reading|corrective-reading|study-hall)$/;

// REVIEW: Floors from the first full Claude build: 258 positives, precision
// 6/12, recall 10/258 (0.039). Each floor tightens a placeholder and never
// loosens one. Recall keeps its 0.05 placeholder and fails, and todo.md tracks
// the fix. Alternative: set recall to 0.03 so status passes. Then the floor
// grades this build, not the goal. The positive count stays at 3, the
// fixture's count. Alternative: 200, which catches a resolver regression on
// the real build. It needs a fixture build with 200 positive pairs.
const EXPERT_PRECISION_FLOOR = 0.25;
const EXPERT_RECALL_FLOOR = 0.05;
const EXPERT_MIN_POSITIVES = 3;

async function stageStatus() {
  let cached: StatusSkill[] | undefined;
  const skills = () => cached ??= readSkillsTsv();
  const byId = () => new Map(skills().map((s) => [s.id, s]));
  const edgeCount = () => skills().reduce((n, s) => n + s.prereqs.length, 0);
  const usedAsPrereq = () => new Set(skills().flatMap((s) => s.prereqs));
  const seeds = readSeeds;
  let aboveFn: ((id: string) => Set<string>) | undefined;
  const above = () =>
    aboveFn ??= ancestorsOf(new Map(skills().map((s) => [s.id, s.prereqs])));
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
  let expertP: Promise<ReturnType<typeof expertScores>> | undefined;
  const expert = () =>
    expertP ??= (async () => {
      const { pairs, unnamed } = readLectureBank();
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
        `expert pairs: ${matched.length}/${pairs.length} annotated pairs resolve, ${unnamed} more name no topic; ${r.positives} positive, ${r.predicted} predicted edges, ${r.hits} hits, ${r.recovered} recovered`,
      );
      if (!r.positives || !r.predicted) {
        throw new Error(
          `data/lecturebank: expected at least 1 positive pair and 1 predicted edge among resolved topics, received ${r.positives} positive and ${r.predicted} predicted. Too few topics resolve to skills.tsv: rerun the full build, or check the topic names.`,
        );
      }
      return r;
    })();

  const conditions: [string, () => number | Promise<number>][] = [
    ["The prereq graph is a DAG, and every prereq names another skill.", () => {
      const ss = skills();
      const ids = new Set(ss.map((s) => s.id));
      const ordered = new Set(topoOrder(ss));
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
      return grade(Math.max(...groups.values()), 5, Math.max(ids.length, 6));
    }],
    // REVIEW: One check, the rule stage prereq's purge applies: every row
    // names skills of this build, and every pick sits below its skill. It
    // fails when difficulty reruns after prereq. Alternative: keep "Under 8% of
    // LLM prereq picks sit above their skill's difficulty". The purge re-asks
    // those picks, and candidates are all easier, so it could not fail.
    [
      "Every 5_prereqs.tsv row names skills of the current difficulty stage, each pick easier than its skill.",
      () => {
        const raw = readDifficultyRaw();
        const rows = readTable(PREREQS);
        const stale = rows.filter((r) => {
          const rs = raw.get(r.skill);
          return rs === undefined || r.picks.some((p) => {
            const rp = raw.get(p);
            return rp === undefined || rp >= rs;
          });
        });
        return grade(stale.length / rows.length, 0, 1);
      },
    ],
    ["Every Chinese MOOCCubeX label has an English translation.", async () => {
      const translations = loadTsvCache(need(TRANSLATE_CACHE));
      const labels = new Set(
        (await readMoocPairs()).flatMap((p) => [p.c1, p.c2]).filter((l) =>
          HAN_RE.test(l)
        ),
      );
      if (!labels.size) {
        throw new Error(
          "data/mooccubex/*.json.gz: expected Chinese labels in the ground_truth 1 pairs, received none.",
        );
      }
      const done = [...labels].filter((l) =>
        isTranslation(translations.get(l))
      );
      return grade(done.length / labels.size, 1, 0);
    }],
    ["Under 10% of seed edges put the prereq in a higher band.", () => {
      const m = byId();
      const both = seeds().filter((e) => m.has(e.pre) && m.has(e.dep));
      const bad = both.filter((e) => m.get(e.pre)!.band > m.get(e.dep)!.band);
      return grade(bad.length / both.length, 0.10, 1);
    }],
    // A transitively reduced DAG drops a seed edge that a path implies: the
    // path keeps the seed's order, so the seed counts as kept.
    ["At least 80% of seed edges survive into skills.tsv.", () => {
      const all = seeds();
      const kept = all.filter((e) => above()(e.dep).has(e.pre));
      return grade(kept.length / all.length, 0.8, 0);
    }],
    [
      "At least 95% of skills sit at or above every transitive prereq's band.",
      () => {
        const m = byId();
        const maxAbove = new Map<string, number>();
        let withPrereqs = 0, clean = 0;
        for (const id of topoOrder(skills())) {
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
        const rows = readTable(SKILL_LIST).filter((r) =>
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
    [
      "Enough expert prereq pairs resolve to skills to grade them.",
      async () => grade((await expert()).positives, EXPERT_MIN_POSITIVES, 0),
    ],
    [
      "Expert prereq edges have precision above the floor.",
      async () => {
        const r = await expert();
        return grade(r.hits / r.predicted, EXPERT_PRECISION_FLOOR, 0);
      },
    ],
    [
      "Expert prereq pairs have recall above the floor.",
      async () => {
        const r = await expert();
        return grade(r.recovered / r.positives, EXPERT_RECALL_FLOOR, 0);
      },
    ],
    ["The build disk has at least 10 GB free.", async () => {
      const out = await new Deno.Command("df", {
        args: ["-k", "."],
        signal: AbortSignal.timeout(10_000),
      }).output();
      if (!out.success) throw new Error(`df -k . exited ${out.code}`);
      const line = new TextDecoder().decode(out.stdout).split("\n")[1] ?? "";
      const kb = Number(line.split(/\s+/)[3]);
      if (!Number.isFinite(kb)) {
        throw new Error(
          `df -k .: expected available KB in column 4 of line 2, received "${line}"`,
        );
      }
      return grade(kb / 1024 ** 2, 10, 0);
    }],
  ];

  const report: Record<string, { "0": number }> = {};
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
  postproc: stagePostproc,
  finalize: stageFinalize,
  status: stageStatus,
};

// The pilot is an experiment that pays Claude per node, so a full run skips it.
const commands = { ...stages, pilot: stagePilot };

await Deno.mkdir(BUILD, { recursive: true });
const arg = Deno.args[0];
if (arg) {
  // hasOwn: "constructor" and "toString" are inherited, not stages.
  if (!Object.hasOwn(commands, arg)) {
    throw new Error(
      `unknown stage: ${arg}. known: ${Object.keys(commands).join(", ")}`,
    );
  }
  await commands[arg as keyof typeof commands]();
} else {
  for (const [name, fn] of Object.entries(stages)) {
    console.log(`\n=== ${name} ===`);
    await fn();
  }
}
