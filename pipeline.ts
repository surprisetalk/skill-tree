#!/usr/bin/env -S deno run --allow-all
// Usage: deno run -A pipeline.ts [stage]. With no stage, runs every stage in
// the order of `stages` below.

import { stageDedupe, stageDifficulty, stageEmbed, stageTag } from "./graph.ts";
import {
  BUILD,
  EMBED_DIM,
  HAN_RE,
  isJunkTopic,
  isTranslation,
  LIST_HEADER,
  loadRawEmbeddings,
  loadTsvCache,
  need,
  readDifficulty,
  readJson,
  readMoocPairs,
  readPrereqPicks,
  readRows,
  readSeeds,
  rerun,
  SKILLS_HEADER,
  topoOrder,
  TRANSLATE_CACHE,
} from "./lib.ts";
import {
  langTokenOf,
  stageFinalize,
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
  band: number;
  prereqs: string[];
  occupations: string[];
  topics: string[];
};

function readSkillsTsv(): StatusSkill[] {
  const list = (c: string) => c ? c.split(",") : [];
  const seen = new Set<string>();
  return readRows("skills.tsv", SKILLS_HEADER).map((c, i) => {
    const band = Number(c[4]);
    if (!/^\d+$/.test(c[4]) || band < 1 || band > 20) {
      throw new Error(
        `skills.tsv:${
          i + 2
        }: expected difficulty as an integer 1–20, received "${c[4]}". ${
          rerun("skills.tsv")
        }`,
      );
    }
    if (seen.has(c[0])) {
      throw new Error(
        `skills.tsv:${i + 2}: expected unique ids, received a second "${
          c[0]
        }". ${rerun("skills.tsv")}`,
      );
    }
    seen.add(c[0]);
    return {
      id: c[0],
      band,
      prereqs: list(c[5]),
      occupations: list(c[6]),
      topics: list(c[7]),
    };
  });
}

const readDifficultyRaw = () =>
  new Map([...readDifficulty()].map(([id, d]) => [id, d.raw]));

const ANOMALOUS_HUB_RE =
  /retell-stories-related-to.*-day|^sced-|language-immersion-prior|understand-object-naming-and-naming-conventions|^(leadership|assisted-reading|corrective-reading|study-hall)$/;

async function stageStatus() {
  let cached: StatusSkill[] | undefined;
  const skills = () => cached ??= readSkillsTsv();
  const byId = () => new Map(skills().map((s) => [s.id, s]));
  const edgeCount = () => skills().reduce((n, s) => n + s.prereqs.length, 0);
  const usedAsPrereq = () => new Set(skills().flatMap((s) => s.prereqs));
  const seeds = readSeeds;
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
    ["Under 8% of LLM prereq picks sit above their skill's difficulty.", () => {
      const raw = readDifficultyRaw();
      let picks = 0, reversed = 0;
      for (const { skill, picks: ps } of readPrereqPicks()) {
        for (const p of ps) {
          const rs = raw.get(skill), rp = raw.get(p);
          // Stale ids score in the next condition.
          if (rs === undefined || rp === undefined) continue;
          picks++;
          if (rp >= rs) reversed++;
        }
      }
      return grade(reversed / picks, 0.08, 1);
    }],
    [
      "Every 5_prereqs.tsv row names only skills from the current difficulty stage.",
      () => {
        const raw = readDifficultyRaw();
        const rows = readPrereqPicks();
        const stale = rows.filter((r) =>
          !raw.has(r.skill) || r.picks.some((p) => !raw.has(p))
        );
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
    ["At least 80% of seed edges survive into skills.tsv.", () => {
      const m = byId();
      const all = seeds();
      const kept = all.filter((e) => m.get(e.dep)?.prereqs.includes(e.pre));
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
    [
      "Under 1% of seed pairs contradict the grade anchors of both skills.",
      () => grade(stat("seed_anchor_conflicts") / stat("seed_pairs"), 0.01, 1),
    ],
    ["Under 0.1% of source titles drop for an empty key or slug.", () =>
      grade(
        (stat("empty_key_drops", "1_stats.json") +
          stat("empty_slug_drops", "1_stats.json")) /
          stat("raw_rows", "1_stats.json"),
        0.001,
        0.01,
      )],
    ["At least 95% of OpenSALT skills carry a grade tag.", () => {
      const rows = readRows(
        `${BUILD}/1_skills.tsv`,
        LIST_HEADER,
      ).filter((c) => c[3].split(",").includes("opensalt"));
      const tagged = rows.filter((c) => /(^|,)grade:/.test(c[4]));
      return grade(tagged.length / rows.length, 0.95, 0);
    }],
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
    ["Addition is a transitive prereq of multiplication.", () => {
      const m = byId();
      const stack = [...m.get("multiplication")?.prereqs ?? []];
      const seen = new Set<string>();
      while (stack.length) {
        const u = stack.pop()!;
        if (u === "addition") return 1;
        if (seen.has(u)) continue;
        seen.add(u);
        stack.push(...m.get(u)?.prereqs ?? []);
      }
      return 0;
    }],
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

await Deno.mkdir(BUILD, { recursive: true });
const arg = Deno.args[0];
if (arg) {
  // hasOwn: "constructor" and "toString" are inherited, not stages.
  if (!Object.hasOwn(stages, arg)) {
    throw new Error(
      `unknown stage: ${arg}. known: ${Object.keys(stages).join(", ")}`,
    );
  }
  await stages[arg]();
} else {
  for (const [name, fn] of Object.entries(stages)) {
    console.log(`\n=== ${name} ===`);
    await fn();
  }
}
