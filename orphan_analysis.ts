// deno run --v8-flags=--max-old-space-size=8192 --allow-read orphan_analysis.ts
const skillsTxt = await Deno.readTextFile("skills.tsv");
const sLines = skillsTxt.split("\n");
const cols = sLines[0].split("\t");
const iId = cols.indexOf("id"), iSrc = cols.indexOf("source"), iGs = cols.indexOf("grade_start");
const srcOf = new Map<string, string>();
const gsOf = new Map<string, string>();
for (let i = 1; i < sLines.length; i++) {
  if (!sLines[i]) continue;
  const r = sLines[i].split("\t");
  srcOf.set(r[iId], r[iSrc]);
  gsOf.set(r[iId], r[iGs]);
}
const connected = new Set<string>();
const pText = await Deno.readTextFile("prereqs.tsv");
const pLines = pText.split("\n");
for (let i = 1; i < pLines.length; i++) {
  if (!pLines[i]) continue;
  const [a, b] = pLines[i].split("\t");
  connected.add(a); connected.add(b);
}
const orphanBy = new Map<string, number>();
for (const [id, src] of srcOf) if (!connected.has(id)) orphanBy.set(src, (orphanBy.get(src) ?? 0) + 1);
console.log("orphans by source:");
for (const [s, n] of [...orphanBy.entries()].sort((a,b) => b[1] - a[1])) console.log(`  ${s.padEnd(15)} ${n}`);
