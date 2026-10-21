import { assert, assertEquals, assertGreater } from "@std/assert";

// Stage list is the only stage that runs without Ollama. The other stages
// answer to `deno task status`.
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

Deno.test("status: scores a fixture build and exits 1 on a failing condition", async () => {
  const dir = await Deno.makeTempDir();
  const skills: [string, number, string][] = [
    ["addition", 1, ""],
    ["multiplication", 3, "addition"],
    ["german-i", 4, ""],
    ["french-i", 5, "german-i"],
    ["loop-a", 6, "loop-b"],
    ["loop-b", 6, "loop-a"],
  ];
  Deno.writeTextFileSync(
    `${dir}/skills.tsv`,
    [
      "id\ttitle\tdisplay_title\tdescription\tdifficulty\tprereqs\toccupations\ttopics\tgrade_start\tgrade_end",
      ...skills.map(([id, band, pre]) =>
        [id, id, id, "", band, pre, "", "", "", ""].join("\t")
      ),
    ].join("\n") + "\n",
  );
  const out = await run(["status"], dir, 10_000);
  Deno.removeSync(dir, { recursive: true });
  assertEquals(out.code, 1, new TextDecoder().decode(out.stderr));
  const report = JSON.parse(new TextDecoder().decode(out.stdout));
  const score = (name: string) => report[name]["0"];
  assertEquals(score("Addition is a transitive prereq of multiplication."), 1);
  assertEquals(
    score("The prereq graph is a DAG, and every prereq names another skill."),
    0.5,
  );
  assertEquals(
    score("No language skill has another language as a prereq."),
    0.75,
  );
  assertEquals(score("At least 80% of seed edges survive into skills.tsv."), 0);
});
