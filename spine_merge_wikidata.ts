// deno run --allow-read --allow-write spine_merge_wikidata.ts
// Join data/wikidata/p279_spine.jsonl into the spine:
//   - add wd.{qid} to ext_ids / wiki URL to ext_urls on matched spine skills
//   - for each P279 parent, create a wd.{qid} skill row (if label not already
//     in spine) and emit a broader edge spine_skill -> parent.

const P279 = "data/wikidata/p279.jsonl";
const SKILLS = "spine_skills.tsv";
const EDGES = "spine_prereqs.tsv";

type Row = { label: string; qid: string; parents: Array<{ qid: string; label: string }> };

const nkey = (s: string) => s.toLowerCase().trim();

const p279Text = await Deno.readTextFile(P279);
const p279: Row[] = [];
for (const l of p279Text.split("\n")) {
  if (!l) continue;
  p279.push(JSON.parse(l));
}
console.log(`p279 rows: ${p279.length}`);

const sLines = (await Deno.readTextFile(SKILLS)).split("\n").filter(x => x);
const sH = sLines[0].split("\t");
const iId = sH.indexOf("id"), iExtIds = sH.indexOf("ext_ids"),
  iExtUrls = sH.indexOf("ext_urls"), iLabel = sH.indexOf("label"),
  iSrc = sH.indexOf("source");

const rows: string[][] = [];
const idByLabel = new Map<string, string>();
for (let i = 1; i < sLines.length; i++) {
  const r = sLines[i].split("\t");
  while (r.length < sH.length) r.push("");
  rows.push(r);
  idByLabel.set(nkey(r[iLabel]), r[iId]);
}

const newBroaderEdges: string[] = [];
const addedSkills = new Map<string, string[]>(); // qid -> row
let matched = 0, parentsLinked = 0, parentsCreated = 0;

for (const p of p279) {
  if (!p.qid) continue;
  const spineId = idByLabel.get(nkey(p.label));
  if (!spineId) continue;
  matched++;

  const srcRow = rows.find(r => r[iId] === spineId)!;
  const ids = new Set((srcRow[iExtIds] ?? "").split(";").filter(x => x));
  const urls = new Set((srcRow[iExtUrls] ?? "").split(";").filter(x => x));
  ids.add(`wd.${p.qid}`);
  urls.add(`https://www.wikidata.org/wiki/${p.qid}`);
  srcRow[iExtIds] = [...ids].join(";");
  srcRow[iExtUrls] = [...urls].join(";");

  for (const par of p.parents) {
    if (!par.qid || !par.label) continue;
    let parentId = idByLabel.get(nkey(par.label));
    if (!parentId) {
      parentId = `wd.${par.qid}`;
      if (!addedSkills.has(parentId)) {
        const row = new Array(sH.length).fill("");
        row[iId] = parentId;
        row[iExtIds] = parentId;
        row[iExtUrls] = `https://www.wikidata.org/wiki/${par.qid}`;
        row[iLabel] = par.label;
        row[sH.indexOf("tags")] = "wikidata";
        row[iSrc] = "wikidata";
        addedSkills.set(parentId, row);
        parentsCreated++;
      }
    }
    newBroaderEdges.push(`${spineId}\t${parentId}\twikidata_p279\tbroader\t1.000`);
    parentsLinked++;
  }
}

for (const [, r] of addedSkills) rows.push(r);

const outSkills = [sH.join("\t"), ...rows.map(r => r.join("\t"))];
await Deno.writeTextFile(SKILLS, outSkills.join("\n") + "\n");

const existingEdges = await Deno.readTextFile(EDGES);
const eLines = existingEdges.split("\n").filter(x => x);
const eHead = eLines[0];
const seen = new Set<string>();
for (let i = 1; i < eLines.length; i++) {
  const [a, b] = eLines[i].split("\t");
  seen.add(`${a}\t${b}`);
}
const dedupNew: string[] = [];
for (const e of newBroaderEdges) {
  const [a, b] = e.split("\t");
  const k = `${a}\t${b}`;
  if (!seen.has(k)) { seen.add(k); dedupNew.push(e); }
}

const outEdges = [eHead, ...eLines.slice(1), ...dedupNew];
await Deno.writeTextFile(EDGES, outEdges.join("\n") + "\n");

console.log(`matched spine skills: ${matched}`);
console.log(`parent edges linked: ${parentsLinked} (${dedupNew.length} new after dedup)`);
console.log(`wikidata skills created: ${parentsCreated}`);
console.log(`spine_skills.tsv: ${outSkills.length - 1} rows`);
console.log(`spine_prereqs.tsv: ${outEdges.length - 1} edges`);
