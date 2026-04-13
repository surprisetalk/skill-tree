// deno run --allow-read --allow-write skill_value.ts
// Writes skill_value.tsv: per-skill value score.
// O*NET skills/knowledge/abilities: avg(job_zone × importance) across occupations.
// ESCO skills: count of ESCO occupations that flag the skill as essential/optional.

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const parseTsv = (text: string): Record<string, string>[] => {
  const lines = text.replace(/\r/g, "").split("\n").filter(l => l.trim());
  const hdr = lines[0].split("\t");
  return lines.slice(1).map(l => {
    const vals = l.split("\t");
    const row: Record<string, string> = {};
    for (let i = 0; i < hdr.length; i++) row[hdr[i]] = vals[i] ?? "";
    return row;
  });
};

// 1. SOC → job zone
const zoneBySoc = new Map<string, number>();
for (const r of parseTsv(await Deno.readTextFile("data/onet/Job Zones.txt"))) {
  const z = parseInt(r["Job Zone"]);
  if (!isNaN(z)) zoneBySoc.set(r["O*NET-SOC Code"], z);
}
console.log(`SOC → job zone entries: ${zoneBySoc.size}`);

// 2. O*NET value = avg(zone * importance) across occupations
const onetValue = new Map<string, { sum: number; n: number }>();
const files: Array<[string, string]> = [
  ["data/onet/Skills.txt", "skill"],
  ["data/onet/Knowledge.txt", "knowledge"],
  ["data/onet/Abilities.txt", "ability"],
];
for (const [path, kind] of files) {
  for (const r of parseTsv(await Deno.readTextFile(path))) {
    if (r["Scale ID"] !== "IM") continue;
    const soc = r["O*NET-SOC Code"];
    const zone = zoneBySoc.get(soc);
    if (!zone) continue;
    const imp = parseFloat(r["Data Value"]);
    if (isNaN(imp)) continue;
    const id = `onet.${kind}.${slug(r["Element Name"])}`;
    const acc = onetValue.get(id) ?? { sum: 0, n: 0 };
    acc.sum += zone * imp;
    acc.n += 1;
    onetValue.set(id, acc);
  }
}
console.log(`O*NET skills scored: ${onetValue.size}`);

// 3. ESCO value = essential(2) + optional(1) occupation count per skill
const escoValue = new Map<string, number>();
for (const line of (await Deno.readTextFile("prereqs.tsv")).split("\n").slice(1)) {
  if (!line) continue;
  const [skill_id, prereq_id, source] = line.split("\t");
  // ESCO occupation → skill: skill_id is occupation, prereq_id is skill
  if (!skill_id.startsWith("esco.occ.")) continue;
  const w = source === "esco" ? 2 : source === "esco_optional" ? 1 : 0;
  if (!w) continue;
  escoValue.set(prereq_id, (escoValue.get(prereq_id) ?? 0) + w);
}
console.log(`ESCO skills scored: ${escoValue.size}`);

// 4. Write
const rows: string[] = ["skill_id\tvalue\tkind"];
for (const [id, { sum, n }] of onetValue) rows.push(`${id}\t${(sum / n).toFixed(3)}\tonet`);
for (const [id, v] of escoValue) rows.push(`${id}\t${v}\tesco`);
await Deno.writeTextFile("skill_value.tsv", rows.join("\n") + "\n");

// Top-20 preview per kind
const top = (kind: string, n: number) => {
  const entries = rows.slice(1).map(r => r.split("\t")).filter(r => r[2] === kind)
    .map(r => ({ id: r[0], v: parseFloat(r[1]) }))
    .sort((a, b) => b.v - a.v).slice(0, n);
  console.log(`\nTop ${n} ${kind}:`);
  for (const e of entries) console.log(`  ${e.v.toFixed(2).padStart(7)}  ${e.id}`);
};
top("onet", 10);
top("esco", 10);
console.log(`\nwrote skill_value.tsv (${rows.length - 1} rows)`);
