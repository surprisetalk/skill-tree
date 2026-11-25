// Experiment: decompose an expert skill into prerequisites, down to
// kindergarten, with Sonnet. `gen <start> <run>` writes one run; `cmp`
// compares all runs.
//   deno run -A decompose/decompose.ts gen 0 1
import Anthropic from "@anthropic-ai/sdk";

const DIR = new URL("./runs/", import.meta.url).pathname;
const MODEL = "claude-sonnet-5-5";
// Grade 0 is kindergarten, 1–12 school, 13–16 vocational or university years.
const STARTS: [string, number][] = [
  ["Collect a blood culture sample from a patient by venipuncture", 13],
  ["Perform a boundary survey of a land parcel and compute its area", 16],
  ["Prepare and present a pitch to raise equity for a business", 15],
];
const MAX_NODES = 1000;
const SCHEMA = {
  type: "object",
  properties: {
    prereqs: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, grade: { type: "integer" } },
        required: ["title", "grade"],
        additionalProperties: false,
      },
    },
  },
  required: ["prereqs"],
  additionalProperties: false,
};
const prompt = (title: string, grade: number, known: string[]) =>
  `A skill is one thing an assessor can test with a pass/fail task.
Grades: 0 is kindergarten, 1 to 12 are school grades, 13 to 16 are years of vocational or university training.

Skill: ${title} (grade ${grade})

List the direct prerequisites of this skill: the 1 to 4 skills a learner must pass immediately before they can learn this one.
- Each prerequisite is one testable skill, written as a task that starts with a verb.
- Each prerequisite has a grade below ${grade}: the grade at which a typical learner first passes it.
- Direct only. Do not list a skill that is a prerequisite of another skill in your list.
- When a known skill below means the same thing, copy its title and grade exactly.

Known skills:
${known.join("\n") || "(none)"}`;

const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function gen(start: number, run: number) {
  const client = new Anthropic({ timeout: 120_000, maxRetries: 1 });
  const [rootTitle, rootGrade] = STARTS[start];
  const nodes = new Map<string, { title: string; grade: number }>();
  nodes.set(key(rootTitle), { title: rootTitle, grade: rootGrade });
  const edges: string[] = [];
  const expanded = new Set<string>();
  let tin = 0, tout = 0, calls = 0, badGrade = 0;
  for (let g = rootGrade; g > 0; g--) {
    // Nodes of grade g are final here: each child has a lower grade.
    const todo = [...nodes].filter(([k, n]) =>
      n.grade === g && !expanded.has(k)
    );
    const known = [...nodes.values()].filter((n) => n.grade < g)
      .sort((a, b) => b.grade - a.grade).map((n) =>
        `${n.title} (grade ${n.grade})`
      );
    let next = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next < todo.length) {
        const [k, n] = todo[next++];
        expanded.add(k);
        const r = await client.messages.create({
          model: MODEL,
          max_tokens: 500,
          // Sonnet 5.5 refuses "disabled"; the API names this value for no thinking.
          // deno-lint-ignore no-explicit-any
          thinking: { type: "between_tools" } as any,
          output_config: { format: { type: "json_schema", schema: SCHEMA } },
          messages: [{
            role: "user",
            content: prompt(n.title, n.grade, known),
          }],
        });
        calls++;
        tin += r.usage.input_tokens;
        tout += r.usage.output_tokens;
        const block = r.content.find((b) => b.type === "text");
        if (!block || block.type !== "text") {
          throw new Error(`no text for "${n.title}": ${r.stop_reason}`);
        }
        const { prereqs } = JSON.parse(block.text) as {
          prereqs: { title: string; grade: number }[];
        };
        for (const p of prereqs) {
          const pk = key(p.title);
          const have = nodes.get(pk);
          const grade = have ? have.grade : p.grade;
          if (!(grade >= 0 && grade < n.grade)) {
            badGrade++;
            continue;
          }
          if (!have) nodes.set(pk, { title: p.title, grade });
          edges.push(
            `${n.title}\t${n.grade}\t${nodes.get(pk)!.title}\t${grade}`,
          );
        }
        if (nodes.size > MAX_NODES) {
          throw new Error(
            `run ${start}-${run}: ${nodes.size} nodes exceed ${MAX_NODES} at grade ${g}`,
          );
        }
      }
    }));
    console.error(`grade ${g}: expanded ${todo.length}, nodes ${nodes.size}`);
  }
  Deno.mkdirSync(DIR, { recursive: true });
  Deno.writeTextFileSync(
    `${DIR}${start}-${run}.tsv`,
    [...new Set(edges)].join("\n") + "\n",
  );
  console.log(
    `run ${start}-${run}: nodes=${nodes.size} edges=${
      new Set(edges).size
    } calls=${calls} in=${tin} out=${tout} badGrade=${badGrade}`,
  );
}

async function embed(text: string): Promise<number[]> {
  const r = await fetch("http://localhost:11434/api/embeddings", {
    method: "POST",
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`ollama embeddings: ${r.status}`);
  const v: number[] = (await r.json()).embedding;
  const len = Math.hypot(...v);
  return v.map((x) => x / len);
}

async function cmp() {
  type Run = {
    name: string;
    start: string;
    nodes: Map<string, number>;
    edges: [string, string][];
  };
  const runs: Run[] = [];
  for (
    const f of [...Deno.readDirSync(DIR)].map((e) => e.name).filter((n) =>
      n.endsWith(".tsv")
    ).sort()
  ) {
    const nodes = new Map<string, number>(), edges: [string, string][] = [];
    for (const line of Deno.readTextFileSync(DIR + f).trim().split("\n")) {
      const [p, pg, c, cg] = line.split("\t");
      nodes.set(p, +pg).set(c, +cg);
      edges.push([p, c]);
    }
    runs.push({ name: f.replace(".tsv", ""), start: f[0], nodes, edges });
  }
  const vec = new Map<string, number[]>();
  for (const r of runs) {
    for (const t of r.nodes.keys()) {
      if (!vec.has(t)) vec.set(t, await embed(t));
    }
  }
  const cos = (a: string, b: string) =>
    vec.get(a)!.reduce((s, x, i) => s + x * vec.get(b)![i], 0);
  const BANDS: [string, number, number][] = [
    ["K-2", 0, 2],
    ["3-5", 3, 5],
    ["6-8", 6, 8],
    ["9-12", 9, 12],
    ["13+", 13, 16],
  ];

  console.log(
    "run\tnodes\tedges\tdepth\tK-2\t3-5\t6-8\t9-12\t13+\tdead-ends\tmean-span",
  );
  for (const r of runs) {
    const kids = new Map<string, string[]>();
    for (const [p, c] of r.edges) kids.set(p, [...(kids.get(p) ?? []), c]);
    const memo = new Map<string, number>();
    const depth = (t: string): number =>
      memo.get(t) ??
        (memo.set(t, 1 + Math.max(0, ...(kids.get(t) ?? []).map(depth))),
          memo.get(t)!);
    const root = [...r.nodes.keys()][0];
    const band = BANDS.map(([, lo, hi]) =>
      [...r.nodes.values()].filter((g) => g >= lo && g <= hi).length
    );
    const dead = [...r.nodes].filter(([t, g]) => g > 0 && !kids.has(t)).length;
    const span = r.edges.reduce((s, [p, c]) =>
      s + r.nodes.get(p)! - r.nodes.get(c)!, 0) / r.edges.length;
    console.log(
      [
        r.name,
        r.nodes.size,
        r.edges.length,
        depth(root),
        ...band,
        dead,
        span.toFixed(1),
      ].join("\t"),
    );
  }

  // Share of A's nodes with a node in B at cosine >= T, per grade band of A.
  const T = 0.85;
  const share = (a: Run, b: Run, lo: number, hi: number) => {
    const as = [...a.nodes].filter(([, g]) => g >= lo && g <= hi).map(([t]) =>
      t
    );
    const bs = [...b.nodes.keys()];
    return [as.filter((t) => bs.some((u) => cos(t, u) >= T)).length, as.length];
  };
  const exactEdges = (a: Run, b: Run) => {
    const eb = new Set(b.edges.map(([p, c]) => `${key(p)}>${key(c)}`));
    return a.edges.filter(([p, c]) => eb.has(`${key(p)}>${key(c)}`)).length /
      a.edges.length;
  };
  for (const same of [true, false]) {
    const sums = BANDS.map(() => [0, 0]);
    let exact = 0, edge = 0, pairs = 0;
    for (const a of runs) {
      for (const b of runs) {
        if (a === b || (a.start === b.start) !== same) continue;
        BANDS.forEach(([, lo, hi], i) => {
          const [m, n] = share(a, b, lo, hi);
          sums[i][0] += m;
          sums[i][1] += n;
        });
        const kb = new Set([...b.nodes.keys()].map(key));
        exact += [...a.nodes.keys()].filter((t) => kb.has(key(t))).length /
          a.nodes.size;
        edge += exactEdges(a, b);
        pairs++;
      }
    }
    console.log(
      `\n${
        same ? "same start" : "different start"
      } (${pairs} ordered pairs): share of nodes with a match at cosine >= ${T}`,
    );
    console.log(
      BANDS.map(([n], i) => `${n}: ${(sums[i][0] / sums[i][1]).toFixed(2)}`)
        .join("  "),
    );
    console.log(
      `exact title share: ${(exact / pairs).toFixed(2)}  exact edge share: ${
        (edge / pairs).toFixed(2)
      }`,
    );
  }

  // Sample near-threshold pairs, to judge whether T means "same skill".
  const [a, b] = [runs[0], runs[1]];
  const near: [number, string, string][] = [];
  for (const t of a.nodes.keys()) {
    for (const u of b.nodes.keys()) {
      const c = cos(t, u);
      if (c >= T - 0.05 && c < T + 0.05 && key(t) !== key(u)) {
        near.push([c, t, u]);
      }
    }
  }
  console.log(`\nnear-threshold pairs, ${a.name} vs ${b.name}:`);
  for (
    const [c, t, u] of near.sort((x, y) => x[0] - y[0]).filter((_, i) =>
      i % Math.ceil(near.length / 16) === 0
    )
  ) {
    console.log(`${c.toFixed(2)}\t${t}\t|\t${u}`);
  }
}

const [mode, s, r] = Deno.args;
if (mode === "gen") await gen(+s, +r);
else if (mode === "cmp") await cmp();
else {throw new Error(
    `expected "gen <start> <run>" or "cmp", received "${Deno.args.join(" ")}"`,
  );}
