import { assert, assertEquals, assertGreater } from "@std/assert";

// Stage list runs in seconds without Ollama. The other stages need Ollama or
// minutes, so they answer to `deno task status`.
const PIPELINE = new URL("./pipeline.ts", import.meta.url).pathname;
const CONFIG = new URL("./deno.json", import.meta.url).pathname;
const run = (args: string[], cwd: string, boundMs: number) =>
  new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, PIPELINE, ...args],
    cwd,
    signal: AbortSignal.timeout(boundMs),
    stdout: "piped",
    stderr: "piped",
  }).output();

const LIST_BOUND_MS = 30_000;
const t0 = performance.now();
const list = await run(["list"], ".", LIST_BOUND_MS);
if (!list.success) {
  throw new Error(
    `pipeline.ts list exited ${list.code} after ${
      ((performance.now() - t0) / 1000).toFixed(1)
    } s (bound ${LIST_BOUND_MS / 1000} s):\n${
      new TextDecoder().decode(list.stderr).slice(-2000)
    }`,
  );
}
const [header, ...rows] = Deno.readTextFileSync("build/1_skills.tsv").split(
  "\n",
)
  .filter((l) => l.length).map((l) => l.split("\t"));

Deno.test("list: every row has 5 fields, a slug id, a title, and sources; ids are unique", () => {
  assertEquals(header, ["id", "title", "description", "sources", "tags"]);
  assertGreater(rows.length, 20000, "too few rows");
  for (const [i, c] of rows.entries()) {
    assertEquals(c.length, 5, `row ${i + 2} has ${c.length} fields`);
    assert(/^[a-z0-9-]+$/.test(c[0]), `row ${i + 2} bad slug: ${c[0]}`);
    assert(c[1] && c[3], `row ${i + 2} lacks a title or sources`);
  }
  assertEquals(
    new Set(rows.map((c) => c[0])).size,
    rows.length,
    "duplicate ids",
  );
});

Deno.test("list stats: all four sources contribute, and dedupe merged rows", () => {
  const s = JSON.parse(Deno.readTextFileSync("build/1_stats.json"));
  for (const src of ["esco", "onet", "lightcast", "opensalt"]) {
    assertGreater(s.per_source[src], 0, `${src} has 0 rows`);
  }
  assertGreater(s.dedupe_collisions, 0, "no dedupe collisions");
});

// REG-EC1, REG-EC2, REG-R5: metadata, question, and scaffolding prefixes.
Deno.test("list: no title starts with a metadata, question, or scaffolding prefix", () => {
  // First letter only is case-insensitive, so acronyms like "CAN Bus" pass.
  const prefix =
    /^((Unit|Lesson|Chapter|Benchmark|Standard)\s+[\d.]+|([Cc]an|[Cc]ould|[Ss]hould|[Hh]ow to|[Ww]hat is|[Ww]hy does)\s|[Ww]ith\s+(prompting|guidance|support))/;
  const bad = rows.map((c) => c[1]).filter((t) => prefix.test(t));
  assertEquals(bad.slice(0, 5), [], `${bad.length} titles with a prefix`);
});

// REG-TG2: deriveDisplay falls back to code:* tags, so a short one becomes a display title.
Deno.test("list: every code:* tag has at least 4 chars", () => {
  const bad = rows.flatMap((c) => c[4].split(",")).filter((t) =>
    t.startsWith("code:") && t.length < "code:".length + 4
  );
  assertEquals(bad.slice(0, 5), [], `${bad.length} short code:* tags`);
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
      "id\ttitle\tdescription\tsources\ttags\naddition\tAddition\t\topensalt\tgrade:1\n",
    "build/1e_seed_edges.tsv":
      "src_id\tdst_id\tsource\tconfidence\tholdout\tfallback\ncounting\taddition\tkhan\t1.00\t0\t0\n",
    "build/2_ids.tsv": skills.map(([id]) => id).join("\n") + "\n",
    "build/2_embeddings.bin": new Uint8Array(emb.buffer),
    "build/3b_aliases.tsv": "dropped_id\tcanonical_id\n",
    "build/4_difficulty.tsv": [
      "id\tdifficulty\tdifficulty_raw",
      ...skills.map(([id, band]) => `${id}\t${band}\t${band}`),
    ].join("\n") + "\n",
    "build/4_stats.json": JSON.stringify({
      kendall_tau_vs_anchor: 0.8,
      grade_anchored_skills: 10,
      grade_band_inversions: 0,
    }),
    "build/5_prereqs.tsv":
      "addition\tcounting\nmultiplication\taddition\nbiology\tnone\n",
    "build/1f_translate.tsv":
      "函数\tfunction\n欧拉函数\tEuler's totient function\n",
    "data/mooccubex/cs.json.gz": MOOC_GZ,
    "data/mooccubex/math.json.gz": MOOC_GZ,
    "data/mooccubex/psy.json.gz": MOOC_GZ,
  };
};

const runIn = async (stage: string, fixture: Fixture) => {
  const dir = Deno.makeTempDirSync();
  for (const [path, body] of Object.entries(fixture)) {
    const parent = path.slice(0, path.lastIndexOf("/") + 1);
    Deno.mkdirSync(`${dir}/${parent}`, { recursive: true });
    if (typeof body === "string") {
      Deno.writeTextFileSync(`${dir}/${path}`, body);
    } else Deno.writeFileSync(`${dir}/${path}`, body);
  }
  const out = await run([stage], dir, 10_000);
  const skills = Deno.readTextFileSync(`${dir}/skills.tsv`);
  Deno.removeSync(dir, { recursive: true });
  const stderr = new TextDecoder().decode(out.stderr);
  const stdout = new TextDecoder().decode(out.stdout);
  const report = stdout.startsWith("{")
    ? JSON.parse(stdout) as Record<string, { "0": number }>
    : {};
  return {
    code: out.code,
    stderr,
    skills,
    score: (name: string) => report[name]?.["0"],
  };
};

Deno.test("status: a healthy build passes every condition and exits 0", async () => {
  const { code, stderr } = await runIn("status", goodBuild());
  assertEquals(code, 0, stderr);
});

Deno.test("status: graph defects score below 1 and exit 1", async () => {
  const build = goodBuild();
  build["skills.tsv"] += [
    ["german-i", 4, "counting"],
    ["french-i", 5, "german-i"],
    ["loop-a", 6, "loop-b"],
    ["loop-b", 6, "loop-a"],
    ["self", 6, "self,ghost"],
  ].map(([id, band, pre]) =>
    [id, id, id, "", band, pre, "", "", "", ""].join("\t")
  ).join("\n") + "\n";
  const { code, score, stderr } = await runIn("status", build);
  assertEquals(code, 1, stderr);
  // 11 edges: loop-a, loop-b, self, and ghost are bad.
  assertEquals(
    score("The prereq graph is a DAG, and every prereq names another skill."),
    1 - 4 / 11,
  );
  assertEquals(
    score("No language skill has another language as a prereq."),
    1 - 1 / 11,
  );
  assertEquals(score("Addition is a transitive prereq of multiplication."), 1);
});

Deno.test("status: a missing or still-Chinese translation scores below 1", async () => {
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
});

Deno.test("status: a missing build file scores 0 and names the stage to rerun", async () => {
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
});

Deno.test("status: a malformed build file crashes with the condition and the fix", async () => {
  for (
    const [path, body, expected] of [
      ["skills.tsv", "id\ttitle\n", "unexpected header"],
      [
        "build/4_difficulty.tsv",
        "id\tdifficulty\tdifficulty_raw\na\t1\tx\n",
        "finite difficulty_raw",
      ],
      ["build/5_prereqs.tsv", "addition\n", "skill<TAB>p1,p2"],
      [
        "data/mooccubex/cs.json.gz",
        await gzip("null\n"),
        "cs.json.gz:1: expected a JSON object",
      ],
    ] as const
  ) {
    const build = goodBuild();
    build[path] = body;
    if (path === "skills.tsv") delete build["build/4_difficulty.tsv"];
    const { code, stderr } = await runIn("status", build);
    assert(code !== 0 && stderr.includes(expected), `${path}: ${stderr}`);
    assert(stderr.includes('status "'), stderr);
  }
});

Deno.test("list: a malformed data/_foundations.json stops the stage", async () => {
  const good = JSON.parse(Deno.readTextFileSync("data/_foundations.json"));
  const cases: [string, (f: typeof good) => void, string][] = [
    ["grade", (f) => f.foundations[0].grade_start = 99, "grades as integers"],
    ["slug", (f) => f.foundations[0].id = "Counting", "the slug of the title"],
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
      (f) => f.seed_edges.push({ prereq: "addition", dependent_pattern: "(" }),
      "a valid regex",
    ],
  ];
  await Promise.all(cases.map(async ([name, mutate, expected]) => {
    const f = structuredClone(good);
    mutate(f);
    const dir = Deno.makeTempDirSync();
    Deno.mkdirSync(`${dir}/data`);
    Deno.writeTextFileSync(`${dir}/data/_foundations.json`, JSON.stringify(f));
    const out = await run(["list"], dir, 10_000);
    Deno.removeSync(dir, { recursive: true });
    const stderr = new TextDecoder().decode(out.stderr);
    assert(out.code !== 0 && stderr.includes(expected), `${name}: ${stderr}`);
  }));
});

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
      "id\tdifficulty\tdifficulty_raw",
      ...ids.map((id, i) => `${id}\t${i + 1}\t${i + 1}`),
    ].join("\n") + "\n",
    "build/3b_aliases.tsv": "dropped_id\tcanonical_id\n",
    "build/6_edges.tsv":
      "skill_id\tprereq_id\naddition\tcounting\nmultiplication\taddition\n",
    "build/1j_lcsh_tree.tsv": "counting\tarithmetic\n",
    "build/1k_dbpedia_tree.tsv": "addition\tarithmetic\n",
  };
};

// Each of these wrote a skills.tsv that breaks its own invariants, exit 0.
Deno.test("finalize: writes a DAG of unique skills, or stops", async () => {
  const good = await runIn("finalize", finalBuild());
  assertEquals(good.code, 0, good.stderr);
  assertEquals(good.skills.split("\n")[2].split("\t")[5], "counting");
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
      'expected unique ids, received a second "counting"',
    ],
    [
      "build/4_difficulty.tsv",
      "counting\t1\t1\n",
      'expected unique ids, received a second "counting"',
    ],
  ];
  for (const [path, extra, expected] of cases) {
    const build = finalBuild();
    build[path] += extra;
    const { code, stderr } = await runIn("finalize", build);
    assert(code !== 0 && stderr.includes(expected), `${expected}: ${stderr}`);
  }
  const empty = finalBuild();
  empty["build/3b_tagged_deduped.tsv"] =
    "id\ttitle\tdescription\tsources\ttags\toccupations\ttopics\n";
  const { code, stderr } = await runIn("finalize", empty);
  assert(code !== 0 && stderr.includes("expected at least one row"), stderr);
});

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
Deno.test("a bad input file or stage name stops the run and names the cause", async () => {
  const esco = Deno.readTextFileSync("data/esco/skills_en.csv");
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
});

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

// UTF-8 read as Windows-1252: a lead byte (Â, Ã, â) followed by a char from the
// 0x80–0xBF continuation range as cp1252 shows it. A lone Â is a mangled
// no-break space after the pipeline collapses whitespace.
Deno.test("list: no field holds double-encoded UTF-8", () => {
  const mojibake = /[ÂÃâ][\u0080-¿ŒœŠšŸŽžƒˆ˜–-›€™]|Â(\s|$)/;
  const bad = rows.filter((c) => c.some((f) => mojibake.test(f)));
  assertEquals(bad.slice(0, 3).map((c) => c[0]), [], `${bad.length} rows`);
});
