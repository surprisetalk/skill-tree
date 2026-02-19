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
    label: "assistments 2009-2010 (K-12 math interactions, ~110 knowledge components)",
    fn: async () => {
      const dir = DATA + "assistments";
      await mkdir(dir);
      const zip = dir + "/figshare.zip";
      const csvs = await Array.fromAsync(
        (async function* () { try { for await (const e of Deno.readDir(dir)) if (e.name.endsWith(".csv")) yield e; } catch {} })()
      );
      if (csvs.length > 0) { console.log("  skip: csv files already exist"); return; }
      await get("https://figshare.com/ndownloader/articles/25309000/versions/1", zip);
      await run(["unzip", "-o", zip, "-d", dir]);
      try { await Deno.remove(zip); } catch { /* ok */ }
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
  {
    label: "ngss appendix E (DCI learning progressions, PDF)",
    fn: async () => {
      const dir = DATA + "ngss";
      await mkdir(dir);
      await get(
        "https://www.nextgenscience.org/sites/default/files/resource/files/AppendixE-ProgressionswithinNGSS-061617.pdf",
        dir + "/AppendixE-Progressions.pdf",
      );
    },
  },
  {
    label: "ngss appendix F (science & engineering practices, PDF)",
    fn: async () => {
      const dir = DATA + "ngss";
      await mkdir(dir);
      await get(
        "https://www.nextgenscience.org/sites/default/files/Appendix%20F%20%20Science%20and%20Engineering%20Practices%20in%20the%20NGSS%20-%20FINAL%20060513.pdf",
        dir + "/AppendixF-Practices.pdf",
      );
    },
  },
  {
    label: "hess math learning progressions framework (PDF)",
    fn: async () => {
      const dir = DATA + "hess-lpf";
      await mkdir(dir);
      await get(
        "https://www.nciea.org/wp-content/uploads/2022/07/Math_LPF_KH11.pdf",
        dir + "/Math_LPF_KH11.pdf",
      );
    },
  },
  {
    label: "hess ELA learning progressions framework (PDF)",
    fn: async () => {
      const dir = DATA + "hess-lpf";
      await mkdir(dir);
      await get(
        "https://cde.videossc.com/archives/032114/LPF-for-CCSS-ELA.pdf",
        dir + "/LPF-for-CCSS-ELA.pdf",
      );
    },
  },
  {
    label: "asn NGSS standards (JSON-LD)",
    fn: async () => {
      const dir = DATA + "asn";
      await mkdir(dir);
      await get(
        "http://asn.desire2learn.com/resources/D2601214_full.json",
        dir + "/ngss.json",
      );
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

console.log(`
\n========================================
Datasets requiring accounts (manual download):
========================================
- Junyi Academy (Kaggle): kaggle datasets download junyiacademy/learning-activity-public-dataset-by-junyi-academy
- PSLC DataShop: https://pslcdatashop.web.cmu.edu (free account)
- CASE Network 2 API: email casenetwork@1edtech.org
- DLM prerequisite graph: email dlm@ku.edu
- ASN bulk corpus: https://asn.desire2learn.com/content/asn-batch-service
`);
