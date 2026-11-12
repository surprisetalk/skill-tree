import { assert, assertEquals, assertGreater } from "@std/assert";
import { expertScores } from "./lib.ts";

// Stage list runs in seconds without Ollama. The other stages need Ollama or
// minutes, so they answer to `deno task status`.
const PIPELINE = new URL("./pipeline.ts", import.meta.url).pathname;
const CONFIG = new URL("./deno.json", import.meta.url).pathname;
const run = (args: string[], cwd: string, boundMs: number) =>
  new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, PIPELINE, ...args],
    cwd,
    // No fixture run may pay for a Claude call.
    env: { ANTHROPIC_API_KEY: "" },
    signal: AbortSignal.timeout(boundMs),
    stdout: "piped",
    stderr: "piped",
  }).output();

// Every fixture run starts at load, so the runs overlap. A test awaits its own.
const early = <T>(f: () => Promise<T>) => {
  const p = f();
  p.catch(() => {});
  return () => p;
};
const LIST_BOUND_MS = 30_000;
// Stage list reads every CSP set: 25k files and 40 s of gunzip alone. So each
// list run here sees all other sources and a fixed sample of CSP sets, in a
// temp dir, so it cannot overwrite the real build/. Stage status grades the
// full output. `own` names a data folder that the caller fills; such a run
// sees no CSP set, so its counts are its own.
const CSP_SAMPLE = 200;
const listDir = (own = ""): string => {
  const dir = Deno.makeTempDirSync({ prefix: "list-" });
  Deno.mkdirSync(`${dir}/build`);
  Deno.mkdirSync(`${dir}/data/csp`, { recursive: true });
  if (own) Deno.mkdirSync(`${dir}/data/${own}`, { recursive: true });
  for (const d of Deno.readDirSync("data")) {
    if (d.name !== "csp" && d.name !== own) {
      Deno.symlinkSync(`${Deno.cwd()}/data/${d.name}`, `${dir}/data/${d.name}`);
    }
  }
  if (!own) {
    const sets = [...Deno.readDirSync("data/csp")].map((e) => e.name)
      .filter((n) => n.endsWith(".json.gz")).sort().slice(0, CSP_SAMPLE);
    for (const f of sets) {
      Deno.symlinkSync(`${Deno.cwd()}/data/csp/${f}`, `${dir}/data/csp/${f}`);
    }
  }
  // The enrich caches that stage list applies: copies, since a stage writes
  // build files in place.
  for (const f of Deno.readDirSync("build")) {
    if (/^1[b-g]_[a-z_]+\.tsv$/.test(f.name)) {
      Deno.copyFileSync(`build/${f.name}`, `${dir}/build/${f.name}`);
    }
  }
  return dir;
};
const LIST = listDir();
addEventListener("unload", () => Deno.removeSync(LIST, { recursive: true }));
const t0 = performance.now();
const listP = run(["list"], LIST, LIST_BOUND_MS);
const seedHeader = "src_id\tdst_id\tsource\tconfidence\tholdout\tfallback\n";

Deno.test("list: every row has 5 fields, a slug id, a title, and sources; ids are unique", () => {
  assertEquals(header, ["id", "title", "description", "sources", "tags"]);
  assertGreater(rows.length, 20000, "too few rows");
  for (const [i, c] of rows.entries()) {
    assertEquals(c.length, 5, `row ${i + 2} has ${c.length} fields`);
    assert(
      /^[a-z0-9]+(-[a-z0-9]+)*$/.test(c[0]) && c[0].length <= 80,
      `row ${
        i + 2
      } bad slug (expected ^[a-z0-9]+(-[a-z0-9]+)*$, at most 80 chars): ${
        c[0]
      }`,
    );
    assert(c[1] && c[3], `row ${i + 2} lacks a title or sources`);
  }
  assertEquals(
    new Set(rows.map((c) => c[0])).size,
    rows.length,
    "duplicate ids",
  );
  const canapes = rows.find((c) => c[1] === "Prepare canapés");
  assertEquals(canapes?.[0], "prepare-canapes");
});

Deno.test("list: a summary names a task whose slug overflows", () => {
  // O*NET task "Design or implement plant warehousing strategies for
  // production materials or finished products" (slug over 80 characters).
  assert(
    rows.some((c) =>
      c[1] === "Designing plant warehousing strategies for production materials"
    ),
    "the summary did not apply",
  );
});

Deno.test("list: a SKIP infill answer leaves no description", () => {
  assertEquals(rows.filter((c) => c[2] === "SKIP").map((c) => c[0]), []);
});

Deno.test("list: OpenSALT markup is parsed away", () => {
  const TAG_RE = /<\/?[a-z][^>]*>/i;
  const opensalt = rows.filter((c) => c[3].includes("opensalt"));
  const tagged = opensalt.filter((c) => TAG_RE.test(c[1] + c[2]));
  assertEquals(tagged.length, 0, `tag left in ${tagged[0]?.[0]}`);
});

Deno.test("list: OpenSALT grades come from the item or an ancestor", () => {
  const tags = (id: string) => rows.find((c) => c[0] === id)?.[4].split(",");
  // AP CSP grades its parent topic, not the essential knowledge item.
  assert(
    tags("a-sequence-of-bits-may-represent-instructions-or-data")?.includes(
      "grade:08",
    ),
  );
  assert(tags("warehouse-operations")?.includes("opensalt:ungraded-framework"));
  assert(
    rows.some((c) => c[4].includes("opensalt:ungraded-framework")),
    "no row from an ungraded framework",
  );
});

Deno.test("list stats: all four sources contribute, and dedupe merged rows", () => {
  const s = JSON.parse(Deno.readTextFileSync(`${LIST}/build/1_stats.json`));
  for (
    const src of [
      "esco",
      "onet",
      "lightcast",
      "opensalt",
      "digcomp",
      "certatlas",
      "bncc",
    ]
  ) {
    assertGreater(s.per_source[src], 0, `${src} has 0 rows`);
  }
  assertGreater(s.dedupe_collisions, 0, "no dedupe collisions");
});

// REG-EC1, REG-EC2, REG-R5: metadata, question, and scaffolding title prefixes.
// REG-TG2: deriveDisplay falls back to code:* tags, so a short one becomes a display title.
// Mojibake is UTF-8 read as Windows-1252: a lead byte (Â, Ã, â) followed by a char
// from the 0x80–0xBF continuation range as cp1252 shows it. A lone Â is a mangled
// no-break space after the pipeline collapses whitespace.
Deno.test("list: no bad title prefix, short code:* tag, or double-encoded UTF-8", () => {
  // First letter only is case-insensitive, so acronyms like "CAN Bus" pass.
  const prefix =
    /^((Unit|Lesson|Chapter|Benchmark|Standard)\s+[\d.]+|([Cc]an|[Cc]ould|[Ss]hould|[Hh]ow to|[Ww]hat is|[Ww]hy does)\s|[*_]*[Ww]ith\s+(modeling|prompting|guidance|support)|[*_])/;
  const badTitles = rows.map((c) => c[1]).filter((t) => prefix.test(t));
  assertEquals(
    badTitles.slice(0, 5),
    [],
    `${badTitles.length} titles with a prefix`,
  );
  // Markdown emphasis is gone; a lone "_" is a blank, as in "What does _ mean?".
  const marked = rows.map((c) => c[1]).filter((t) =>
    /(^|\s)[*_]+[^*_\s][^*_]*[*_]+(\s|[,.]|$)/.test(t)
  );
  assertEquals(marked.slice(0, 5), [], `${marked.length} titles with emphasis`);
  assert(
    rows.some((c) => c[1] === "Encode words with or after w read /er/"),
    "emphasis around single letters stayed",
  );
  const shortTags = rows.flatMap((c) => c[4].split(",")).filter((t) =>
    t.startsWith("code:") && t.length < "code:".length + 4
  );
  assertEquals(
    shortTags.slice(0, 5),
    [],
    `${shortTags.length} short code:* tags`,
  );
  const mojibake = /[ÂÃâ][\u0080-¿ŒœŠšŸŽžƒˆ˜–-›€™]|Â(\s|$)/;
  const badRows = rows.filter((c) => c.some((f) => mojibake.test(f)));
  assertEquals(
    badRows.slice(0, 3).map((c) => c[0]),
    [],
    `${badRows.length} rows`,
  );
});

// A small build that passes every status condition. Each test mutates a copy.
type Fixture = Record<string, string | Uint8Array>;
const gzip = async (text: string) =>
  new Uint8Array(
    await new Response(
      new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
const MOOC_GZ = await gzip(
  '{"c1":"函数","c2":"欧拉函数","ground_truth":1}\n{"c1":"集合","c2":"函数","ground_truth":0}\n',
);
// LectureBank files in the layout of the clone. Topics: 1 counting, 2 addition,
// 3 calculus, 4 multiplication. Pair 1->2 is a graph edge, 2->3 sits two edges
// apart, 1->4 likewise, and 1->3 is annotated 0 with no edge. Topic 9 has no
// name, as ids 210 and 211 have none in LB1.
const lbFixture = (
  positives = ["1,2,1", "2,3,1", "1,4,1", "1,3,0", "9,1,1"],
): Fixture => {
  const names = ["counting", "addition", "calculus", "multiplication"];
  const d = "data/lecturebank/LB-Paper";
  const ann = positives.join("\n") + "\n";
  const topics = (sep: string) =>
    names.map((n, i) => `${i + 1}${sep}${n}`).join("\r\n") + "\r\n";
  return {
    [`${d}/208topics.csv`]:
      names.map((n, i) =>
        `${i + 1},${n}${i == 2 ? ",NULL,NULL" : ",http://x/y"}`
      ).join("\n") + "\n",
    [`${d}/prerequisite_annotation.csv`]: ann,
    [`${d}/LectureBank2/data/322topics_final.tsv`]: topics("|"),
    [`${d}/LectureBank2/data/final_new_annotation.csv`]: ann,
    [`${d}/LectureBankCD/data/CV.topics.tsv`]: topics("\t"),
    [`${d}/LectureBankCD/data/CV.annotation.csv`]: ann,
    [`${d}/LectureBankCD/data/BIO.topics.tsv`]: topics("\t"),
    [`${d}/LectureBankCD/data/BIO.annotation.csv`]: ann,
  };
};
// Junyi rates "Exercise_B is a prereq of Exercise_A" from 1 to 9; over 5 is a
// positive. The same pairs as lbFixture, as exercise names.
const junyiFixture = (
  rows = [
    "addition_1,counting,7",
    "calculus,addition_1,6",
    "multiplication,counting,8",
    "calculus,counting,2",
  ],
): Fixture => {
  const csv = "Exercise_A,Exercise_B,Similarity_avg,Similarity_raw," +
    "Difficulty_avg,Difficulty_raw,Prerequisite_avg,Prerequisite_raw\n" +
    rows.map((r) => {
      const [a, b, p] = r.split(",");
      return `${a},${b},5,5_5,5,5_5,${p},${p}_${p}`;
    }).join("\n") + "\n";
  return {
    "data/junyi/relationship_annotation_training.csv": csv,
    "data/junyi/relationship_annotation_testing.csv": csv,
  };
};
const goodBuild = (): Fixture => {
  const skills: [string, number, string, string, string][] = [
    ["counting", 1, "", "", ""],
    ["addition", 2, "counting", "", ""],
    ["multiplication", 4, "addition", "", ""],
    ["calculus", 15, "multiplication", "", ""],
    ["biology", 8, "counting", "", "biology"],
    ["javascript", 10, "counting", "software-developers", ""],
  ];
  const emb = new Float32Array(skills.length * 768);
  skills.forEach((_, i) => emb[i * 768] = i + 1);
  return {
    "skills.tsv": [
      "id\ttitle\tdisplay_title\tdescription\tdifficulty\tprereqs\toccupations\ttopics\tgrade_start\tgrade_end",
      ...skills.map(([id, band, pre, occ, top]) =>
        [id, id, id, "", band, pre, occ, top, "", ""].join("\t")
      ),
    ].join("\n") + "\n",
    "build/1_skills.tsv":
      "id\ttitle\tdescription\tsources\ttags\naddition\tAddition\t\topensalt\tgrade:1\nlicensure\tLicensure\t\topensalt\topensalt:ungraded-framework\n",
    "build/1e_seed_edges.tsv":
      "src_id\tdst_id\tsource\tconfidence\tholdout\tfallback\ncounting\taddition\tkhan\t1.00\t0\t0\n",
    "build/6_edges.tsv": [
      "skill_id\tprereq_id",
      ...skills.filter(([, , pre]) => pre).map(([id, , pre]) =>
        `${id}\t${pre}`
      ),
    ].join("\n") + "\n",
    "build/2_ids.tsv": skills.map(([id]) => id).join("\n") + "\n",
    "build/2_embeddings.bin": new Uint8Array(emb.buffer),
    "build/3b_aliases.tsv": "dropped_id\tcanonical_id\n",
    "build/3b_tagged_deduped.tsv": [
      "id\ttitle\tdescription\tsources\ttags\toccupations\ttopics",
      ...skills.map(([id, , , occ, top]) =>
        [id, id, "", "test", "", occ, top].join("\t")
      ),
    ].join("\n") + "\n",
    "build/4_difficulty.tsv": [
      "id\tdifficulty\tdifficulty_raw\tanchored",
      ...skills.map(([id, band]) => `${id}\t${band}\t${band}\t0`),
    ].join("\n") + "\n",
    "build/4_stats.json": JSON.stringify({
      kendall_tau_vs_anchor: 0.8,
      grade_anchored_skills: 10,
      grade_band_inversions: 0,
      seed_pairs: 100,
      seed_cycle_pairs: 0,
      seed_anchor_conflicts: 0,
    }),
    "build/1_stats.json": JSON.stringify({
      raw_rows: 1000,
      empty_key_drops: 0,
      empty_slug_drops: 0,
    }),
    "build/5_prereqs.tsv":
      "addition\tcounting\nmultiplication\taddition\nbiology\tnone\n",
    "build/1f_translate.tsv":
      "函数\tfunction\n欧拉函数\tEuler's totient function\n",
    // Fixture bands: addition 2 (K-1 is bands 2-3), calculus 15 (11-13 is 13-15).
    "data/_sanity.tsv":
      "id\tsubject\tgrade_from\tgrade_to\twhy\naddition\tmath\tK\t1\tx\ncalculus\tmath\t11\t13\tx\n",
    "data/mooccubex/cs.json.gz": MOOC_GZ,
    "data/mooccubex/math.json.gz": MOOC_GZ,
    "data/mooccubex/psy.json.gz": MOOC_GZ,
    ...lbFixture(),
    ...junyiFixture(),
  };
};

const runIn = async (
  stage: string,
  fixture: Fixture,
  outFiles = ["skills.tsv"],
) => {
  const dir = Deno.makeTempDirSync();
  for (const [path, body] of Object.entries(fixture)) {
    const parent = path.slice(0, path.lastIndexOf("/") + 1);
    Deno.mkdirSync(`${dir}/${parent}`, { recursive: true });
    if (typeof body === "string") {
      Deno.writeTextFileSync(`${dir}/${path}`, body);
    } else Deno.writeFileSync(`${dir}/${path}`, body);
  }
  const out = await run([stage], dir, 10_000);
  const files = Object.fromEntries(
    outFiles.map((f) => {
      try {
        return [f, Deno.readTextFileSync(`${dir}/${f}`)];
      } catch (e) {
        // A failed stage can write nothing; the caller asserts on its stderr.
        if (e instanceof Deno.errors.NotFound && !out.success) return [f, ""];
        throw e;
      }
    }),
  );
  Deno.removeSync(dir, { recursive: true });
  const stderr = new TextDecoder().decode(out.stderr);
  const stdout = new TextDecoder().decode(out.stdout);
  const report = stdout.startsWith("{")
    ? JSON.parse(stdout) as Record<string, { "0": number }>
    : {};
  return {
    code: out.code,
    stderr,
    files,
    score: (name: string) => report[name]?.["0"],
  };
};

Deno.test(
  "status: a healthy build passes every condition and exits 0",
  early(async () => {
    const { code, stderr } = await runIn("status", goodBuild());
    assertEquals(code, 0, stderr);
  }),
);

Deno.test(
  "status: graph defects score below 1 and exit 1",
  early(async () => {
    const build = goodBuild();
    const defects = [
      ["german-i", 4, "counting"],
      ["french-i", 5, "german-i"],
      ["loop-a", 6, "loop-b"],
      ["loop-b", 6, "loop-a"],
      ["self", 6, "self,ghost"],
    ];
    build["skills.tsv"] += defects.map(([id, band, pre]) =>
      [id, id, id, "", band, pre, "", "", "", ""].join("\t")
    ).join("\n") + "\n";
    build["build/4_difficulty.tsv"] += defects.map(([id, band]) =>
      `${id}\t${band}\t${band}\t0\n`
    ).join("");
    // The chain lift dropped calculus ← biology.
    build["build/6_edges.tsv"] += "calculus\tbiology\n";
    // Seeds: counting > addition is an edge, counting > multiplication is a
    // path, and calculus > counting is neither.
    build["build/1e_seed_edges.tsv"] +=
      "counting\tmultiplication\tkhan\t1.00\t0\t0\ncalculus\tcounting\tkhan\t1.00\t0\t0\n";
    const { code, score, stderr } = await runIn("status", build);
    assertEquals(code, 1, stderr);
    assertEquals(
      score("At least 80% of seed edges survive into skills.tsv."),
      (2 / 3 - 0) / (0.8 - 0),
    );
    // 11 edges: loop-a, loop-b, self, and ghost are bad.
    assertEquals(
      score("The prereq graph is a DAG, and every prereq names another skill."),
      1 - 4 / 11,
    );
    assertEquals(
      score("No language skill has another language as a prereq."),
      1 - 1 / 11,
    );
    assertEquals(
      score("Under 10% of postproc edges drop in the chain lift."),
      1 - (1 / 6 - 0.1) / 0.9,
    );
    assertEquals(
      score("Addition is a transitive prereq of multiplication."),
      1,
    );
  }),
);

Deno.test(
  "status: a sanity skill outside its expected band scores below 1",
  early(async () => {
    const build = goodBuild();
    build["data/_sanity.tsv"] += "biology\tscience\tK\t1\tx\n";
    const { code, score } = await runIn("status", build);
    assertEquals(code, 1);
    // biology sits in band 8: 2 of 3 fit, and the floor is 80%.
    assertEquals(
      score("At least 80% of the sanity skills sit in their expected band."),
      2 / 3 / 0.8,
    );
  }),
);

Deno.test(
  "status: a prereq pick no easier than its skill scores below 1",
  early(async () => {
    const build = goodBuild();
    build["build/5_prereqs.tsv"] += "counting\taddition\n";
    const { code, score } = await runIn("status", build);
    assertEquals(code, 1);
    // 4 rows, 1 stale.
    assertEquals(
      score(
        "Every 5_prereqs.tsv row names skills of the current difficulty stage, each pick easier than its skill.",
      ),
      1 - 1 / 4,
    );
  }),
);

Deno.test(
  "status: a missing or still-Chinese translation scores below 1",
  early(async () => {
    for (
      const cache of ["函数\tfunction\n", "函数\tfunction\n欧拉函数\t欧拉\n"]
    ) {
      const build = goodBuild();
      build["build/1f_translate.tsv"] = cache;
      const { code, score } = await runIn("status", build);
      assertEquals(code, 1);
      assertEquals(
        score("Every Chinese MOOCCubeX label has an English translation."),
        0.5,
      );
    }
  }),
);

Deno.test(
  "status: seed pairs that contradict the anchors or sit in a cycle score below 1",
  early(async () => {
    const stats = (key: string) => {
      const build = goodBuild();
      build["build/4_stats.json"] = (build["build/4_stats.json"] as string)
        .replace(`"${key}":0`, `"${key}":50`);
      return runIn("status", build);
    };
    const [conflicts, cycles] = await Promise.all([
      stats("seed_anchor_conflicts"),
      stats("seed_cycle_pairs"),
    ]);
    assertEquals(conflicts.code, 1);
    assertEquals(cycles.code, 1);
    assertEquals(
      conflicts.score(
        "Under 1% of seed pairs fail to fit bands 1–20 around the anchors.",
      ),
      (0.5 - 1) / (0.01 - 1),
    );
    assertEquals(
      cycles.score("Under 1% of seed pairs sit inside a cycle."),
      (0.5 - 1) / (0.01 - 1),
    );
  }),
);

Deno.test(
  "status: titles dropped for an empty key or slug score below 1",
  early(async () => {
    const build = goodBuild();
    build["build/1_stats.json"] = JSON.stringify({
      raw_rows: 1000,
      empty_key_drops: 5,
      empty_slug_drops: 5,
    });
    const { code, score } = await runIn("status", build);
    assertEquals(code, 1);
    assertEquals(
      score("Under 0.1% of source titles drop for an empty key or slug."),
      0,
    );
  }),
);

Deno.test(
  "status: a missing build file scores 0 and names the stage to rerun",
  early(async () => {
    const build = goodBuild();
    delete build["build/4_stats.json"];
    const { code, score, stderr } = await runIn("status", build);
    assertEquals(code, 1);
    assertEquals(
      score("Difficulty agrees with grade anchors: Kendall τ above 0.5."),
      0,
    );
    assert(
      stderr.includes("Run: deno run -A pipeline.ts difficulty"),
      stderr,
    );
  }),
);

Deno.test(
  "status: a malformed build file crashes with the condition and the fix",
  early(async () => {
    const cases = [
      [
        "skills.tsv",
        "id\ttitle\n",
        'skills.tsv:1: expected header "id\\ttitle\\tdisplay_title',
      ],
      [
        "build/4_difficulty.tsv",
        "id\tdifficulty\tdifficulty_raw\tanchored\na\t1\tx\t0\n",
        'build/4_difficulty.tsv:2: expected difficulty_raw as a finite number, received "x"',
      ],
      [
        "build/4_difficulty.tsv",
        "id\tdifficulty\tdifficulty_raw\tanchored\na\t1\t 7\t0\n",
        'build/4_difficulty.tsv:2: expected difficulty_raw as a finite number, received " 7"',
      ],
      [
        "build/4_difficulty.tsv",
        "id\tdifficulty\tdifficulty_raw\tanchored\na\t1\t0x10\t0\n",
        'build/4_difficulty.tsv:2: expected difficulty_raw as a finite number, received "0x10"',
      ],
      [
        "build/5_prereqs.tsv",
        "addition\n",
        "build/5_prereqs.tsv:1: expected 2 tab-separated fields, received 1",
      ],
      [
        "data/mooccubex/cs.json.gz",
        await gzip("null\n"),
        "cs.json.gz:1: expected a JSON object",
      ],
    ] as const;
    await Promise.all(cases.map(async ([path, body, expected]) => {
      const build = goodBuild();
      build[path] = body;
      if (path === "skills.tsv") delete build["build/4_difficulty.tsv"];
      const { code, stderr } = await runIn("status", build);
      assert(code !== 0 && stderr.includes(expected), `${path}: ${stderr}`);
      assert(stderr.includes('status "'), stderr);
    }));
  }),
);

Deno.test(
  "list: a malformed data/_foundations.json stops the stage",
  early(async () => {
    const good = JSON.parse(Deno.readTextFileSync("data/_foundations.json"));
    const cases: [string, (f: typeof good) => void, string][] = [
      ["grade", (f) => f.foundations[0].grade_start = 99, "grades as integers"],
      [
        "slug",
        (f) => f.foundations[0].id = "Counting",
        "the slug of the title",
      ],
      ["dup", (f) => f.foundations.push(f.foundations[0]), "unique ids"],
      ["prereq", (f) => f.seed_edges[0].prereq = "nope", "a foundation prereq"],
      [
        "both",
        (f) => f.seed_edges[0].dependent_pattern = "x",
        "a foundation prereq",
      ],
      [
        "empty",
        (f) => f.seed_edges.push({ prereq: "addition", dependent_pattern: "" }),
        "a foundation prereq",
      ],
      [
        "regex",
        (f) =>
          f.seed_edges.push({ prereq: "addition", dependent_pattern: "(" }),
        "a valid regex",
      ],
    ];
    await Promise.all(cases.map(async ([name, mutate, expected]) => {
      const f = structuredClone(good);
      mutate(f);
      const dir = Deno.makeTempDirSync();
      Deno.mkdirSync(`${dir}/data`);
      Deno.writeTextFileSync(
        `${dir}/data/_foundations.json`,
        JSON.stringify(f),
      );
      const out = await run(["list"], dir, 10_000);
      Deno.removeSync(dir, { recursive: true });
      const stderr = new TextDecoder().decode(out.stderr);
      assert(out.code !== 0 && stderr.includes(expected), `${name}: ${stderr}`);
    }));
  }),
);

// A small postproc output that finalize turns into skills.tsv.
const finalBuild = (): Fixture => {
  const ids = ["counting", "addition", "multiplication"];
  return {
    "skills.tsv": "",
    "build/3b_tagged_deduped.tsv": [
      "id\ttitle\tdescription\tsources\ttags\toccupations\ttopics",
      ...ids.map((id) =>
        `${id}\t${id}\tThe arithmetic skill ${id}.\tfoundation\tgrade:1\t\tarithmetic,mathematics`
      ),
    ].join("\n") + "\n",
    "build/4_difficulty.tsv": [
      "id\tdifficulty\tdifficulty_raw\tanchored",
      ...ids.map((id, i) => `${id}\t${i + 1}\t${i + 1}\t0`),
    ].join("\n") + "\n",
    "build/3b_aliases.tsv": "dropped_id\tcanonical_id\n",
    "build/6_edges.tsv":
      "skill_id\tprereq_id\naddition\tcounting\nmultiplication\taddition\n",
    "build/1j_lcsh_tree.tsv": "counting\tarithmetic\n",
    "build/1k_dbpedia_tree.tsv": "addition\tarithmetic\n",
    "build/5b_expand.tsv": "counting\tnone\n",
    "build/5c_snap.tsv": "number-sense\tnone\n",
    "build/1e_seed_edges.tsv": seedHeader,
  };
};

// A cache row that names a gone id drops, and its prompt goes out again.
const staleP = early(() =>
  runIn("prereq", {
    ...finalBuild(),
    "build/2_ids.tsv": "counting\naddition\nmultiplication\n",
    "build/2_embeddings.bin": goodBuild()["build/2_embeddings.bin"].slice(
      0,
      3 * 768 * 4,
    ),
    "build/2_pathological.tsv": "",
    "build/5_prereqs.tsv": "addition\tcounting\nmultiplication\tghost\n",
    "build/5b_expand.tsv": "ghost\tCounting\naddition\tCounting\n",
    "build/5c_snap.tsv": "number-sense\tghost\ncounting\tcounting\n",
  }, ["build/5_prereqs.tsv", "build/5b_expand.tsv", "build/5c_snap.tsv"])
);
// A repeated key keeps one row; a cache with no fresh row goes away.
// Raw difficulty: counting 1, addition 2, multiplication 3. A row whose pick
// is no easier than its skill, or that names a merged id, is stale too.
const staleCases = [
  "addition\tcounting\naddition\tcounting\n",
  "addition\tghost\n",
  "addition\tcounting\ncounting\taddition\n",
  "addition\tcounting\noldadd\tcounting\n",
].map((cache) =>
  early(() =>
    runIn("prereq", {
      ...finalBuild(),
      "build/2_ids.tsv": "counting\naddition\nmultiplication\n",
      "build/2_embeddings.bin": goodBuild()["build/2_embeddings.bin"].slice(
        0,
        3 * 768 * 4,
      ),
      "build/2_pathological.tsv": "",
      "build/3b_aliases.tsv": "dropped_id\tcanonical_id\noldadd\taddition\n",
      "build/5_prereqs.tsv": cache,
    }, ["build/5_prereqs.tsv"])
  )
);
Deno.test("prereq: a cache row that names a gone id drops and asks again", async () => {
  const { files, stderr } = await staleP();
  assertEquals(files["build/5_prereqs.tsv"], "addition\tcounting\n", stderr);
  assertEquals(files["build/5b_expand.tsv"], "addition\tCounting\n");
  assertEquals(files["build/5c_snap.tsv"], "counting\tcounting\n");
  assert(stderr.includes("expected ANTHROPIC_API_KEY"), stderr);
  const [dup, none, drifted, merged] = await Promise.all(
    staleCases.map((c) => c()),
  );
  assertEquals(drifted.files["build/5_prereqs.tsv"], "addition\tcounting\n");
  assertEquals(merged.files["build/5_prereqs.tsv"], "addition\tcounting\n");
  assertEquals(
    dup.files["build/5_prereqs.tsv"],
    "addition\tcounting\n",
    dup.stderr,
  );
  assert(none.stderr.includes("expected ANTHROPIC_API_KEY"), none.stderr);
});

// An edge that another path implies is gone, and every closure is unchanged.
const reduceP = early(() =>
  runIn("postproc", {
    ...finalBuild(),
    "build/5_prereqs.tsv":
      "addition\tcounting\nmultiplication\taddition,counting\n",
    "build/1e_seed_edges.tsv": seedHeader,
  }, ["build/6_edges.tsv"])
);
Deno.test("postproc: keeps direct prereqs only, with every closure unchanged", async () => {
  const out = await reduceP();
  assertEquals(out.code, 0, out.stderr);
  assertEquals(
    out.files["build/6_edges.tsv"],
    "skill_id\tprereq_id\naddition\tcounting\nmultiplication\taddition\n",
  );
});

// "mathematics" names the topic of 50 skills: a subject area. As a prereq of
// addition and multiplication, both inside it, its LLM edge and its seed edge
// leave the graph.
const subjectP = early(() => {
  const b = finalBuild();
  const fillers = Array.from({ length: 50 }, (_, i) => `filler-${i}`);
  b["build/3b_tagged_deduped.tsv"] += [
    "mathematics\tMathematics\t\tfoundation\t\t\t",
    ...fillers.map((id) => `${id}\t${id}\t\tfoundation\t\t\tmathematics`),
  ].join("\n") + "\n";
  b["build/4_difficulty.tsv"] += ["mathematics", ...fillers].map((id) =>
    `${id}\t1\t0.5\t0\n`
  ).join("");
  return runIn("postproc", {
    ...b,
    "build/5_prereqs.tsv":
      "addition\tcounting,mathematics\nmultiplication\taddition\n",
    "build/1e_seed_edges.tsv": seedHeader +
      "mathematics\tmultiplication\tcourses\t1.00\t0\t0\n",
  }, ["build/6_edges.tsv"]);
});
Deno.test("postproc: a subject area is no prereq of a skill inside it, seed edges included", async () => {
  const out = await subjectP();
  assertEquals(out.code, 0, out.stderr);
  assertEquals(
    out.files["build/6_edges.tsv"],
    "skill_id\tprereq_id\naddition\tcounting\nmultiplication\taddition\n",
  );
});

// Claude names Calculus (band 4) as a prereq of addition (band 2). Unanchored,
// addition keeps the band-inverted edge, and stage finalize lifts it. Anchored,
// it does not.
const namedP = [0, 1].map((anchored) =>
  early(() => {
    const b = finalBuild();
    b["build/3b_tagged_deduped.tsv"] += ["calculus", "latin", "french-i"].map((
      id,
    ) =>
      `${id}\t${id}\tThe skill ${id}.\tfoundation\tgrade:1\t\tarithmetic,mathematics\n`
    ).join("");
    b["build/4_difficulty.tsv"] =
      (b["build/4_difficulty.tsv"] as string).replace(
        "addition\t2\t2\t0",
        `addition\t2\t2\t${anchored}`,
      ) + "calculus\t4\t4\t0\nlatin\t1\t1\t0\nfrench-i\t3\t3\t0\n";
    return runIn("postproc", {
      ...b,
      "build/5_prereqs.tsv": "addition\tcounting\nmultiplication\taddition\n",
      "build/5b_expand.tsv":
        "addition\tCalculus; Ghost Skill\nfrench-i\tLatin\n",
      "build/5c_snap.tsv":
        "calculus\tcalculus\nghost-skill\tnone\nlatin\tlatin\n",
      "build/1e_seed_edges.tsv": seedHeader,
    }, ["build/6_edges.tsv"]);
  })
);
Deno.test("postproc: a named prereq of an unanchored skill skips the easier guard; a cross-language one drops", async () => {
  const [free, anchored] = await Promise.all(namedP.map((p) => p()));
  assertEquals(free.code, 0, free.stderr);
  assertEquals(
    free.files["build/6_edges.tsv"],
    "skill_id\tprereq_id\naddition\tcalculus\naddition\tcounting\nmultiplication\taddition\n",
  );
  assertEquals(anchored.code, 0, anchored.stderr);
  assertEquals(
    anchored.files["build/6_edges.tsv"],
    "skill_id\tprereq_id\naddition\tcounting\nmultiplication\taddition\n",
  );
});

// Two picks that one alias folds into one edge are one edge, not a redundant pair.
const reduceDupP = early(() =>
  runIn("postproc", {
    ...finalBuild(),
    "build/3b_aliases.tsv": "dropped_id\tcanonical_id\nplus\taddition\n",
    "build/5_prereqs.tsv":
      "addition\tcounting\nmultiplication\taddition,plus\n",
    "build/1e_seed_edges.tsv": seedHeader,
  }, ["build/6_edges.tsv"])
);
Deno.test("postproc: an edge that an alias repeats survives once", async () => {
  const out = await reduceDupP();
  assertEquals(out.code, 0, out.stderr);
  assertEquals(
    out.files["build/6_edges.tsv"],
    "skill_id\tprereq_id\naddition\tcounting\nmultiplication\taddition\n",
  );
});

// Each of these wrote a skills.tsv that breaks its own invariants, exit 0.
Deno.test(
  "finalize: writes a DAG of unique skills, or stops",
  early(async () => {
    const good = await runIn("finalize", finalBuild());
    assertEquals(good.code, 0, good.stderr);
    assertEquals(
      good.files["skills.tsv"].split("\n")[2].split("\t")[5],
      "counting",
    );
    const cases: [string, string, string][] = [
      ["build/6_edges.tsv", "counting\tmultiplication\n", "expected a DAG"],
      [
        "build/6_edges.tsv",
        "addition\tghost\n",
        'expected a skill id, received "ghost"',
      ],
      [
        "build/3b_tagged_deduped.tsv",
        "counting\tcounting\td\tfoundation\t\t\tarithmetic\n",
        'build/3b_tagged_deduped.tsv:5: expected unique id, received a second "counting"',
      ],
      [
        "build/4_difficulty.tsv",
        "counting\t1\t1\t0\n",
        'build/4_difficulty.tsv:5: expected unique id, received a second "counting"',
      ],
    ];
    await Promise.all(cases.map(async ([path, extra, expected]) => {
      const build = finalBuild();
      build[path] += extra;
      const { code, stderr } = await runIn("finalize", build);
      assert(code !== 0 && stderr.includes(expected), `${expected}: ${stderr}`);
    }));
    const empty = finalBuild();
    empty["build/3b_tagged_deduped.tsv"] =
      "id\ttitle\tdescription\tsources\ttags\toccupations\ttopics\n";
    const { code, stderr } = await runIn("finalize", empty);
    assert(code !== 0 && stderr.includes("expected at least one row"), stderr);
  }),
);

// counting ← addition ← multiplication. Unanchored, each skill sits a band
// above its prereq. An anchored multiplication caps the chain below it. A lift
// past LIFT_CAP (4) drops the edge, unless the edge is a seed.
Deno.test(
  "finalize: the chain lift orders bands under anchors and the cap, or drops the edge",
  early(async () => {
    const lift = async (rows: string, seeds = "") => {
      const build = finalBuild();
      build["build/4_difficulty.tsv"] =
        "id\tdifficulty\tdifficulty_raw\tanchored\n" + rows;
      build["build/1e_seed_edges.tsv"] += seeds;
      const { code, stderr, files } = await runIn("finalize", build);
      assertEquals(code, 0, stderr);
      return files["skills.tsv"].split("\n").slice(1).filter((l) => l)
        .map((l) => l.split("\t")).map((c) => `${c[0]} ${c[4]} ${c[5]}`)
        .sort();
    };
    const u = (c: number, a: number, m: string) =>
      `counting\t${c}\t${c}\t0\naddition\t${a}\t${a}\t0\nmultiplication\t${m}\n`;
    assertEquals(await lift(u(5, 5, "5\t5\t0")), [
      "addition 6 counting",
      "counting 5 ",
      "multiplication 7 addition",
    ]);
    assertEquals(await lift(u(5, 5, "6\t6\t1")), [
      "addition 5 counting",
      "counting 5 ",
      "multiplication 6 addition",
    ]);
    assertEquals(await lift(u(10, 5, "5\t5\t0")), [
      "addition 5 ",
      "counting 10 ",
      "multiplication 6 addition",
    ]);
    assertEquals(
      await lift(
        u(10, 5, "5\t5\t0"),
        "counting\taddition\tkhan\t1.00\t0\t0\n",
      ),
      ["addition 9 counting", "counting 10 ", "multiplication 9 addition"],
    );
  }),
);

// A topic that is not a slug passes the reader, which checks tags as text.
Deno.test(
  "finalize: a bad cell in the output stops the write and keeps the old file",
  early(async () => {
    const build = finalBuild();
    build["skills.tsv"] = "old\n";
    build["build/3b_tagged_deduped.tsv"] = [
      "id\ttitle\tdescription\tsources\ttags\toccupations\ttopics",
      ...["counting", "addition", "multiplication", "calculus"].map((id) =>
        `${id}\t${id}\td\tfoundation\tgrade:1\t\tBad Topic`
      ),
    ].join("\n") + "\n";
    build["build/4_difficulty.tsv"] += "calculus\t4\t4\t0\n";
    const { code, stderr, files } = await runIn("finalize", build);
    assert(
      code !== 0 &&
        stderr.includes(
          'skills.tsv:2: expected topics as slugs joined by commas, or empty, received "Bad Topic"',
        ),
      stderr,
    );
    assertEquals(files["skills.tsv"], "old\n");
  }),
);

const SLUG_AS =
  "a slug (lowercase letters and digits joined by single hyphens, at most 80 characters)";

// One bad cell per build table: the reader names the file, line, column,
// expectation, and received text, then the stage to rerun.
Deno.test(
  "build tables: a bad cell stops the reading stage with a message that names the fix",
  early(async () => {
    const withFiles = (base: Fixture, files: Fixture): Fixture => ({
      ...base,
      ...files,
    });
    const cases: [string, string, Fixture, string][] = [
      [
        "status",
        "1_skills",
        withFiles(goodBuild(), {
          "build/1_skills.tsv":
            "id\ttitle\tdescription\tsources\ttags\nAddition\tAddition\t\topensalt\tgrade:1\n",
        }),
        `build/1_skills.tsv:2: expected id as ${SLUG_AS}, received "Addition". Run: deno run -A pipeline.ts list`,
      ],
      [
        "dedupe",
        "3_tagged",
        {
          "build/3_tagged.tsv":
            "id\ttitle\tdescription\tsources\ttags\toccupations\ttopics\ncounting\t\td\tfoundation\t\t\t\n",
        },
        'build/3_tagged.tsv:2: expected title as non-empty text, received ""',
      ],
      [
        "finalize",
        "3b_tagged_deduped",
        withFiles(finalBuild(), {
          "build/3b_tagged_deduped.tsv":
            "id\ttitle\tdescription\tsources\ttags\toccupations\ttopics\ncounting\tcounting\td\tfoundation\n",
        }),
        "build/3b_tagged_deduped.tsv:2: expected 7 tab-separated fields, received 4. Run: deno run -A pipeline.ts dedupe",
      ],
      [
        "finalize",
        "3b_aliases",
        withFiles(finalBuild(), {
          "build/3b_aliases.tsv": "dropped_id\tcanonical_id\nghost\tCounting\n",
        }),
        `build/3b_aliases.tsv:2: expected canonical_id as ${SLUG_AS}, received "Counting". Run: deno run -A pipeline.ts dedupe`,
      ],
      [
        "finalize",
        "4_difficulty",
        withFiles(finalBuild(), {
          "build/4_difficulty.tsv":
            "id\tdifficulty\tdifficulty_raw\tanchored\ncounting\t1\t1\t0\naddition\t2\t2\t0\nmultiplication\t21\t3\t0\n",
        }),
        'build/4_difficulty.tsv:4: expected difficulty as an integer 1–20, received "21". Run: deno run -A pipeline.ts difficulty',
      ],
      [
        "finalize",
        "6_edges",
        withFiles(finalBuild(), {
          "build/6_edges.tsv": "skill_id\tprereq_id\naddition\tcounting",
        }),
        'build/6_edges.tsv:2: expected a newline after the last row, received "addition\tcounting". Run: deno run -A pipeline.ts postproc',
      ],
      [
        "status",
        "1e_seed_edges",
        withFiles(goodBuild(), {
          "build/1e_seed_edges.tsv": seedHeader +
            "counting\taddition\tkhan\t1.00\t2\t0\n",
        }),
        'build/1e_seed_edges.tsv:2: expected holdout as 0 or 1, received "2". Run: deno run -A pipeline.ts seed-edges',
      ],
      [
        "status",
        "2_ids",
        withFiles(goodBuild(), {
          "build/2_ids.tsv": goodBuild()["build/2_ids.tsv"] + "counting\n",
        }),
        'build/2_ids.tsv:7: expected unique id, received a second "counting". Run: deno run -A pipeline.ts embed',
      ],
      [
        "status",
        "5_prereqs",
        withFiles(goodBuild(), {
          "build/5_prereqs.tsv": "addition\tCounting\n",
        }),
        `build/5_prereqs.tsv:1: expected picks as "none" or slugs joined by commas, received "Counting". Run: deno run -A pipeline.ts prereq`,
      ],
      [
        "prereq",
        "2_pathological",
        withFiles(finalBuild(), {
          "build/2_ids.tsv": goodBuild()["build/2_ids.tsv"],
          "build/2_embeddings.bin": goodBuild()["build/2_embeddings.bin"],
          "build/2_pathological.tsv": "counting\nDep\n",
        }),
        `build/2_pathological.tsv:2: expected id as ${SLUG_AS}, received "Dep". Run: deno run -A pipeline.ts embed`,
      ],
      [
        "status",
        "skills.tsv",
        withFiles(goodBuild(), {
          "skills.tsv": goodBuild()["skills.tsv"] +
            "late\tlate\tlate\t\t0\t\t\t\t\t\n",
        }),
        'skills.tsv:8: expected difficulty as an integer 1–20, received "0". Run: deno run -A pipeline.ts finalize',
      ],
      [
        "postproc",
        "5_prereqs ids",
        withFiles(finalBuild(), {
          "build/5_prereqs.tsv": "addition\tcounting\nmultiplication\tghost\n",
          "build/1e_seed_edges.tsv": seedHeader,
        }),
        'build/5_prereqs.tsv:2: expected a skill id from build/3b_tagged_deduped.tsv, received "ghost". Run: deno run -A pipeline.ts prereq. It drops the rows that name a gone id and asks again.',
      ],
      [
        "postproc",
        "1e_seed_edges ids",
        withFiles(finalBuild(), {
          "build/5_prereqs.tsv": "addition\tcounting\n",
          "build/1e_seed_edges.tsv": seedHeader +
            "counting\taddition\tkhan\t1.00\t0\t0\nghost\taddition\tkhan\t1.00\t1\t0\n",
        }),
        'build/1e_seed_edges.tsv:3: expected a skill id from build/3b_tagged_deduped.tsv, received "ghost". Run: deno run -A pipeline.ts seed-edges',
      ],
      [
        "finalize",
        "4_difficulty ids",
        withFiles(finalBuild(), {
          "build/4_difficulty.tsv": finalBuild()["build/4_difficulty.tsv"] +
            "ghost\t4\t4\t0\n",
        }),
        'build/4_difficulty.tsv:5: expected a skill id, received "ghost". Run: deno run -A pipeline.ts difficulty',
      ],
    ];
    await Promise.all(cases.map(async ([stage, name, fixture, expected]) => {
      const { code, stderr } = await runIn(stage, fixture, []);
      assert(code !== 0 && stderr.includes(expected), `${name}: ${stderr}`);
    }));
  }),
);

// The repo's data/ as symlinks, with the given data/ and build/ files written
// in place of the originals.
const farm = (files: Record<string, string>): string => {
  const dir = Deno.makeTempDirSync();
  const link = (rel: string) => {
    for (const e of Deno.readDirSync(`data/${rel}`)) {
      const path = `data/${rel}${e.name}`;
      const hit = Object.keys(files).filter((f) =>
        f === path || f.startsWith(`${path}/`)
      );
      if (!hit.length) {
        Deno.symlinkSync(Deno.realPathSync(path), `${dir}/${path}`);
      } else if (e.isDirectory) {
        Deno.mkdirSync(`${dir}/${path}`);
        link(`${rel}${e.name}/`);
      }
    }
  };
  Deno.mkdirSync(`${dir}/data`);
  Deno.mkdirSync(`${dir}/build`);
  link("");
  for (const [path, body] of Object.entries(files)) {
    Deno.writeTextFileSync(`${dir}/${path}`, body);
  }
  return dir;
};

// Each of these exited 0, or crashed without naming the file.
Deno.test(
  "a bad input file or stage name stops the run and names the cause",
  early(async () => {
    const esco = Deno.readTextFileSync("data/esco/skills_en.csv");
    const [skillsHead, skillsRow] = Deno.readTextFileSync(
      "data/onet/Skills.txt",
    )
      .split("\n").map((l) => l.split("\t"));
    const onetSkillId = skillsRow[skillsHead.indexOf("Element ID")];
    const cases: [string, Record<string, string>, string][] = [
      ["constructor", {}, "unknown stage: constructor"],
      [
        "list",
        {
          "data/esco/skills_en.csv": esco.replace(
            "preferredLabel",
            "preferredLabe1",
          ),
        },
        'data/esco/skills_en.csv: expected a column "preferredLabel"',
      ],
      [
        "list",
        { "data/onet/Task Statements.txt": "" },
        "data/onet/Task Statements.txt: expected a header row",
      ],
      [
        "list",
        { "data/lightcast/skills.json": '{"attributions":[]}' },
        "data/lightcast/skills.json: expected",
      ],
      [
        "list",
        {
          "data/onet/Content Model Reference.txt":
            "Element ID\tElement Name\tDescription\nElement ID\tElement Name\tDescription\n",
        },
        "data/onet/Content Model Reference.txt:2: expected a data row, received a copy of the header",
      ],
      [
        "list",
        {
          "data/onet/Content Model Reference.txt":
            "Element ID\tElement Name\tDescription\nx\ty\tz\n",
        },
        `data/onet/Skills.txt:2: expected element "${onetSkillId}" in data/onet/Content Model Reference.txt, received none`,
      ],
      [
        "list",
        { "build/1b_infill.tsv": "a\tdone\nb\thal" },
        "build/1b_infill.tsv: expected a newline after the last row",
      ],
    ];
    await Promise.all(cases.map(async ([stage, files, expected]) => {
      const dir = farm(files);
      const out = await run([stage], dir, 10_000);
      Deno.removeSync(dir, { recursive: true });
      const stderr = new TextDecoder().decode(out.stderr);
      assert(
        out.code !== 0 && stderr.includes(expected),
        `${expected}: ${stderr}`,
      );
    }));
  }),
);

// REG-MF1: OpenSALT splits these concepts into hundreds of grade variants and
// emits no hub, so data/_foundations.json supplies them. A foundation may merge
// into an existing skill, so the check follows its foundation:<id> tag.
Deno.test("list: every foundation lands in a skill", () => {
  const tags = new Set(rows.flatMap((c) => c[4].split(",")));
  const { foundations } = JSON.parse(
    Deno.readTextFileSync("data/_foundations.json"),
  );
  const missing = foundations.map((f: { id: string }) => `foundation:${f.id}`)
    .filter((t: string) => !tags.has(t));
  assertEquals(missing, [], "foundations missing from build/1_skills.tsv");
  for (const id of ["addition", "multiplication", "fractions", "loops"]) {
    assert(rows.some((c) => c[0] === id), `no skill has id ${id}`);
  }
});

Deno.test("list: DigComp outcomes carry the source, area, competence, and level tags", () => {
  const dc = rows.filter((c) => c[3].includes("digcomp"));
  // 523 LearningOutcome nodes; dedupe may merge a few.
  assertGreater(dc.length, 480, "too few DigComp rows");
  const tagsOf = (c: string[]) => c[4].split(",");
  for (const c of dc.filter((c) => tagsOf(c).includes("digcomp:outcome"))) {
    const t = tagsOf(c);
    assert(t.some((x) => x.startsWith("digcomp:area:")), `${c[0]}: no area`);
    assert(
      t.some((x) => x.startsWith("digcomp:competence:")),
      `${c[0]}: no competence`,
    );
    assert(
      t.some((x) =>
        /^digcomp:level:(basic|intermediate|advanced|highly-advanced)$/.test(x)
      ),
      `${c[0]}: no level`,
    );
  }
  // A title whose slug overflows gets a summary, and its text moves to the
  // description.
  assert(
    dc.some((c) =>
      [c[1], c[2]].some((f) =>
        f.startsWith(
          "Acknowledge the benefits of using different digital search tools",
        )
      )
    ),
    "LO1.1.01 missing",
  );
});

Deno.test("list: an OpenSALT Khan item carries the exercise slug that khandata.tsv names", () => {
  const row = rows.find((c) => c[1] === "Subtract tenths like 0.9-0.7");
  assert(
    row?.[4].split(",").includes(
      "khan:subtracting-decimals-without-the-standard-algorithm-1",
    ),
    `tags: ${row?.[4]}`,
  );
});

Deno.test("list: BNCC objectives carry the source, subject, and the grades of their code", () => {
  const bncc = rows.filter((c) => c[3].includes("bncc"));
  // 1,580 objectives; dedupe may merge a few.
  assertGreater(bncc.length, 1400, "too few BNCC rows");
  const grades = (code: string) => {
    const t = rows.find((c) => c[4].split(",").includes(`code:${code}`))?.[4]
      .split(",") ?? [];
    assert(t.some((x) => x.startsWith("bncc:subject:")), `${code}: no subject`);
    return t.filter((x) => x.startsWith("grade:")).sort();
  };
  assertEquals(grades("EF67LP08"), ["grade:6", "grade:7"]);
  assertEquals(grades("EI01CG01"), ["grade:PK"]);
  assertEquals(grades("EM13MAT101"), ["grade:10", "grade:11", "grade:12"]);
});

Deno.test("list: Cert Atlas objectives carry the source and the exam; dropped vendors stay out", () => {
  const ca = rows.filter((c) => c[3].includes("certatlas"));
  assertGreater(ca.length, 4000, "too few Cert Atlas rows");
  assert(
    ca.some((c) => c[1].toLowerCase() === "security controls"),
    "CompTIA Security+ objective 1.1 missing",
  );
  // The downloader filters on vendor_slug; the file keeps only certifying_body
  // as `body`. "AWS - American Welding Society" is a kept exam, not Amazon.
  const exams = JSON.parse(
    new TextDecoder().decode(
      new Deno.Command("gzip", {
        args: ["-dc", "data/certatlas/exams.json.gz"],
        stdout: "piped",
      }).outputSync().stdout,
    ),
  ) as { body: string }[];
  const dropped = exams.filter((e) =>
    /^(microsoft|aws|amazon web services)$/i.test(e.body)
  );
  assertEquals(dropped.length, 0, "an exam of a dropped vendor");
});

// Learning Commons: 5 nodes and 3 edges. The ids are node uuids in the export.
const lcExtract = (rows: object[]) =>
  gzip(
    [
      { k: "attributions", statements: ["Learning Commons, CC BY 4.0"] },
      ...rows,
    ]
      .map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
const lcItem = (id: string, text: string, code = "") => ({
  k: "item",
  id,
  text,
  code,
  type: "Standard",
  grades: ["3"],
  attribution: 0,
});
const lcFixture = () => [
  lcItem("n1", "Add fractions with like denominators", "3.NF.A.1"),
  lcItem("n2", "Compare two fractions with the same numerator"),
  lcItem("n3", "Solve word problems about money"),
  { k: "component", id: "n4", text: "Name a unit fraction", grades: ["3"] },
  lcItem("n5", "Round whole numbers to the nearest ten"),
  { k: "edge", rel: "buildsTowards", from: "n2", to: "n1" },
  { k: "edge", rel: "buildsTowards", from: "n3", to: "n5" },
  { k: "edge", rel: "hasStandardAlignment", from: "n3", to: "n5" },
];

Deno.test("list: Learning Commons rows carry the source, grade tags, and a clean title", () => {
  const lc = rows.filter((c) => c[3].includes("learningcommons"));
  assertGreater(lc.length, 1000, "too few Learning Commons rows");
  assert(
    lc.some((c) => c[4].split(",").includes("learningcommons:component")),
    "no learning component",
  );
  assert(
    lc.some((c) => c[4].split(",").includes("learningcommons:standard")),
    "no standards item",
  );
  assert(lc.some((c) => /(^|,)grade:K(,|$)/.test(c[4])), "no grade:K tag");
  assertEquals(
    lc.filter((c) => /<\/?[a-z][^>]*>/i.test(c[1] + c[2])).length,
    0,
    "markup left in a Learning Commons row",
  );
  const ids = new Set(
    Deno.readTextFileSync(`${LIST}/build/1m_lc_ids.tsv`).split("\n").slice(1)
      .filter((l) => l).map((l) => l.split("\t")[1]),
  );
  assert(
    lc.every((c) => ids.has(c[0])),
    "a Learning Commons row has no node in build/1m_lc_ids.tsv",
  );
});

Deno.test("lcSeedEdges: buildsTowards runs prereq to dependent through aliases; the rest is quarantined", async () => {
  const { lcSeedEdges } = await import("./sources.ts");
  const dir = Deno.makeTempDirSync();
  Deno.mkdirSync(`${dir}/data/learningcommons`, { recursive: true });
  Deno.writeFileSync(
    `${dir}/data/learningcommons/graph.jsonl.gz`,
    await lcExtract(lcFixture()),
  );
  const cwd = Deno.cwd();
  Deno.chdir(dir);
  try {
    const { edges, dropped } = lcSeedEdges(
      new Map([["n1", "add-fractions"], ["n2", "compare-fractions"], [
        "n3",
        "money",
      ], ["n5", "round-tens"]]),
      new Map([["compare-fractions", "fractions"], ["round-tens", "money"]]),
    );
    // n2 -> n1 resolves; n3 -> n5 folds into one skill through an alias.
    assertEquals(edges.map((e) => [e.src, e.dst]), [[
      "fractions",
      "add-fractions",
    ]]);
    assertEquals(dropped.map((d) => d.reason), ["self-loop"]);
    // A node that stage list dropped has no skill; the edge goes to quarantine.
    const none = lcSeedEdges(new Map([["n1", "add-fractions"]]), new Map());
    assertEquals(none.edges, []);
    assertEquals(none.dropped.map((d) => d.reason), ["no-skill", "no-skill"]);
  } finally {
    Deno.chdir(cwd);
    Deno.removeSync(dir, { recursive: true });
  }
});

const gz = async (text: string) =>
  new Uint8Array(
    await new Response(
      new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );

// Header columns are the ones the reader uses plus noise the real files carry.
const COURSE_HEAD = "dataset,code,title,description\n";
const EDGE_HEAD =
  "institution,dataset,edition,source_prereq,target_course,group_index,is_alternative,timing,min_grade\n";
const edgeRow = (
  ds: string,
  src: string,
  dst: string,
  group: number,
  alt: number,
  timing: string,
) => `U,${ds},e,${src},${dst},${group},${alt},${timing},\n`;

async function inCourseDir<T>(
  courses: string,
  edges: string,
  f: (m: typeof import("./lib.ts")) => Promise<T>,
): Promise<T> {
  const m = await import("./lib.ts");
  const dir = Deno.makeTempDirSync();
  Deno.mkdirSync(`${dir}/data/courses`, { recursive: true });
  Deno.writeFileSync(`${dir}/data/courses/courses.csv.gz`, await gz(courses));
  Deno.writeFileSync(
    `${dir}/data/courses/prereq_edges.csv.gz`,
    await gz(edges),
  );
  const cwd = Deno.cwd();
  Deno.chdir(dir);
  try {
    return await f(m);
  } finally {
    Deno.chdir(cwd);
    Deno.removeSync(dir, { recursive: true });
  }
}

Deno.test("readCoursePairs: joins codes to titles, keeps timing before, splits OR groups, quarantines the rest", async () => {
  const courses = COURSE_HEAD + [
    'd1,A100,Algebra,"a, b"',
    "d1,B200,Calculus,",
    "d1,C300,  Real   Analysis ,",
    "d1,D400,Topology,",
    "d1,X1,Software Engineering,",
    "d1,X1,(continuation),",
    "d1,E1,,",
    "d1,F1,Calculus III for Engineers,",
    "d1,G1,Introduction to Topology Lab II,",
    "d1,H1,CEN 271,",
    "d1,J1,Ethics in Islam,",
    "d1,K1,ETHICS IN ISLAM,",
    "d1,L1,Practicum II,",
    "d2,A100,Algebra,",
    "d2,D400,Topology,",
  ].join("\n") + "\n";
  const edges = EDGE_HEAD +
    edgeRow("d1", "A100", "B200", 0, 0, "before") +
    // One OR group: each alternative alone is a pair.
    edgeRow("d1", "A100", "C300", 1, 1, "before") +
    edgeRow("d1", "B200", "C300", 1, 1, "before") +
    edgeRow("d1", "C300", "D400", 0, 0, "concurrent") +
    edgeRow("d1", "B200", "D400", 0, 0, "before_or_concurrent") +
    edgeRow("d1", "Z9", "D400", 0, 0, "before") +
    edgeRow("d1", "X1", "D400", 0, 0, "before") +
    edgeRow("d1", "E1", "D400", 0, 0, "before") +
    // The same titles in another dataset make one pair.
    edgeRow("d2", "A100", "D400", 0, 0, "before") +
    edgeRow("d1", "A100", "D400", 0, 0, "before") +
    // Course wrapping goes, so these name Calculus and Topology.
    edgeRow("d1", "F1", "G1", 0, 0, "before") +
    edgeRow("d1", "B200", "F1", 0, 0, "before") +
    edgeRow("d1", "H1", "D400", 0, 0, "before") +
    edgeRow("d1", "A100", "J1", 0, 0, "before") +
    // A case variant of a kept pair makes no second pair.
    edgeRow("d1", "A100", "K1", 0, 0, "before") +
    // A wrapper word alone names no topic.
    edgeRow("d1", "L1", "D400", 0, 0, "before");
  const r = await inCourseDir(courses, edges, (m) => m.readCoursePairs());
  assertEquals(r.pairs.map((p) => [p.src, p.dst]), [
    ["Algebra", "Calculus"],
    ["Algebra", "Real Analysis"],
    ["Calculus", "Real Analysis"],
    ["Algebra", "Topology"],
    ["Calculus", "Topology"],
    ["Algebra", "Ethics in Islam"],
  ]);
  assertEquals(r.pairs[0].raw, "d1:A100->B200");
  assertEquals(r.dropped.map((d) => [d.raw, d.reason]), [
    ["d1:Z9->D400", "no-course"],
    ["d1:X1->D400", "ambiguous-code"],
    ["d1:E1->D400", "no-title"],
    ["d1:B200->F1", "same-topic"],
    ["d1:H1->D400", "code-title"],
    ["d1:L1->D400", "no-topic"],
  ]);
  assertEquals(r.timingCounts, {
    before: 14,
    concurrent: 1,
    before_or_concurrent: 1,
  });
});

Deno.test("courseTopic: a strip never leaves a dangling connector or cuts a year", async () => {
  const { courseTopic } = await import("./lib.ts");
  assertEquals(
    [
      "Soil Mechanics and Laboratory",
      "History of Europe from 1350 to 1618",
      "Advanced Topics in Digital Fabrication II",
      "Introduction to Programming in C",
    ].map(courseTopic),
    [
      "Soil Mechanics and Laboratory",
      "History of Europe from 1350 to 1618",
      "Digital Fabrication",
      "Programming in C",
    ],
  );
});

Deno.test("readCoursePairs: the order more institutions give wins, and a tie drops both", async () => {
  const courses = COURSE_HEAD + ["d1", "d2", "d3"].flatMap((d) => [
    `${d},A,Algebra,`,
    `${d},B,Calculus,`,
    `${d},C,Physics,`,
    `${d},D,Chemistry,`,
  ]).join("\n") + "\n";
  const row = (inst: string, ds: string, s: string, t: string) =>
    `${inst},${ds},e,${s},${t},0,0,before,\n`;
  const edges = EDGE_HEAD +
    row("U1", "d1", "A", "B") + row("U2", "d2", "A", "B") +
    row("U3", "d3", "B", "A") +
    row("U1", "d1", "C", "D") + row("U2", "d2", "D", "C");
  const r = await inCourseDir(courses, edges, (m) => m.readCoursePairs());
  assertEquals(r.pairs.map((p) => [p.src, p.dst]), [["Algebra", "Calculus"]]);
  assertEquals(r.dropped.map((d) => [d.raw, d.reason]), [
    ["d3:B->A", "minority-order"],
    ["d1:C->D", "contested-order"],
    ["d2:D->C", "contested-order"],
  ]);
});

Deno.test("readCoursePairs: an unknown timing or alternative flag throws with the line", async () => {
  const courses = COURSE_HEAD + "d1,A,Algebra,\nd1,B,Calculus,\n";
  for (
    const [row, want] of [
      [
        edgeRow("d1", "A", "B", 0, 0, "after"),
        "timing as before, concurrent, or before_or_concurrent",
      ],
      [edgeRow("d1", "A", "B", 0, 2, "before"), "is_alternative as 0 or 1"],
    ]
  ) {
    const err = await inCourseDir(
      courses,
      EDGE_HEAD + row,
      async (m) => {
        try {
          await m.readCoursePairs();
        } catch (e) {
          return (e as Error).message;
        }
        return "";
      },
    );
    assert(err.includes("prereq_edges.csv.gz:2") && err.includes(want), err);
  }
});

Deno.test("readCoursePairs: an empty duplicate title is no title, and a missing file names the downloader", async () => {
  const courses = COURSE_HEAD + [
    "d1,A100,Algebra,",
    "d1,A100,,",
    "d1,B200,Calculus,",
    "d1,B200,Analysis,",
  ].join("\n") + "\n";
  const edges = EDGE_HEAD + edgeRow("d1", "A100", "B200", 0, 0, "before");
  const r = await inCourseDir(courses, edges, async (m) => {
    const ok = await m.readCoursePairs();
    Deno.removeSync("data/courses/courses.csv.gz");
    let err = "";
    try {
      await m.readCoursePairs();
    } catch (e) {
      err = (e as Error).message;
    }
    return { ok, err };
  });
  assertEquals(r.ok.pairs, []);
  assertEquals(r.ok.dropped.map((d) => d.reason), ["ambiguous-code"]);
  assert(
    r.err.includes(
      "data/courses/courses.csv.gz: missing. Run: deno run -A data/download.ts",
    ),
    r.err,
  );
});

Deno.test("readCoursePairs: one distinct title beside an empty one joins", async () => {
  const courses = COURSE_HEAD +
    "d1,A100,Algebra,\nd1,A100,,\nd1,B200,Calculus,\n";
  const edges = EDGE_HEAD + edgeRow("d1", "A100", "B200", 0, 0, "before");
  const r = await inCourseDir(courses, edges, (m) => m.readCoursePairs());
  assertEquals(r.pairs.map((p) => [p.src, p.dst]), [["Algebra", "Calculus"]]);
});

Deno.test("readCoursePairs: a truncated gzip names the file to delete, because the downloader skips an existing file", async () => {
  const err = await inCourseDir(
    COURSE_HEAD + "d1,A,Algebra,\n",
    EDGE_HEAD,
    async (m) => {
      Deno.writeFileSync(
        "data/courses/courses.csv.gz",
        new Uint8Array([31, 139, 8]),
      );
      try {
        await m.readCoursePairs();
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    },
  );
  assert(err.includes("rm data/courses/courses.csv.gz;"), err);
});

// Embeddings: one orthogonal axis per group, so a group of rows shares a vector.
Deno.test(
  "dedupe: a shared code:* tag across OpenSALT and Learning Commons, or an alignment edge, makes a candidate that the cosine test decides; standards that start at different grades never merge",
  async () => {
    const skills: [string, string, string, string, number][] = [
      // id, title, sources, tags, vector axis
      [
        "os-code",
        "Combine fractions sharing a denominator",
        "opensalt",
        "code:3.NF.A.1",
        0,
      ],
      [
        "lc-code",
        "Add fractions with like denominators",
        "learningcommons",
        "code:3.NF.A.1",
        0,
      ],
      ["os-far", "Estimate sums of decimals", "opensalt", "code:4.NBT.B.4", 1],
      [
        "lc-far",
        "Order the planets by size",
        "learningcommons",
        "code:4.NBT.B.4",
        2,
      ],
      ["lc-a", "Sketch a bar model of a story", "learningcommons", "", 3],
      [
        "lc-b",
        "Draw tape diagrams for word problems",
        "learningcommons",
        "",
        3,
      ],
      [
        "os-g1",
        "Solve word problems within 20",
        "opensalt",
        "code:OA.2,grade:01,grade:02",
        5,
      ],
      [
        "lc-g2",
        "Solve word problems within 100",
        "learningcommons",
        "code:OA.2,grade:02",
        5,
      ],
      ["lc-c", "Recite the months of the year", "learningcommons", "", 4],
      ["lc-d", "Name the days of a week", "learningcommons", "", 4],
    ];
    const emb = new Float32Array(skills.length * 768);
    skills.forEach(([, , , , axis], i) => emb[i * 768 + axis] = 1);
    const { code, stderr, files } = await runIn("dedupe", {
      "build/3_tagged.tsv": [
        "id\ttitle\tdescription\tsources\ttags\toccupations\ttopics",
        ...skills.map(([id, title, sources, tags]) =>
          [id, title, "", sources, tags, "", ""].join("\t")
        ),
      ].join("\n") + "\n",
      "build/2_ids.tsv": skills.map(([id]) => id).join("\n") + "\n",
      "build/2_embeddings.bin": new Uint8Array(emb.buffer),
      "build/1j_lcsh_tree.tsv": "",
      "build/1k_dbpedia_tree.tsv": "",
      "build/1m_lc_ids.tsv": "node_id\tskill_id\nm-a\tlc-a\nm-b\tlc-b\n",
      "data/learningcommons/graph.jsonl.gz": await lcExtract([
        lcItem("m-a", "Sketch a bar model of a story"),
        lcItem("m-b", "Draw tape diagrams for word problems"),
        { k: "edge", rel: "hasStandardAlignment", from: "m-a", to: "m-b" },
      ]),
    }, ["build/3b_aliases.tsv"]);
    assertEquals(code, 0, stderr);
    // The code pair and the alignment pair merge. The pair with a far vector and
    // the unaligned pair with one vector stay apart, and so does the code pair
    // of grades 1–2 and grade 2: they share grade 2 but start apart.
    const pairs = files["build/3b_aliases.tsv"].split("\n").slice(1)
      .filter((l) => l).map((l) => l.split("\t").sort().join("+")).sort();
    assertEquals(pairs, ["lc-a+lc-b", "lc-code+os-code"]);
  },
);

// A tiny difficulty input. Embeddings are orthogonal, so each anchor keeps its
// own value and an unanchored skill gets the default raw 10.
const difficultyBuild = (): Fixture => {
  const skills: [string, string, string][] = [
    ["grade-low", "Grade low", "grade:1"],
    ["grade-high", "Grade high", "grade:12"],
    ["khan-low", "Khan low", ""],
    ["khan-high", "Khan high", ""],
    ["do-the-budget", "Do the budget.", ""],
    ["review-art-or-design-materials", "Review art or design materials.", ""],
    ["pre", "Pre", ""],
    ["dep", "Dep", ""],
    ["a", "A", ""],
    ["b", "B", ""],
    ["c", "C", ""],
    ["dig", "Dig", "digcomp:level:advanced"],
    ...Array.from(
      { length: 22 },
      (_, i): [string, string, string] => [`chain-${i}`, `Chain ${i}`, ""],
    ),
  ];
  const emb = new Float32Array(skills.length * 768);
  skills.forEach((_, i) => emb[i * 768 + i] = 1);
  return {
    "build/3b_tagged_deduped.tsv": [
      "id\ttitle\tdescription\tsources\ttags\toccupations\ttopics",
      ...skills.map(([id, title, tags]) =>
        [id, title, "", "test", tags, "", ""].join("\t")
      ),
    ].join("\n") + "\n",
    "build/2_ids.tsv": skills.map(([id]) => id).join("\n") + "\n",
    "build/2_embeddings.bin": new Uint8Array(emb.buffer),
    "build/3b_aliases.tsv": "dropped_id\tcanonical_id\n",
    "build/1e_seed_edges.tsv":
      "src_id\tdst_id\tsource\tconfidence\tholdout\tfallback\npre\tdep\tkhan\t1.00\t0\t0\n",
    "data/khanacademy/khandata.tsv":
      "Code\tData Name\tPrereq(s)\tH-Position\tV-Position\tDisplay Name\tLink to Practice problem\n" +
      "1\tkhan-low\troot\t0\t0\tKhan low\t\n2\tkhan-high\t1\t0\t10\tKhan high\t\n",
  };
};

// Column `i` of build/4_difficulty.tsv by skill id: 1 is the band, 2 the raw.
const difficultyCol = (files: Record<string, string>, i: number) =>
  new Map(
    files["build/4_difficulty.tsv"].split("\n").slice(1).filter((l) => l)
      .map((l) => l.split("\t")).map((c) => [c[0], Number(c[i])]),
  );

Deno.test(
  "difficulty: a seed prereq sits in a lower band, and only grades and Khan anchor",
  early(async () => {
    const { code, stderr, files } = await runIn(
      "difficulty",
      difficultyBuild(),
      [
        "build/4_difficulty.tsv",
        "build/4_stats.json",
      ],
    );
    assertEquals(code, 0, stderr);
    // A job zone and a DigComp level ("dig") anchor nothing.
    assertEquals(JSON.parse(files["build/4_stats.json"]).anchors, {
      grade: 2,
      khan: 2,
      total: 4,
    });
    const band = difficultyCol(files, 1);
    assert(
      band.get("pre")! < band.get("dep")!,
      `seed prereq band ${band.get("pre")} is not below dependent band ${
        band.get("dep")
      }`,
    );
  }),
);

Deno.test(
  "difficulty: an anchored skill sits in its anchor's band, whatever its neighbors",
  early(async () => {
    // Two twin pairs: each pair shares one vector, and the grades run in
    // opposite id order. kNN blends a pair, and PAV pools one of them.
    const twins = [["twin-a", "1"], ["twin-b", "12"], ["twin-c", "12"], [
      "twin-d",
      "1",
    ]];
    const build = difficultyBuild();
    const old = new Float32Array(
      (build["build/2_embeddings.bin"] as Uint8Array).slice().buffer,
    );
    const n = old.length / 768;
    const emb = new Float32Array((n + 4) * 768);
    emb.set(old);
    twins.forEach((_, k) => emb[(n + k) * 768 + 700 + (k >> 1)] = 1);
    build["build/2_embeddings.bin"] = new Uint8Array(emb.buffer);
    build["build/2_ids.tsv"] += twins.map(([id]) => id).join("\n") + "\n";
    build["build/3b_tagged_deduped.tsv"] += twins.map(([id, g]) =>
      [id, id, "", "test", `grade:${g}`, "", ""].join("\t")
    ).join("\n") + "\n";
    const { code, stderr, files } = await runIn("difficulty", build, [
      "build/4_difficulty.tsv",
    ]);
    assertEquals(code, 0, stderr);
    const band = difficultyCol(files, 1);
    // Grade 1 is difficulty 2, band 3; grade 12 is 13, band 14.
    assertEquals(
      twins.map(([id]) =>
        band.get(id)
      ),
      [3, 14, 14, 3],
    );
  }),
);

Deno.test(
  "difficulty: a workplace skill takes its band from the school anchors near it",
  early(async () => {
    // do-the-budget, an O*NET task of job zone 3, shares grade-low's vector.
    const build = difficultyBuild();
    const emb = new Float32Array(
      (build["build/2_embeddings.bin"] as Uint8Array).slice().buffer,
    );
    const budget = 4;
    emb.fill(0, budget * 768, (budget + 1) * 768);
    emb[budget * 768] = 1;
    build["build/2_embeddings.bin"] = new Uint8Array(emb.buffer);
    const { code, stderr, files } = await runIn("difficulty", build, [
      "build/4_difficulty.tsv",
    ]);
    assertEquals(code, 0, stderr);
    const band = difficultyCol(files, 1);
    assertEquals(band.get("do-the-budget"), 3);
    // grade-low keeps its own band: grade 1 is band 3.
    assertEquals(band.get("grade-low"), 3);
  }),
);

Deno.test(
  "difficulty: a skill tagged K to 12 sets no anchor",
  early(async () => {
    const build = difficultyBuild();
    const old = new Uint8Array(build["build/2_embeddings.bin"] as Uint8Array);
    const emb = new Float32Array(old.length / 4 + 768);
    emb.set(new Float32Array(old.slice().buffer));
    emb[emb.length - 1] = 1;
    build["build/2_embeddings.bin"] = new Uint8Array(emb.buffer);
    build["build/2_ids.tsv"] += "every-grade\n";
    build["build/3b_tagged_deduped.tsv"] +=
      "every-grade\tEvery grade\t\ttest\tgrade:K,grade:6,grade:12\t\t\n";
    const { code, stderr, files } = await runIn("difficulty", build, [
      "build/4_difficulty.tsv",
      "build/4_stats.json",
    ]);
    assertEquals(code, 0, stderr);
    const stats = JSON.parse(files["build/4_stats.json"]);
    // Only grade-low and grade-high anchor on a grade.
    assertEquals([stats.anchors.grade, stats.grade_anchored_skills], [2, 2]);
    assert(difficultyCol(files, 1).get("every-grade")! > 2);
  }),
);

Deno.test(
  "difficulty: an expert seed claims its bands before a course seed",
  early(async () => {
    // The course pair wants a below grade-low (band 3); the Khan pair wants a
    // above grade-high (band 14). Only one fits, and the course pair yields.
    const { code, stderr, files } = await runIn("difficulty", {
      ...difficultyBuild(),
      "build/1e_seed_edges.tsv": seedHeader +
        "a\tgrade-low\tcourses\t1.00\t0\t0\ngrade-high\ta\tkhan\t1.00\t0\t0\n",
    }, ["build/4_difficulty.tsv", "build/4_stats.json"]);
    assertEquals(code, 0, stderr);
    assertGreater(difficultyCol(files, 1).get("a")!, 14);
    assertEquals(
      JSON.parse(files["build/4_stats.json"]).seed_anchor_conflicts_by_source,
      { courses: 1 },
    );
    assertEquals(
      JSON.parse(files["build/4_stats.json"]).seed_anchor_conflict_samples,
      { courses: ["a(~11) > grade-low(3)"] },
    );
  }),
);

const withSeeds = (pairs: string[][]): Fixture => ({
  ...difficultyBuild(),
  "build/1e_seed_edges.tsv": seedHeader +
    pairs.map(([a, b]) => `${a}\t${b}\tkhan\t1.00\t0\t0\n`).join(""),
});

Deno.test(
  "difficulty: a seed chain is ordered in any seed order",
  early(async () => {
    await Promise.all(
      [[["a", "b"], ["b", "c"]], [["b", "c"], ["a", "b"]]].map(
        async (pairs) => {
          const { code, stderr, files } = await runIn(
            "difficulty",
            withSeeds(pairs),
            ["build/4_difficulty.tsv"],
          );
          assertEquals(code, 0, stderr);
          const band = difficultyCol(files, 1);
          assert(
            band.get("a")! < band.get("b")! && band.get("b")! < band.get("c")!,
            `chain bands a=${band.get("a")} b=${band.get("b")} c=${
              band.get("c")
            }`,
          );
        },
      ),
    );
  }),
);

Deno.test(
  "difficulty: an unanchored seed chain of 22 skills drops one pair, not all",
  early(async () => {
    const ids = Array.from({ length: 22 }, (_, i) => `chain-${i}`);
    const { code, stderr, files } = await runIn(
      "difficulty",
      withSeeds(ids.slice(1).map((d, i) => [ids[i], d])),
      ["build/4_difficulty.tsv", "build/4_stats.json"],
    );
    assertEquals(code, 0, stderr);
    assertEquals(
      JSON.parse(files["build/4_stats.json"]).seed_anchor_conflicts,
      1,
    );
    const band = difficultyCol(files, 1);
    const inverted = ids.slice(1).filter((d, i) =>
      i !== 19 && band.get(ids[i])! >= band.get(d)!
    );
    assertEquals(inverted, []);
  }),
);

Deno.test(
  "difficulty: a seed pair of two anchors in one band is a tie, not a conflict",
  early(async () => {
    const build = withSeeds([["grade-low", "a"]]);
    build["build/3b_tagged_deduped.tsv"] =
      (build["build/3b_tagged_deduped.tsv"] as string)
        .replace("a\tA\t\ttest\t\t", "a\tA\t\ttest\tgrade:1\t");
    const { code, stderr, files } = await runIn("difficulty", build, [
      "build/4_stats.json",
    ]);
    assertEquals(code, 0, stderr);
    const s = JSON.parse(files["build/4_stats.json"]);
    assertEquals([s.seed_anchor_ties, s.seed_anchor_conflicts], [1, 0]);
  }),
);

Deno.test(
  "difficulty: a seed dependent anchored at the lowest band drops the pair",
  early(async () => {
    const build = withSeeds([["pre", "dep"]]);
    build["build/3b_tagged_deduped.tsv"] =
      (build["build/3b_tagged_deduped.tsv"] as string)
        .replace("dep\tDep\t\ttest\t\t", "dep\tDep\t\ttest\tgrade:PK\t");
    const { code, stderr, files } = await runIn("difficulty", build, [
      "build/4_difficulty.tsv",
      "build/4_stats.json",
    ]);
    assertEquals(code, 0, stderr);
    assertEquals(difficultyCol(files, 1).get("dep"), 1);
    assertEquals(
      JSON.parse(files["build/4_stats.json"]).seed_anchor_conflicts,
      1,
    );
  }),
);

Deno.test(
  "difficulty: a seed self-loop or unknown id stops the stage",
  early(async () => {
    await Promise.all(
      [[["a", "a"]], [["a", "ghost"]]].map(async (pairs) => {
        const { code, stderr } = await runIn(
          "difficulty",
          withSeeds(pairs),
          [],
        );
        assert(code !== 0, `seeds ${JSON.stringify(pairs)} exit 0`);
        assert(/self-loop|not in build\/1_skills/.test(stderr), stderr);
      }),
    );
  }),
);

Deno.test(
  "difficulty: a seed cycle is skipped and counted, and a seed never moves an anchored skill",
  early(async () => {
    const outs = ["build/4_difficulty.tsv", "build/4_stats.json"];
    const [cycle, conflict, none, chain, anchoredChain] = await Promise.all([
      runIn("difficulty", withSeeds([["a", "b"], ["b", "a"]]), outs),
      runIn("difficulty", withSeeds([["grade-high", "grade-low"]]), outs),
      runIn("difficulty", withSeeds([]), outs),
      runIn(
        "difficulty",
        withSeeds([["grade-high", "a"], ["a", "grade-low"]]),
        outs,
      ),
      runIn("difficulty", withSeeds([["grade-high", "a"], ["a", "b"]]), outs),
    ]);
    assertEquals(anchoredChain.code, 0, anchoredChain.stderr);
    const band = difficultyCol(anchoredChain.files, 1);
    assert(
      band.get("grade-high")! < band.get("a")! &&
        band.get("a")! < band.get("b")!,
      `chain bands grade-high=${band.get("grade-high")} a=${band.get("a")} b=${
        band.get("b")
      }`,
    );
    assertEquals(
      difficultyCol(anchoredChain.files, 2).get("a"),
      difficultyCol(none.files, 2).get("a"),
      "a seed moved a raw value",
    );
    // The first pair fits, so only the second pair drops.
    assertEquals(chain.code, 0, chain.stderr);
    assertEquals(
      JSON.parse(chain.files["build/4_stats.json"]).seed_anchor_conflicts,
      1,
    );
    assertEquals(cycle.code, 0, cycle.stderr);
    const stats = (r: typeof cycle) =>
      JSON.parse(r.files["build/4_stats.json"]);
    assertEquals(stats(cycle).seed_cycle_pairs, 2);
    assertEquals(conflict.code, 0, conflict.stderr);
    assertEquals(stats(conflict).seed_anchor_conflicts, 1);
    assertEquals(stats(conflict).seed_pairs, 1);
    assertEquals(stats(chain).seed_pairs, 2);
    assertEquals(
      difficultyCol(chain.files, 2).get("a"),
      difficultyCol(none.files, 2).get("a"),
      "a dropped seed pair moved a raw value",
    );
    assertEquals(stats(none).seed_anchor_conflicts, 0);
    assertEquals(stats(none).seed_cycle_pairs, 0);
    const [moved, kept] = [conflict, none].map((r) =>
      difficultyCol(r.files, 1)
    );
    assertEquals(moved.get("grade-high"), kept.get("grade-high"));
    assertEquals(moved.get("grade-low"), kept.get("grade-low"));
  }),
);

// Stage list over a temp data dir whose OpenSALT folder holds only `items`.
const listOpensalt = async (items: Record<string, string>[]) => {
  const dir = listDir("opensalt");
  Deno.writeTextFileSync(
    `${dir}/data/opensalt/a.json`,
    JSON.stringify({ CFDocument: { title: "T" }, CFItems: items }),
  );
  const out = await run(["list"], dir, LIST_BOUND_MS);
  const stdout = new TextDecoder().decode(out.stdout);
  const stderr = new TextDecoder().decode(out.stderr);
  const rows = out.success
    ? Deno.readTextFileSync(`${dir}/build/1_skills.tsv`).split("\n").filter((
      l,
    ) => l).map((l) => l.split("\t"))
    : [];
  const titles = rows.map((c) => c[1]);
  const ids = rows.map((c) => c[0]);
  Deno.removeSync(dir, { recursive: true });
  return { code: out.code, stdout, stderr, titles, ids };
};

// Stage list over a temp data dir whose `name` folder holds only `files`.
const listWithData = async (
  name: string,
  files: Record<string, Uint8Array>,
) => {
  const dir = listDir(name);
  for (const [f, bytes] of Object.entries(files)) {
    Deno.writeFileSync(`${dir}/data/${name}/${f}`, bytes);
  }
  const out = await run(["list"], dir, LIST_BOUND_MS);
  Deno.removeSync(dir, { recursive: true });
  return {
    code: out.code,
    stderr: new TextDecoder().decode(out.stderr),
  };
};

const exam = (over: Record<string, unknown> = {}, objective: unknown = {
  title: "Security controls",
  sub: [],
}) => ({
  id: "x1",
  name: "X1",
  body: "Body",
  domains: [{ name: "D", objectives: [objective] }],
  ...over,
});

Deno.test(
  "list: a bad Cert Atlas file stops the stage and names the exam",
  early(async () => {
    const cases: [string, Uint8Array | Promise<Uint8Array>, string[]][] = [
      ["not json", gz("{"), ["certatlas/exams.json.gz", "expected JSON"]],
      [
        "domains not an array",
        gz(JSON.stringify([exam({ domains: "none" })])),
        ["exam x1 domains", "expected an array", '"none"'],
      ],
      [
        "objective title not a string",
        gz(JSON.stringify([exam({}, { title: 7, sub: [] })])),
        ["exam x1 domains[0] objectives[0] title", "non-empty string"],
      ],
      [
        "sub not strings",
        gz(JSON.stringify([exam({}, { title: "T one", sub: [3] })])),
        ["objectives[0] sub[0]", "non-empty string"],
      ],
      [
        "question prefix only",
        gz(JSON.stringify([exam({}, { title: "What is ?", sub: [] })])),
        ["X1 / D", "words after the question prefix", '"What is ?"'],
      ],
    ];
    await Promise.all(cases.map(async ([name, bytes, wants]) => {
      const r = await listWithData("certatlas", {
        "exams.json.gz": await bytes,
      });
      assert(r.code !== 0, `${name}: exit 0`);
      for (const w of wants) {
        assert(r.stderr.includes(w), `${name}: no "${w}" in ${r.stderr}`);
      }
      assert(!r.stderr.includes("TypeError"), `${name}: ${r.stderr}`);
    }));
  }),
);

Deno.test(
  "list: a null Learning Commons line or a comma in a tag stops the stage with the file and line",
  early(async () => {
    const [nul, comma] = await Promise.all([
      listWithData("learningcommons", {
        "graph.jsonl.gz": await gz(
          '{"k":"attributions","statements":["x"]}\nnull\n',
        ),
      }),
      listWithData("learningcommons", {
        "graph.jsonl.gz": await lcExtract([
          lcItem("n1", "Add fractions with like denominators", "3.NF.A,1"),
        ]),
      }),
    ]);
    assert(nul.code !== 0, "null line: exit 0");
    assert(
      nul.stderr.includes("graph.jsonl.gz:2: expected a JSON object") &&
        !nul.stderr.includes("Cannot read properties"),
      nul.stderr,
    );
    assert(comma.code !== 0, "comma tag: exit 0");
    assert(
      comma.stderr.includes(
        'expected tags without a comma, received "code:3.NF.A,1"',
      ),
      comma.stderr,
    );
  }),
);

// Straße and Strasse differ as titles but fold to one 80-char slug.
const LONG =
  "Explain careful classroom experiments compare observed predicted results";

Deno.test(
  "list: OpenSALT blocks split words, non-Latin titles fold or drop, a script stops the stage",
  early(async () => {
    const [ok, bad] = await Promise.all([
      listOpensalt([
        {
          fullStatement:
            "<p>Add fractions</p><p>with unlike denominators correctly</p>",
        },
        { fullStatement: "Spell Straße correctly in writing" },
        { fullStatement: "Spell Søren correctly in writing" },
        { fullStatement: "Spell Łódź correctly in writing" },
        { fullStatement: "Spell Iğdır ılık correctly in writing" },
        { fullStatement: "日本語の 標準を学ぶ ことができる" },
        { fullStatement: "日本語の 別の標準を学ぶ ことができる" },
        { fullStatement: `${LONG} Straße` },
        { fullStatement: `${LONG} Strasse` },
      ]),
      listOpensalt([{
        identifier: "x1",
        fullStatement: "Solve <script>alert(1)</script>equations well",
      }]),
    ]);
    assertEquals(ok.code, 0, ok.stderr);
    assert(
      ok.titles.includes("Add fractions with unlike denominators correctly"),
      `blocks glued: ${JSON.stringify(ok.titles)}`,
    );
    for (const w of ["strasse", "soren", "lodz", "igdir-ilik"]) {
      assert(
        ok.ids.includes(`spell-${w}-correctly-in-writing`),
        `no id for ${w}`,
      );
    }
    assert(
      /dropped 2 titles with an empty key/.test(ok.stdout),
      `no drop count in stdout: ${ok.stdout.slice(-400)}`,
    );
    const long = ok.ids.filter((_, i) => ok.titles[i].startsWith(LONG));
    assertEquals(long.length, 2, `long ids: ${JSON.stringify(long)}`);
    assertEquals(new Set(long).size, 2, `long ids collide: ${long}`);
    for (const id of long) {
      assert(
        id.length <= 80 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id),
        `bad long id (expected at most 80 chars, a slug): ${id}`,
      );
    }
    assertEquals(bad.code, 1);
    assert(
      /a\.json item x1: expected statement markup, received a <script> element/
        .test(bad.stderr),
      bad.stderr.slice(-400),
    );
  }),
);

Deno.test(
  "difficulty: a seed prereq in a high topic still lands below its dependent",
  early(async () => {
    const S: [string, number, string, string][] = [
      ["khan-low", 0, "", ""],
      ["khan-high", 1, "", ""],
      ["h1", 2, "grade:12", "hi"],
      ["h2", 3, "grade:12", "hi"],
      ["h3", 4, "grade:12", "hi"],
      ["l1", 5, "grade:K", "lo"],
      ["l2", 6, "grade:K", "lo"],
      ["l3", 7, "grade:K", "lo"],
      ["p", 2, "", "hi"],
      ["d", 2, "", "lo"],
      ["do-the-budget", 2, "", ""],
    ];
    const emb = new Float32Array(S.length * 768);
    S.forEach((s, i) => emb[i * 768 + s[1]] = 1);
    const { code, stderr, files } = await runIn("difficulty", {
      ...difficultyBuild(),
      "build/3b_tagged_deduped.tsv": [
        "id\ttitle\tdescription\tsources\ttags\toccupations\ttopics",
        ...S.map(([id, , tags, top]) =>
          [
            id,
            id === "do-the-budget" ? "Do the budget." : id.replace(/-/g, " "),
            "",
            "opensalt",
            tags,
            "",
            top,
          ].join("\t")
        ),
      ].join("\n") + "\n",
      "build/2_ids.tsv": S.map((s) => s[0]).join("\n") + "\n",
      "build/2_embeddings.bin": new Uint8Array(emb.buffer),
      "build/1e_seed_edges.tsv": seedHeader + "p\td\tkhan\t1.00\t0\t0\n",
    }, ["build/4_difficulty.tsv"]);
    assertEquals(code, 0, stderr);
    const band = difficultyCol(files, 1);
    assert(
      band.get("p")! < band.get("d")!,
      `p band ${band.get("p")} is not below d band ${band.get("d")}`,
    );
  }),
);

Deno.test(
  "difficulty: a seed never raises a grade-anchored dependent",
  early(async () => {
    // Shared embeddings make kNN smoothing pull grade-low and grade-high together.
    const same = (pairs: string[][]) => {
      const build = withSeeds(pairs);
      const n = (build["build/2_ids.tsv"] as string).trim().split("\n").length;
      const emb = new Float32Array(768 * n);
      for (let i = 0; i < n; i++) emb[i * 768 + (i === 1 ? 0 : i)] = 1;
      build["build/2_embeddings.bin"] = new Uint8Array(emb.buffer);
      return build;
    };
    const outs = ["build/4_difficulty.tsv"];
    const [seeded, none] = await Promise.all([
      runIn("difficulty", same([["grade-low", "grade-high"]]), outs),
      runIn("difficulty", same([]), outs),
    ]);
    assertEquals(seeded.code, 0, seeded.stderr);
    for (const col of [1, 2]) {
      assertEquals(
        difficultyCol(seeded.files, col).get("grade-high"),
        difficultyCol(none.files, col).get("grade-high"),
      );
    }
  }),
);

Deno.test(
  "trees: a dump with no slugs stops the stage",
  early(async () => {
    const dir = Deno.makeTempDirSync();
    Deno.mkdirSync(`${dir}/data/lcsh`, { recursive: true });
    Deno.mkdirSync(`${dir}/build`);
    Deno.writeFileSync(
      `${dir}/data/lcsh/subjects.skosrdf.nt.gz`,
      await gzip(
        '<http://id.loc.gov/authorities/subjects/sh1> <http://www.w3.org/2004/02/skos/core#prefLabel> "Algebra"@en .\n' +
          "<http://id.loc.gov/authorities/subjects/sh1> <http://www.w3.org/2004/02/skos/core#broader> <http://id.loc.gov/authorities/subjects/sh2> .\n",
      ),
    );
    const out = await run(["trees"], dir, 10_000);
    Deno.removeSync(dir, { recursive: true });
    const stderr = new TextDecoder().decode(out.stderr);
    const expected =
      "gunzip -c data/lcsh/subjects.skosrdf.nt.gz: expected at least 1 slug with an ancestor, received 0";
    assert(out.code !== 0 && stderr.includes(expected), stderr);
  }),
);

const list = await listP;
if (!list.success) {
  throw new Error(
    `pipeline.ts list exited ${list.code} after ${
      ((performance.now() - t0) / 1000).toFixed(1)
    } s (bound ${LIST_BOUND_MS / 1000} s):\n${
      new TextDecoder().decode(list.stderr).slice(-2000)
    }`,
  );
}
const [header, ...rows] = Deno.readTextFileSync(`${LIST}/build/1_skills.tsv`)
  .split(
    "\n",
  )
  .filter((l) => l.length).map((l) => l.split("\t"));

Deno.test("expertScores: precision counts annotated edges only, recall follows the closure", () => {
  const graph = new Map([
    ["a", []],
    ["b", ["a"]],
    ["c", ["b"]],
    ["z", ["a"]],
    ["q", ["b"]], // an edge with no annotation
  ]);
  const pair = (pre: string, dep: string, positive: boolean) => ({
    pre,
    dep,
    positive,
  });
  const r = expertScores(graph, [
    pair("a", "b", false), // a repeat: the positive one wins
    pair("a", "b", true), // edge, hit
    pair("a", "c", true), // two edges apart: recall only
    pair("b", "c", true), // edge, hit
    pair("a", "z", false), // edge, miss
    pair("c", "a", true), // reversed: recall miss
    pair("a", "a", true), // self pair: skipped
  ]);
  assertEquals(r, { positives: 4, predicted: 3, hits: 2, recovered: 3 });
});

Deno.test(
  "status: expert pairs the graph misses score 0 on precision and recall",
  early(async () => {
    const build = {
      ...goodBuild(),
      ...lbFixture(["2,1,1", "3,2,1", "3,1,1", "1,2,0"]),
      // Reversed: Exercise_B is the dependent here, so no edge matches.
      ...junyiFixture([
        "counting,addition_1,7",
        "addition_1,calculus,6",
        "counting,multiplication,8",
        "addition_1,counting,2",
      ]),
    };
    const { code, score } = await runIn("status", build);
    assertEquals(code, 1);
    for (
      const name of [
        "Expert prereq edges have precision above the floor.",
        "Expert prereq pairs have recall above the floor.",
        "Junyi crowd prereq edges have precision above the floor.",
        "Junyi crowd prereq pairs have recall above the floor.",
      ]
    ) assertEquals(score(name), 0, name);
    assertEquals(
      score("Enough expert prereq pairs resolve to skills to grade them."),
      1,
    );
  }),
);

Deno.test(
  "status: a missing LectureBank clone or Junyi file scores 0 and names the fix",
  early(async () => {
    const build = goodBuild();
    for (const k of Object.keys({ ...lbFixture(), ...junyiFixture() })) {
      delete build[k];
    }
    const { code, score, stderr } = await runIn("status", build);
    assertEquals(code, 1);
    for (const who of ["expert", "junyi crowd"]) {
      assertEquals(
        score(`Enough ${who} prereq pairs resolve to skills to grade them.`),
        0,
        who,
      );
    }
    assert(stderr.includes("Run: deno run -A data/download.ts"), stderr);
    assert(stderr.includes("open dataset 1198"), stderr);
  }),
);

Deno.test("resumableClaude: a cached target sends nothing; an uncached one needs the key", async () => {
  const { resumableClaude } = await import("./lib.ts");
  const dir = Deno.makeTempDirSync();
  const cache = `${dir}/c.tsv`;
  Deno.writeTextFileSync(cache, "a\tanswer\n");
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  Deno.env.delete("ANTHROPIC_API_KEY");
  try {
    await resumableClaude("t", cache, [{ id: "a" }], (t) => t.id);
    assertEquals(Deno.readTextFileSync(cache), "a\tanswer\n");
    const err = await resumableClaude("t", cache, [{ id: "a" }, { id: "b" }], (
      t,
    ) => t.id).then(() => undefined, (e: Error) => e.message);
    assert(err?.includes("expected ANTHROPIC_API_KEY"), err);
  } finally {
    if (key) Deno.env.set("ANTHROPIC_API_KEY", key);
  }
});

// Calculus grows down to a grade-1 standard and a primitive. "Times tables"
// snaps to multiplication, "Multiplying" snaps to its own skill, and
// "Calculus" under multiplication closes a cycle. The caches hold every
// answer, so the run pays for nothing.
const pilotP = early(() =>
  runIn("pilot", {
    ...lbFixture(),
    "skills.tsv": goodBuild()["skills.tsv"],
    "build/3b_tagged_deduped.tsv": [
      "id\ttitle\tdescription\tsources\ttags\toccupations\ttopics",
      "counting\tCounting\t\tfoundation\tgrade:K\t\t",
      "addition\tAddition\t\tfoundation\tgrade:K,grade:01\t\t",
      "multiplication\tMultiplication\t\tfoundation\tgrade:3\t\t",
      "calculus\tCalculus\t\tfoundation\tgrade:12\t\t",
    ].join("\n") + "\n",
    "data/_pilot_roots.tsv":
      "kind\tid\ttitle\tdescription\nsanity\tcalculus\tCalculus\t\n",
    "data/_sanity.tsv":
      "id\tsubject\tgrade_from\tgrade_to\twhy\ncalculus\tmath\t12\t12\tx\n",
    "build/pilot_expand.tsv":
      "calculus\tmultiplication; Limits; Times tables\nmultiplication\taddition; Calculus; Multiplying\nlimits\tnone\n",
    "build/pilot_snap.tsv":
      "limits\tnone\ntimes-tables\tmultiplication\nmultiplying\tmultiplication\n",
  }, ["build/pilot_stats.json"])
);
Deno.test("pilot: grows from the roots, snaps, stops at grade 1, and rejects a cycle", async () => {
  const out = await pilotP();
  assertEquals(out.code, 0, out.stderr);
  const counts = { positives: 1, predicted: 0, hits: 0, recovered: 1 };
  const scores = {
    ...counts,
    precision: null,
    recall: 1,
    negatives: 0,
    negatives_in_closure: 0,
  };
  assertEquals(JSON.parse(out.files["build/pilot_stats.json"]), {
    open_at_cap: 0,
    nodes: 4,
    roots: 1,
    snapped_nodes: 2,
    new_nodes: 1,
    new_share: 1 / 3,
    prereq_mentions: { exact: 3, snapped: 2, new: 1 },
    leaves: { k_standard: 1, primitive: 1, cut_by_cycles: 0 },
    rejected_cycles: 1,
    self_snaps: 1,
    per_root: {
      calculus: {
        height_max: 2,
        height_min: 1,
        nodes_below: 3,
        reaches_k_standard: true,
        longest_chain: "Calculus → Multiplication → Addition",
      },
    },
    expert: { reached_pairs: 1, pilot: scores, skills_tsv: scores },
    band_inversions: { pairs: 2, inverted: 0, worst: [] },
    sanity: [{ id: "calculus", grades: "12-12", height_max: 2, band: 15 }],
  });
});

Deno.test("digcompSeedEdges: each level of a competence is a prereq of the next; a level tag alone throws", async () => {
  const { digcompSeedEdges } = await import("./sources.ts");
  const t = (comp: string, level: string) =>
    `digcomp:outcome,digcomp:competence:${comp},digcomp:level:${level}`;
  const edges = digcompSeedEdges([
    { id: "a1", tags: t("search", "basic") },
    { id: "a2", tags: t("search", "basic") },
    { id: "b1", tags: t("search", "intermediate") },
    { id: "c1", tags: t("search", "highly-advanced") },
    { id: "x1", tags: t("privacy", "basic") },
    { id: "x2", tags: t("privacy", "intermediate") },
    // A merge at two levels sits at the lower one.
    { id: "x3", tags: `${t("privacy", "advanced")},digcomp:level:basic` },
    { id: "plain", tags: "grade:3" },
  ]);
  // No advanced outcome of "search": intermediate and highly advanced stay
  // apart, as DigComp orders only adjacent levels.
  assertEquals(edges.map((e) => `${e.src}>${e.dst}`), [
    "a1>b1",
    "a2>b1",
    "x1>x2",
    "x3>x2",
  ]);
  let msg = "";
  try {
    digcompSeedEdges([{ id: "y", tags: "digcomp:level:basic" }]);
  } catch (e) {
    msg = (e as Error).message;
  }
  assert(msg.includes("digcomp:competence:*"), msg);
});
