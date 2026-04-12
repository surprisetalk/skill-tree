// deno run --allow-read --allow-write spine_college_grades.ts
// Source-rule defaults for still-ungraded spine skills.
// mooccubex/metacademy → college (13-16). onet → professional (16-20).
// alcpl/khan/assistments → K-12 fallback (1-12).

const RULES: Record<string, [string, string]> = {
  mooccubex:   ["13", "16"],
  metacademy:  ["13", "18"],
  onet:        ["16", "20"],
  alcpl:       ["1",  "12"],
  khan:        ["0",  "8"],
  assistments: ["3",  "8"],
};

const lines = (await Deno.readTextFile("spine_skills.tsv")).split("\n").filter(x => x);
const h = lines[0].split("\t");
const iSrc = h.indexOf("source"), iGs = h.indexOf("grade_start"), iGe = h.indexOf("grade_end");

let patched = 0;
const out = [lines[0]];
for (let i = 1; i < lines.length; i++) {
  const r = lines[i].split("\t");
  if (r[iGs] === "" && r[iGe] === "") {
    const rule = RULES[r[iSrc]];
    if (rule) { r[iGs] = rule[0]; r[iGe] = rule[1]; patched++; }
  }
  out.push(r.join("\t"));
}
await Deno.writeTextFile("spine_skills.tsv", out.join("\n") + "\n");

console.log(`patched: ${patched}`);
const bandCounts = new Map<string, number>();
for (let i = 1; i < out.length; i++) {
  const r = out[i].split("\t");
  const gs = r[iGs], ge = r[iGe];
  const s = gs === "" ? NaN : +gs, e = ge === "" ? NaN : +ge;
  if (isNaN(s) && isNaN(e)) { bandCounts.set("ungraded", (bandCounts.get("ungraded") ?? 0) + 1); continue; }
  const m = isNaN(s) ? e : isNaN(e) ? s : (s + e) / 2;
  const b = m <= 5 ? "K-5" : m <= 8 ? "6-8" : m <= 12 ? "9-12" : "post-12";
  bandCounts.set(b, (bandCounts.get(b) ?? 0) + 1);
}
for (const [b, n] of [...bandCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${b.padEnd(10)} ${n}`);
}
