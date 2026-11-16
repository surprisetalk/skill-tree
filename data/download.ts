import { TextLineStream } from "@std/streams/text-line-stream";

const DATA = new URL(".", import.meta.url).pathname;

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

async function run(cmd: string[], cwd?: string, timeoutMs?: number) {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    signal: timeoutMs === undefined
      ? undefined
      : AbortSignal.timeout(timeoutMs),
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
  // REVIEW: One 10 min cap per file. Alternative: an idle timeout, which lets a
  // slow big file finish but needs a stream wrapper.
  const r = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!r.ok) {
    throw new Error(
      `expected 2xx, received ${r.status} ${r.statusText} from ${url} (writing ${dest}). Check the URL in a browser; if it moved, update data/download.ts.`,
    );
  }
  const f = await Deno.open(dest + ".tmp", {
    write: true,
    create: true,
    truncate: true,
  });
  await r.body!.pipeTo(f.writable);
  await Deno.rename(dest + ".tmp", dest);
}

async function mkdir(path: string) {
  await Deno.mkdir(path, { recursive: true });
}

// Writes through a temp file, so a crash leaves no half-written gzip.
async function writeGzip(dest: string, data: BlobPart): Promise<number> {
  const gz = new Uint8Array(
    await new Response(
      new Blob([data]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  await Deno.writeFile(dest + ".tmp", gz);
  await Deno.rename(dest + ".tmp", dest);
  return gz.byteLength;
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
    const labels = o.labels;
    if (
      !Array.isArray(labels) || typeof labels[0] !== "string" ||
      typeof o.properties !== "object" || o.properties === null ||
      Array.isArray(o.properties)
    ) {
      throw new Error(
        `${where}: expected labels as an array of text and properties as an object, received labels ${
          JSON.stringify(labels)
        } and properties ${
          JSON.stringify(o.properties)?.slice(0, 80)
        }. The export schema changed: check LC_VERSION.`,
      );
    }
    const props = o.properties as Json;
    const label = labels[0];
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
  await mkdir(DATA + "learningcommons");
  const gzBytes = await writeGzip(LC_EXTRACT, lines.join("\n") + "\n");
  console.log(
    `  extract: ${kept.size} items, ${components.size} components, ${nEdges} edges, ${
      (gzBytes / 1e6).toFixed(1)
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
        const MAX_PAGES = 50;
        for (let pages = 1;; pages++) {
          if (pages > MAX_PAGES) {
            throw new Error(
              `expected the OpenSALT index to end within ${MAX_PAGES} pages, received page ${pages} at offset ${offset} from opensalt.net CFDocuments. Raise MAX_PAGES if the list grew, or check that offset paging still works.`,
            );
          }
          const url =
            `https://opensalt.net/ims/case/v1p0/CFDocuments?limit=${limit}&offset=${offset}`;
          console.log(`  GET ${url}`);
          const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
          if (!r.ok) {
            throw new Error(
              `expected 2xx, received ${r.status} from ${url}. Retry later; if it persists, check opensalt.net.`,
            );
          }
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
        await Deno.writeTextFile(
          indexFile + ".tmp",
          JSON.stringify(docs, null, 2),
        );
        await Deno.rename(indexFile + ".tmp", indexFile);
        console.log(`  indexed ${docs.length} frameworks`);
      }

      // fetch each package
      let fetched = 0;
      const failed: string[] = [];
      for (const doc of docs) {
        const dest = `${dir}/${doc.identifier}.json`;
        if (await exists(dest)) continue;
        const url =
          `https://opensalt.net/ims/case/v1p0/CFPackages/${doc.identifier}`;
        console.log(`  [${++fetched}] ${doc.title}`);
        // The cap covers the body too; the largest package is 11.5 MB.
        const r = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
        if (!r.ok) {
          failed.push(`${doc.title}: ${r.status} from ${url}`);
          await r.body?.cancel();
          continue;
        }
        const f = await Deno.open(dest + ".tmp", {
          write: true,
          create: true,
          truncate: true,
        });
        await r.body!.pipeTo(f.writable);
        await Deno.rename(dest + ".tmp", dest);
      }
      if (failed.length) {
        throw new Error(
          `expected 2xx for every OpenSALT package, received ${failed.length} of ${docs.length} failures. First: ${
            failed[0]
          }. Rerun data/download.ts; finished packages stay.`,
        );
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
  { label: "cert atlas exam objectives (1 MB gzipped)", fn: certAtlas },
  { label: "bncc brazil national curriculum (2 MB)", fn: bncc },
  { label: "common standards project (every jurisdiction)", fn: csp },
  {
    label: "lecturebank expert prerequisite pairs (9 MB clone, eval only)",
    fn: async () => {
      const dir = DATA + "lecturebank";
      if (await exists(dir + "/LB-Paper")) {
        console.log("  skip: already cloned");
        return;
      }
      // The repo states no licence, so .gitignore keeps the clone out of git.
      await run(
        [
          "git",
          "clone",
          "--depth=1",
          "https://github.com/Yale-LILY/LectureBank.git",
          dir,
        ],
        undefined,
        5 * 60_000,
      );
    },
  },
];

// BNCC (bncc.dev, maintained by Profy), data CC BY 4.0. Git tracks the files.
// REVIEW: Pin commit 9c26897 (data release dados-2026.07). Alternative: follow
// main. It picks up corrections but changes the skills with no commit here.
const BNCC_COMMIT = "9c268978efa2aa250834c6a9edb6074432752838";
const BNCC_FILES = [
  "dados/bncc-2018/educacao-infantil.json",
  "dados/bncc-2018/ensino-fundamental.json",
  "dados/bncc-2018/ensino-medio.json",
  "dados/LICENSE.md",
];

// jj refuses new files over 1 MiB, so git tracks each JSON file as a gzip.
async function bncc() {
  const dir = DATA + "bncc";
  await mkdir(dir);
  for (const path of BNCC_FILES) {
    const name = path.split("/").pop()!;
    const json = name.endsWith(".json");
    const dest = `${dir}/${name}${json ? ".gz" : ""}`;
    if (await exists(dest)) {
      console.log(`  skip: ${dest} exists`);
      continue;
    }
    const url =
      `https://raw.githubusercontent.com/bncc-dev/bncc-dados/${BNCC_COMMIT}/${path}`;
    console.log(`  GET ${url}`);
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) {
      throw new Error(
        `${url}: expected HTTP 200, received ${r.status}. Check that commit ${BNCC_COMMIT} still exists on github.com/bncc-dev/bncc-dados.`,
      );
    }
    const body = new Uint8Array(await r.arrayBuffer());
    if (json) await writeGzip(dest, body);
    else {
      await Deno.writeFile(dest + ".tmp", body);
      await Deno.rename(dest + ".tmp", dest);
    }
  }
}

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
    await writeGzip(dest, raw);
  }
}

// Cert Atlas (github.com/hans6883/cert-atlas, MIT): exam objectives of about
// 1900 certifications. The raw repo is 32 MB in 1965 files, so git tracks one
// gzip of the fields that stage list reads.
// REVIEW: Drop Microsoft and AWS. Microsoft Learn terms
// (https://learn.microsoft.com/legal/termsofuse) bar copying "any information"
// from the site without written consent. AWS site terms
// (https://aws.amazon.com/terms/) bar download and commercial reuse without
// written consent, and the exam guides sit on that site. Alternative: keep
// them, since objective titles are facts. It costs a takedown risk if skills.tsv
// ships. CompTIA stays: its terms page (comptia.org) did not load, and it
// grants no reuse either, so the same risk applies to it. The other 355
// certifying bodies are unread.
// REVIEW: Track one slim gzip. Alternative: gitignore the 17 MB of raw files.
// It makes the test fail on a fresh clone and costs 1965 requests per clone.
const CA_BASE =
  "https://raw.githubusercontent.com/hans6883/cert-atlas/master/data";
const CA_DROPPED_VENDORS = new Set(["microsoft", "aws"]);
const CA_TIMEOUT_MS = 30_000;
const CA_WORKERS = 8;

async function certAtlasGet(url: string): Promise<unknown> {
  // The host answers a burst of requests with a transient failure: retry once.
  let last = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(CA_TIMEOUT_MS),
      });
      if (r.ok) return await r.json();
      last = `${r.status} ${r.statusText}`;
    } catch (e) {
      last = (e as Error).message;
    }
  }
  throw new Error(
    `${url}: expected a JSON file, received ${last} after 2 tries. Run the downloader again; if it repeats, check github.com/hans6883/cert-atlas.`,
  );
}

async function certAtlas() {
  const dest = DATA + "certatlas/exams.json.gz";
  if (await exists(dest)) {
    console.log(`  skip: ${dest} exists`);
    return;
  }
  await mkdir(DATA + "certatlas");
  const index = await certAtlasGet(`${CA_BASE}/index.json`) as {
    exams: { exam_id: string; vendor_slug: string }[];
  };
  const wanted = index.exams.filter((e) =>
    !CA_DROPPED_VENDORS.has(e.vendor_slug)
  );
  console.log(
    `  ${index.exams.length} exams in the index, ${wanted.length} after dropping ${[
      ...CA_DROPPED_VENDORS,
    ]}`,
  );
  const str = (v: unknown, where: string): string => {
    if (typeof v !== "string" || !v.trim()) {
      throw new Error(
        `${where}: expected a non-empty string, received ${
          JSON.stringify(v)
        }. The Cert Atlas schema changed: update certAtlas() in data/download.ts.`,
      );
    }
    return v.trim();
  };
  const arr = (v: unknown, where: string): unknown[] => {
    if (!Array.isArray(v)) {
      throw new Error(
        `${where}: expected an array, received ${
          JSON.stringify(v)?.slice(0, 80)
        }. The Cert Atlas schema changed: update certAtlas() in data/download.ts.`,
      );
    }
    return v;
  };
  const exams: unknown[] = new Array(wanted.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CA_WORKERS }, async () => {
      while (next < wanted.length) {
        const i = next++;
        const { exam_id, vendor_slug } = wanted[i];
        const url = `${CA_BASE}/${vendor_slug}/${exam_id}.json`;
        const e = await certAtlasGet(url) as Record<string, unknown>;
        // weight_percent is a property of the exam, not of a skill: leave it.
        exams[i] = {
          id: str(e.exam_id, url),
          name: str(e.exam_name, url),
          body: str(e.certifying_body, url),
          domains: arr(e.domains, `${url} domains`).map((d, j) => {
            const dom = d as Record<string, unknown>;
            return {
              name: str(dom.name, `${url} domains[${j}].name`),
              // An objective is an object, or a bare title string.
              // The source omits the key for a domain with no objectives.
              objectives: ("objectives" in dom
                ? arr(dom.objectives, `${url} domains[${j}].objectives`)
                : []).map((o, k) => {
                  const w = `${url} domains[${j}].objectives[${k}]`;
                  if (typeof o === "string") {
                    return { title: str(o, w), sub: [] };
                  }
                  const ob = o as Record<string, unknown>;
                  return {
                    title: str(ob.title, w),
                    // A sub-objective is a string, or an object with a title.
                    sub: arr(ob.sub_objectives, `${w} sub_objectives`).map((
                      x,
                    ) =>
                      str(typeof x === "object" && x ? (x as Json).title : x, w)
                    ),
                  };
                }),
            };
          }),
        };
      }
    }),
  );
  await writeGzip(dest, JSON.stringify(exams));
  console.log(`  ${exams.length} exams written to ${dest}`);
}

// Common Standards Project: every jurisdiction, every standard set. The API
// answers without a key. Each set carries its own `license` (ASN sets: CC BY
// 3.0 US, Desire2Learn).
// REVIEW: One gzip per set, the raw API body. Alternative: one slim file like
// Cert Atlas. It costs a full recrawl whenever stage list needs another field.
const CSP_API = "https://api.commonstandardsproject.com/api/v1";
const CSP_DIR = DATA + "csp/";
// The largest sets (2.7 MB) take 21 s on a quiet line.
const CSP_TIMEOUT_MS = 120_000;
// A small nonprofit host: keep the request rate low.
const CSP_WORKERS = 4;

async function cspGet(path: string): Promise<Json> {
  let last = "";
  let body: Json | undefined;
  for (let attempt = 1; attempt <= 2 && !body; attempt++) {
    try {
      const r = await fetch(CSP_API + path, {
        signal: AbortSignal.timeout(CSP_TIMEOUT_MS),
      });
      if (r.ok) body = await r.json() as Json;
      else last = `${r.status} ${r.statusText}`;
    } catch (e) {
      last = (e as Error).message;
    }
  }
  if (!body) {
    throw new Error(
      `${CSP_API}${path}: expected a JSON answer, received ${last} after 2 tries. Run the downloader again; finished sets skip.`,
    );
  }
  if (typeof body.data !== "object" || !body.data) {
    throw new Error(
      `${CSP_API}${path}: expected {"data": ...}, received ${
        JSON.stringify(body).slice(0, 80)
      }. The CSP API changed: update csp() in data/download.ts.`,
    );
  }
  return body.data as Json;
}

async function pool<T>(items: T[], fn: (t: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: CSP_WORKERS }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

async function csp() {
  await mkdir(CSP_DIR);
  const list = await cspGet("/jurisdictions") as unknown as { id: string }[];
  if (!Array.isArray(list) || !list.length) {
    throw new Error(
      `${CSP_API}/jurisdictions: expected a non-empty array, received ${
        JSON.stringify(list).slice(0, 80)
      }. The CSP API changed: update csp() in data/download.ts.`,
    );
  }
  const setIds: string[] = [];
  await pool(list, async ({ id }) => {
    const j = await cspGet(`/jurisdictions/${id}`);
    if (!Array.isArray(j.standardSets)) {
      throw new Error(
        `${CSP_API}/jurisdictions/${id}: expected a standardSets array, received ${
          JSON.stringify(j.standardSets)
        }. The CSP API changed: update csp() in data/download.ts.`,
      );
    }
    for (const s of j.standardSets as { id: string }[]) setIds.push(s.id);
  });
  console.log(`  ${list.length} jurisdictions, ${setIds.length} standard sets`);
  let fetched = 0, skipped = 0;
  const failed: string[] = [];
  const t0 = performance.now();
  await pool(setIds, async (id) => {
    // A set id holds only [A-Za-z0-9_-]; anything else would escape the dir.
    if (!/^[\w-]+$/.test(id)) {
      throw new Error(
        `CSP set id ${
          JSON.stringify(id)
        }: expected [A-Za-z0-9_-]. Update csp() in data/download.ts to map it to a safe file name.`,
      );
    }
    const dest = `${CSP_DIR}${id}.json.gz`;
    if (await exists(dest)) {
      skipped++;
      return;
    }
    // One failed set must not stop the other 25k: fetch them all, then throw.
    let body: Json;
    try {
      body = await cspGet(`/standard_sets/${id}`);
    } catch (e) {
      failed.push((e as Error).message);
      return;
    }
    await writeGzip(dest, JSON.stringify(body));
    if (++fetched % 500 === 0) {
      console.log(
        `  ${fetched + skipped}/${setIds.length} sets, ${
          Math.round((performance.now() - t0) / 1000)
        } s`,
      );
    }
  });
  console.log(`  ${fetched} sets fetched, ${skipped} skipped (exist)`);
  if (failed.length) {
    throw new Error(
      `${failed.length} of ${setIds.length} CSP sets failed. First: ${
        failed[0]
      }`,
    );
  }
}

const readGzipJson = async (path: string): Promise<unknown> =>
  JSON.parse(
    await new Response(
      (await Deno.open(path)).readable.pipeThrough(
        new DecompressionStream("gzip"),
      ),
    ).text(),
  );

const API_TIMEOUT_MS = 60_000;
// A 429 waits for the window the server names. Oak's window is one hour.
const API_MAX_WAITS = 6;
const API_MAX_WAIT_MS = 65 * 60_000;

// One GET with a key header. Retries once on a network error or a 5xx. On a
// 429 it sleeps until the reset the server names, at most API_MAX_WAITS times.
async function keyedGet(
  url: string,
  headers: Record<string, string>,
  keyName: string,
): Promise<unknown> {
  let tries = 0, waits = 0, last = "";
  for (;;) {
    let r: Response;
    try {
      r = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (e) {
      last = (e as Error).message;
      if (++tries < 2) continue;
      break;
    }
    if (r.ok) {
      const text = await r.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error(
          `${url}: expected a JSON body, received ${(e as Error).message} (${
            JSON.stringify(text.slice(0, 80))
          }). A gateway or login page answered: retry later, or check ${keyName}.`,
        );
      }
    }
    await r.body?.cancel();
    last = `${r.status} ${r.statusText}`;
    if (r.status === 401 || r.status === 403) {
      throw new Error(
        `${url}: expected 200, received ${last}. The key in ${keyName} is wrong or revoked: check .env.`,
      );
    }
    if (r.status === 429) {
      // Oak names the reset as epoch ms; other hosts send Retry-After seconds.
      const reset = Number(r.headers.get("x-ratelimit-reset"));
      const after = Number(r.headers.get("retry-after"));
      const ms = reset > 0 ? reset - Date.now() + 5_000 : after * 1000;
      if (!(ms > 0) || ms > API_MAX_WAIT_MS || ++waits > API_MAX_WAITS) {
        throw new Error(
          `${url}: expected 200, received 429 after ${waits} waits (next wait ${
            Math.round(ms / 1000)
          } s). Run the downloader again later; finished files skip.`,
        );
      }
      console.log(
        `  429: wait ${Math.round(ms / 60_000)} min (wait ${waits})`,
      );
      await new Promise((ok) => setTimeout(ok, ms));
      continue;
    }
    if (r.status >= 500 && ++tries < 2) continue;
    break;
  }
  throw new Error(
    `${url}: expected 200, received ${last} after ${
      tries || 1
    } tries. Run the downloader again; finished files skip.`,
  );
}

const needKey = (name: string): string => {
  const key = Deno.env.get(name);
  if (!key) {
    throw new Error(
      `expected ${name} in the environment, received nothing. Put the key in .env, then run with the .env loaded: set -a; . ./.env; set +a.`,
    );
  }
  return key;
};

const safeSlug = (s: unknown, where: string): string => {
  // A slug names a file, so anything outside [A-Za-z0-9_-] could escape the dir.
  if (typeof s !== "string" || !/^[\w-]+$/.test(s)) {
    throw new Error(
      `${where}: expected a slug of [A-Za-z0-9_-], received ${
        JSON.stringify(s)
      }. The API changed: update data/download.ts.`,
    );
  }
  return s;
};

// Fetches each slug into dir/{slug}.json.gz, one at a time, and skips files
// that exist, so a crawl that a rate limit stops resumes where it stopped.
async function crawl(
  dir: string,
  slugs: string[],
  url: (slug: string) => string,
  get: (url: string) => Promise<unknown>,
) {
  await mkdir(dir);
  let fetched = 0;
  const t0 = performance.now();
  for (const slug of slugs) {
    const dest = `${dir}${slug}.json.gz`;
    if (await exists(dest)) continue;
    await writeGzip(dest, JSON.stringify(await get(url(slug))));
    if (++fetched % 100 === 0) {
      console.log(
        `  ${dir}: ${fetched} fetched, ${
          Math.round((performance.now() - t0) / 1000)
        } s`,
      );
    }
  }
  console.log(`  ${dir}: ${fetched} fetched, ${slugs.length} in all`);
}

// Oak National Academy curriculum API (England, KS1-KS4), OGL v3. A key
// (OAK_API_KEY) allows 1000 calls an hour, and the crawl needs about 1900.
// REVIEW: Track the raw API bodies, one gzip per sequence and per unit, like
// CSP. Alternative: one slim gzip like Cert Atlas. It costs a 2-hour recrawl
// whenever stage list needs another field. Lesson bodies stay out: a unit is
// one skill, and only lessons carry the `restricted` third-party flag.
const OAK_API = "https://open-api.thenational.academy/api/v0";
const OAK_DIR = DATA + "oak/";

async function oak() {
  // index.json.gz goes last, so it marks a finished crawl.
  const index = OAK_DIR + "index.json.gz";
  if (await exists(index)) {
    console.log(`  skip: ${index} exists`);
    return;
  }
  const headers = { Authorization: `Bearer ${needKey("OAK_API_KEY")}` };
  const get = (url: string) => keyedGet(url, headers, "OAK_API_KEY");
  const subjects = await get(`${OAK_API}/subjects`);
  if (!Array.isArray(subjects) || !subjects.length) {
    throw new Error(
      `${OAK_API}/subjects: expected a non-empty array of slugs, received ${
        JSON.stringify(subjects).slice(0, 80)
      }. The Oak API changed: update oak() in data/download.ts.`,
    );
  }
  const sequences: Record<string, string[]> = {};
  for (const s of subjects) {
    const slug = safeSlug(s, `${OAK_API}/subjects`);
    const body = await get(`${OAK_API}/subjects/${slug}`) as Json;
    if (!Array.isArray(body.sequenceSlugs)) {
      throw new Error(
        `${OAK_API}/subjects/${slug}: expected a sequenceSlugs array, received ${
          JSON.stringify(body.sequenceSlugs)
        }. The Oak API changed: update oak() in data/download.ts.`,
      );
    }
    sequences[slug] = (body.sequenceSlugs as Json[]).map((q) =>
      safeSlug(q.sequenceSlug, `${OAK_API}/subjects/${slug}`)
    );
  }
  const seqDir = OAK_DIR + "sequences/";
  const seqSlugs = Object.values(sequences).flat();
  await crawl(seqDir, seqSlugs, (q) => `${OAK_API}/sequences/${q}/units`, get);
  // A unit sits in a year, a tier, an exam subject, or a unit option: walk it.
  const units = new Set<string>();
  const walk = (x: unknown, where: string) => {
    if (Array.isArray(x)) { for (const v of x) walk(v, where); }
    else if (x && typeof x === "object") {
      if ("unitSlug" in x) units.add(safeSlug(x.unitSlug, where));
      for (const v of Object.values(x)) walk(v, where);
    }
  };
  for (const q of seqSlugs) {
    walk(await readGzipJson(`${seqDir}${q}.json.gz`), `${seqDir}${q}.json.gz`);
  }
  console.log(`  ${seqSlugs.length} sequences, ${units.size} units`);
  await crawl(
    OAK_DIR + "units/",
    [...units].sort(),
    (u) => `${OAK_API}/units/${u}/summary`,
    get,
  );
  await writeGzip(index, JSON.stringify({ sequences, units: [...units] }));
}

// Skills England occupational maps API, OGL v3. A key (DWP_OCC_API_KEY) is
// granted at Skills England's discretion. Every derived product must carry the
// Skills England logo and "© Skills England 2025".
// REVIEW: Track the raw occupation bodies with their knowledge, skill, and
// behaviour lists, one gzip each. Alternative: also fetch the occupational
// progression edges. They link occupations, not skills, and nothing reads them.
const SE_API =
  "https://occupational-maps-api.skillsengland.education.gov.uk/api/v1";
const SE_DIR = DATA + "skillsengland/";

async function skillsEngland() {
  const index = SE_DIR + "index.json.gz";
  if (await exists(index)) {
    console.log(`  skip: ${index} exists`);
    return;
  }
  const headers = { "X-API-KEY": needKey("DWP_OCC_API_KEY") };
  const get = (url: string) => keyedGet(url, headers, "DWP_OCC_API_KEY");
  const list = await get(`${SE_API}/Occupations`);
  if (!Array.isArray(list) || !list.length) {
    throw new Error(
      `${SE_API}/Occupations: expected a non-empty array, received ${
        JSON.stringify(list).slice(0, 80)
      }. The Skills England API changed: update skillsEngland() in data/download.ts.`,
    );
  }
  const codes = list.map((o: Json) =>
    safeSlug(o.stdCode, `${SE_API}/Occupations`)
  );
  await crawl(
    SE_DIR + "occupations/",
    codes,
    (c) => `${SE_API}/Occupations/${c}?expand=occupation.dutiesKSB`,
    get,
  );
  await writeGzip(index, JSON.stringify(codes));
}

steps.push(
  { label: "oak national academy units (England KS1-KS4, keyed)", fn: oak },
  {
    label: "skills england apprenticeship standards (keyed)",
    fn: skillsEngland,
  },
);

console.log(`Downloading ${steps.length} datasets to ${DATA}\n`);

const failed: string[] = [];
for (const [i, step] of steps.entries()) {
  console.log(`\n[${i + 1}/${steps.length}] ${step.label}`);
  try {
    await step.fn();
    console.log("  done");
  } catch (e) {
    // AbortSignal.timeout rejects with a bare "Signal timed out".
    const msg = e instanceof DOMException && e.name === "TimeoutError"
      ? `expected "${step.label}" to download within its timeout, received a timeout. Check the network, then rerun; a partial .tmp file restarts.`
      : e instanceof Error
      ? e.message
      : e;
    console.error(`  ERROR: ${msg}`);
    failed.push(step.label);
  }
}
if (failed.length) {
  console.error(
    `\n${failed.length} of ${steps.length} steps failed: ${
      failed.join("; ")
    }. Read the ERROR lines above, then run the downloader again; finished steps skip.`,
  );
  Deno.exit(1);
}
