const DATA = new URL(".", import.meta.url).pathname;

async function exists(path: string): Promise<boolean> {
  try { await Deno.stat(path); return true; } catch { return false; }
}

async function run(cmd: string[], cwd?: string) {
  const p = new Deno.Command(cmd[0], { args: cmd.slice(1), cwd, stdout: "inherit", stderr: "inherit" });
  const { code } = await p.output();
  if (code !== 0) throw new Error(`command failed (exit ${code}): ${cmd.join(" ")}`);
}

async function get(url: string, dest: string) {
  if (await exists(dest)) { console.log(`  skip: ${dest} exists`); return; }
  console.log(`  GET ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${url}`);
  const f = await Deno.open(dest, { write: true, create: true });
  await r.body!.pipeTo(f.writable);
}

async function mkdir(path: string) {
  await Deno.mkdir(path, { recursive: true });
}

const steps: { label: string; fn: () => Promise<void> }[] = [
  {
    label: "al-cpl (expert prerequisite pairs: geometry, physics, precalculus, data mining)",
    fn: async () => {
      const dir = DATA + "al-cpl";
      if (await exists(dir)) { console.log("  skip: already cloned"); return; }
      await run(["git", "clone", "--depth=1", "https://github.com/harrylclc/AL-CPL-dataset.git", dir]);
    },
  },
  {
    label: "metacademy-content (ML/AI concept graph with dependencies)",
    fn: async () => {
      const dir = DATA + "metacademy";
      if (await exists(dir + "/metacademy-content")) { console.log("  skip: already cloned"); return; }
      await mkdir(dir);
      await run(["git", "clone", "--depth=1", "https://github.com/metacademy/metacademy-content.git"], dir);
    },
  },
  {
    label: "metacademy figshare (prerequisite pairs mapped to wikipedia)",
    fn: async () => {
      const dir = DATA + "metacademy";
      await mkdir(dir);
      const zip = dir + "/figshare.zip";
      if (await exists(dir + "/Metacademy-prerequisite-pairs-transformed-to-wikipedia.csv")) {
        console.log("  skip: already extracted"); return;
      }
      await get("https://figshare.com/ndownloader/articles/7799774/versions/1", zip);
      await run(["unzip", "-o", zip, "-d", dir]);
      await Deno.remove(zip);
    },
  },
  {
    label: "mooccubex prerequisites (CS, math, psychology — ~280MB total)",
    fn: async () => {
      const dir = DATA + "mooccubex";
      await mkdir(dir);
      const base = "https://lfs.aminer.cn/misc/moocdata/data/mooccube2/prerequisites";
      for (const name of ["psy.json", "math.json", "cs.json"]) {
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
          const url = `https://opensalt.net/ims/case/v1p0/CFDocuments?limit=${limit}&offset=${offset}`;
          console.log(`  GET ${url}`);
          const r = await fetch(url);
          if (!r.ok) throw new Error(`${r.status}: ${url}`);
          const body = await r.json();
          const page = body.CFDocuments ?? [];
          docs.push(...page.map((d: { identifier: string; title: string }) => ({ identifier: d.identifier, title: d.title })));
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
        const url = `https://opensalt.net/ims/case/v1p0/CFPackages/${doc.identifier}`;
        console.log(`  [${++fetched}] ${doc.title}`);
        const r = await fetch(url);
        if (!r.ok) { console.log(`  WARN: ${r.status} for ${doc.title}`); continue; }
        const f = await Deno.open(dest, { write: true, create: true });
        await r.body!.pipeTo(f.writable);
      }
      if (fetched === 0) console.log("  skip: all frameworks already downloaded");
    },
  },
];

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
