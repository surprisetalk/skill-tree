import { TextLineStream } from "@std/streams/text-line-stream";

const DATA = new URL(".", import.meta.url).pathname;

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function run(cmd: string[], cwd?: string) {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await p.output();
  if (code !== 0) {
    throw new Error(`command failed (exit ${code}): ${cmd.join(" ")}`);
  }
}

async function get(url: string, dest: string) {
  if (await exists(dest)) {
    console.log(`  skip: ${dest} exists`);
    return;
  }
  console.log(`  GET ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${url}`);
  const f = await Deno.open(dest, { write: true, create: true });
  await r.body!.pipeTo(f.writable);
}

async function mkdir(path: string) {
  await Deno.mkdir(path, { recursive: true });
}

// Learning Commons knowledge graph, CC BY 4.0. The raw export is 986 MB, so the
// step streams it and keeps a filtered, gzipped extract that git tracks.
// REVIEW: Track an extract of only the rows stage list reads. Alternative: keep
// the raw jsonl (986 MB, gitignored) and read it in stage list. It makes the
// test fail on a fresh clone and costs a 986 MB download before every test run.
const LC_VERSION = "v1.16.0";
const LC_URL =
  `https://cdn.learningcommons.org/knowledge-graph/${LC_VERSION}/exports`;
const LC_EXTRACT = DATA + "learningcommons/graph.jsonl.gz";
const LC_TIMEOUT_MS = 20 * 60_000;
// The export gives each relationship's ends as node identifiers.
const LC_EDGES = new Set(["buildsTowards", "hasStandardAlignment"]);

type Json = Record<string, unknown>;

async function* jsonLines(url: string): AsyncGenerator<Json> {
  const t0 = performance.now();
  const r = await fetch(url, { signal: AbortSignal.timeout(LC_TIMEOUT_MS) });
  if (!r.ok || !r.body) {
    throw new Error(
      `expected a 200 response with a body from ${url}, received ${r.status} ${r.statusText}. Check LC_VERSION against github.com/learning-commons-org/knowledge-graph.`,
    );
  }
  let n = 0;
  try {
    const lines = r.body.pipeThrough(new TextDecoderStream()).pipeThrough(
      new TextLineStream(),
    );
    for await (const line of lines) {
      n++;
      if (!line) continue;
      const o = JSON.parse(line);
      if (typeof o !== "object" || o === null || Array.isArray(o)) {
        throw new Error(
          `expected a JSON object, received ${line.slice(0, 80)}`,
        );
      }
      yield o as Json;
    }
  } catch (e) {
    throw new Error(
      `${url}:${n} after ${Math.round((performance.now() - t0) / 1000)} s: ${
        (e as Error).message
      }. Run the download again.`,
    );
  }
}

const lcStr = (o: Json, key: string, where: string): string => {
  const v = o[key];
  if (typeof v !== "string") {
    throw new Error(
      `${where}: expected "${key}" as a string, received ${
        JSON.stringify(v)
      }. The export schema changed: check LC_VERSION.`,
    );
  }
  return v;
};

const lcGrades = (props: Json, where: string): string[] => {
  const g = JSON.parse(lcStr(props, "gradeLevel", where));
  if (!Array.isArray(g) || !g.every((x) => typeof x === "string")) {
    throw new Error(
      `${where}: expected gradeLevel as a JSON array of strings, received ${
        JSON.stringify(g)
      }`,
    );
  }
  return g;
};

async function learningCommons() {
  if (await exists(LC_EXTRACT)) {
    console.log(`  skip: ${LC_EXTRACT} exists`);
    return;
  }
  const frameworkCurrent = new Map<string, boolean>();
  const items = new Map<string, Json>();
  const itemGrades = new Map<string, string[]>();
  const components = new Map<string, Json>();
  for await (const o of jsonLines(`${LC_URL}/nodes.jsonl`)) {
    const id = lcStr(o, "identifier", "nodes.jsonl");
    const where = `nodes.jsonl ${id}`;
    const props = o.properties as Json;
    const label = (o.labels as string[])[0];
    if (label === "StandardsFramework") {
      const cur = lcStr(props, "isCurrent", where);
      if (cur !== "true" && cur !== "false") {
        throw new Error(
          `${where}: expected isCurrent as "true" or "false", received "${cur}"`,
        );
      }
      frameworkCurrent.set(id, cur === "true");
    } else if (label === "StandardsFrameworkItem") {
      const grades = lcGrades(props, where);
      itemGrades.set(id, grades);
      // The export marks its own scaffolding (domains, clusters) as groupings.
      if (props.normalizedStatementType === "Standard Grouping") {
        items.set(id, { grouping: true });
        continue;
      }
      items.set(id, {
        k: "item",
        id,
        text: props.description ?? "",
        code: props.statementCode ?? "",
        type: props.statementType ?? "",
        grades,
        attribution: lcStr(props, "attributionStatement", where),
      });
    } else if (label === "LearningComponent") {
      components.set(id, {
        k: "component",
        id,
        text: lcStr(props, "description", where),
        attribution: lcStr(props, "attributionStatement", where),
      });
    }
  }
  console.log(
    `  nodes: ${frameworkCurrent.size} frameworks, ${items.size} items, ${components.size} components`,
  );

  const parent = new Map<string, string>();
  const supported = new Map<string, Set<string>>();
  const edges: [string, string, string][] = [];
  for await (const o of jsonLines(`${LC_URL}/relationships.jsonl`)) {
    const rel = lcStr(o, "label", "relationships.jsonl");
    const from = lcStr(o, "source_identifier", `relationships.jsonl ${rel}`);
    const to = lcStr(o, "target_identifier", `relationships.jsonl ${rel}`);
    if (rel === "hasChild") {
      const sourceLabels = o.source_labels as string[];
      if (sourceLabels[0].startsWith("Standards")) parent.set(to, from);
    } else if (rel === "supports") {
      const grades = itemGrades.get(to);
      if (!grades) {
        throw new Error(
          `relationships.jsonl supports ${from}: expected a standards item as target ${to}, received none. The export schema changed: check LC_VERSION.`,
        );
      }
      const set = supported.get(from) ?? new Set();
      grades.forEach((g) => set.add(g));
      supported.set(from, set);
    } else if (LC_EDGES.has(rel)) edges.push([rel, from, to]);
  }

  // An item is current when the framework at the top of its hasChild chain is.
  const kept = new Set<string>();
  for (const [id, item] of items) {
    if (item.grouping || !item.text) continue;
    let top = id, hops = 0;
    while (parent.has(top)) {
      top = parent.get(top)!;
      if (++hops > 50) {
        throw new Error(
          `relationships.jsonl: expected a hasChild chain under 50 levels from item ${id}, received a longer one. The graph has a cycle.`,
        );
      }
    }
    const cur = frameworkCurrent.get(top);
    if (cur === undefined) {
      throw new Error(
        `relationships.jsonl: expected item ${id} under a framework, received the chain end ${top}. The export schema changed: check LC_VERSION.`,
      );
    }
    if (cur) kept.add(id);
  }

  const attributions: string[] = [];
  const lines: string[] = [];
  const attributionOf = (s: string): number => {
    let i = attributions.indexOf(s);
    if (i < 0) i = attributions.push(s) - 1;
    return i;
  };
  for (const id of kept) {
    const item = items.get(id)!;
    lines.push(JSON.stringify({
      ...item,
      attribution: attributionOf(item.attribution as string),
    }));
  }
  for (const [id, c] of components) {
    lines.push(JSON.stringify({
      ...c,
      grades: [...supported.get(id) ?? []],
      attribution: attributionOf(c.attribution as string),
    }));
  }
  let nEdges = 0;
  for (const [rel, from, to] of edges) {
    if (!kept.has(from) || !kept.has(to)) continue;
    lines.push(JSON.stringify({ k: "edge", rel, from, to }));
    nEdges++;
  }
  // The statements sit first, so a reader sees what the rows cite.
  lines.unshift(
    JSON.stringify({ k: "attributions", statements: attributions }),
  );
  const gz = await new Response(
    new Blob([lines.join("\n") + "\n"]).stream().pipeThrough(
      new CompressionStream("gzip"),
    ),
  ).arrayBuffer();
  await mkdir(DATA + "learningcommons");
  await Deno.writeFile(LC_EXTRACT + ".tmp", new Uint8Array(gz));
  await Deno.rename(LC_EXTRACT + ".tmp", LC_EXTRACT);
  console.log(
    `  extract: ${kept.size} items, ${components.size} components, ${nEdges} edges, ${
      (gz.byteLength / 1e6).toFixed(1)
    } MB gzipped`,
  );
}

// DigComp 3.0 Data Supplement, CC BY 4.0, 452 KB. Git tracks it.
const DIGCOMP_URL =
  "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/DIGCOMP/DIGCOMP3.0/DigComp%203.0%20Data%20Supplement%2024%20Nov%202025.jsonld";

async function digcomp() {
  const dest = DATA + "digcomp/digcomp3.jsonld";
  if (await exists(dest)) {
    console.log(`  skip: ${dest} exists`);
    return;
  }
  await mkdir(DATA + "digcomp");
  console.log(`  GET ${DIGCOMP_URL}`);
  const r = await fetch(DIGCOMP_URL, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${DIGCOMP_URL}`);
  await Deno.writeTextFile(dest + ".tmp", await r.text());
  await Deno.rename(dest + ".tmp", dest);
}

const steps: { label: string; fn: () => Promise<void> }[] = [
  {
    label:
      "al-cpl (expert prerequisite pairs: geometry, physics, precalculus, data mining)",
    fn: async () => {
      const dir = DATA + "al-cpl";
      if (await exists(dir)) {
        console.log("  skip: already cloned");
        return;
      }
      await run([
        "git",
        "clone",
        "--depth=1",
        "https://github.com/harrylclc/AL-CPL-dataset.git",
        dir,
      ]);
    },
  },
  {
    label: "metacademy-content (ML/AI concept graph with dependencies)",
    fn: async () => {
      const dir = DATA + "metacademy";
      if (await exists(dir + "/metacademy-content")) {
        console.log("  skip: already cloned");
        return;
      }
      await mkdir(dir);
      await run([
        "git",
        "clone",
        "--depth=1",
        "https://github.com/metacademy/metacademy-content.git",
      ], dir);
    },
  },
  {
    label: "metacademy figshare (prerequisite pairs mapped to wikipedia)",
    fn: async () => {
      const dir = DATA + "metacademy";
      await mkdir(dir);
      const zip = dir + "/figshare.zip";
      if (
        await exists(
          dir + "/Metacademy-prerequisite-pairs-transformed-to-wikipedia.csv",
        )
      ) {
        console.log("  skip: already extracted");
        return;
      }
      await get(
        "https://figshare.com/ndownloader/articles/7799774/versions/1",
        zip,
      );
      await run(["unzip", "-o", zip, "-d", dir]);
      await Deno.remove(zip);
    },
  },
  {
    label: "mooccubex prerequisites (CS, math, psychology — ~280MB total)",
    fn: async () => {
      const dir = DATA + "mooccubex";
      await mkdir(dir);
      const base =
        "https://lfs.aminer.cn/misc/moocdata/data/mooccube2/prerequisites";
      for (const name of ["psy.json", "math.json", "cs.json"]) {
        // git tracks the gzip; the plain file is the optional original.
        if (await exists(`${dir}/${name}.gz`)) {
          console.log(`  skip: ${name}.gz exists`);
          continue;
        }
        await get(`${base}/${name}`, `${dir}/${name}`);
      }
    },
  },
  {
    label: "opensalt frameworks (CASE JSON — CCSS, NGSS, state standards)",
    fn: async () => {
      const dir = DATA + "opensalt";
      await mkdir(dir);
      const indexFile = dir + "/index.json";

      // fetch document list
      let docs: { identifier: string; title: string }[] = [];
      if (await exists(indexFile)) {
        docs = JSON.parse(await Deno.readTextFile(indexFile));
        console.log(`  ${docs.length} frameworks in cached index`);
      } else {
        let offset = 0;
        const limit = 100;
        while (true) {
          const url =
            `https://opensalt.net/ims/case/v1p0/CFDocuments?limit=${limit}&offset=${offset}`;
          console.log(`  GET ${url}`);
          const r = await fetch(url);
          if (!r.ok) throw new Error(`${r.status}: ${url}`);
          const body = await r.json();
          const page = body.CFDocuments ?? [];
          docs.push(
            ...page.map((d: { identifier: string; title: string }) => ({
              identifier: d.identifier,
              title: d.title,
            })),
          );
          if (page.length < limit) break;
          offset += limit;
        }
        await Deno.writeTextFile(indexFile, JSON.stringify(docs, null, 2));
        console.log(`  indexed ${docs.length} frameworks`);
      }

      // fetch each package
      let fetched = 0;
      for (const doc of docs) {
        const dest = `${dir}/${doc.identifier}.json`;
        if (await exists(dest)) continue;
        const url =
          `https://opensalt.net/ims/case/v1p0/CFPackages/${doc.identifier}`;
        console.log(`  [${++fetched}] ${doc.title}`);
        const r = await fetch(url);
        if (!r.ok) {
          console.log(`  WARN: ${r.status} for ${doc.title}`);
          continue;
        }
        const f = await Deno.open(dest, { write: true, create: true });
        await r.body!.pipeTo(f.writable);
      }
      if (fetched === 0) {
        console.log("  skip: all frameworks already downloaded");
      }
    },
  },
  {
    label:
      "learning commons knowledge graph (US state standards, learning components; 986 MB streamed)",
    fn: learningCommons,
  },
  { label: "digcomp 3.0 outcomes (452 KB)", fn: digcomp },
  {
    label: "university course prerequisites (Mendeley; 37 MB, 8 MB gzipped)",
    fn: courses,
  },
];

// University course prerequisites (Mendeley fs2hvkps7z v2, CC BY 4.0). The raw
// courses.csv is 34 MB, so git tracks only the gzip. The hashes come from the
// dataset's public API; a mismatch means the authors published a new version.
// REVIEW: Pin file ids and SHA-256 hashes of version 2. Alternative: follow the
// latest version. It picks up fixes but changes the seed edges with no commit.
const COURSES_URL =
  "https://data.mendeley.com/public-files/datasets/fs2hvkps7z/files";
const COURSES_FILES = [
  {
    name: "courses",
    id: "0d6d311c-10fb-465f-8a6a-042cbc32c94d",
    sha256: "92e5dff5b300adead72aa4a8f070318c047811ca6d187a2fdda19a72c3ca2126",
  },
  {
    name: "prereq_edges",
    id: "ae042552-52cb-4293-9187-244d2f657630",
    sha256: "5881d8a74411f61acc3291835a40c44676eefcf6469ebba0dc3495c8feb4ece6",
  },
];
const COURSES_TIMEOUT_MS = 5 * 60_000;

async function courses() {
  const dir = DATA + "courses";
  await mkdir(dir);
  for (const f of COURSES_FILES) {
    const dest = `${dir}/${f.name}.csv.gz`;
    if (await exists(dest)) {
      console.log(`  skip: ${dest} exists`);
      continue;
    }
    const url = `${COURSES_URL}/${f.id}/file_downloaded`;
    console.log(`  GET ${url}`);
    const r = await fetch(url, {
      signal: AbortSignal.timeout(COURSES_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${url}`);
    const raw = new Uint8Array(await r.arrayBuffer());
    const hex = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", raw)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    if (hex !== f.sha256) {
      throw new Error(
        `${url}: expected SHA-256 ${f.sha256}, received ${hex}. The authors may have published a new version: check data.mendeley.com/datasets/fs2hvkps7z, then update COURSES_FILES.`,
      );
    }
    const gz = await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    await Deno.writeFile(dest, new Uint8Array(gz));
  }
}

console.log(`Downloading ${steps.length} datasets to ${DATA}\n`);

for (const [i, step] of steps.entries()) {
  console.log(`\n[${i + 1}/${steps.length}] ${step.label}`);
  try {
    await step.fn();
    console.log("  done");
  } catch (e) {
    console.error(`  ERROR: ${e instanceof Error ? e.message : e}`);
  }
}
