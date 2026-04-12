// deno run --v8-flags=--max-old-space-size=8192 --allow-read --allow-write csp_refine_grades.ts
// Refine CSP grade_start/grade_end from notation embedded in the id.
// Notation like K.OA.A.3, 3.NBT.A.1, 8.F.B.5, HS.N-Q.A.1, CCSS.Math.Content.K.OA.A.3

function gradeFromToken(tok: string): number | null {
  const u = tok.toUpperCase();
  if (u === "K" || u === "PK" || u === "KG") return 0;
  if (u === "HS") return 9;
  if (/^\d+$/.test(u)) {
    const n = parseInt(u);
    if (n >= 0 && n <= 12) return n;
  }
  return null;
}

// scan dot-separated tokens from the notation portion of the id; return first plausible grade.
// Id format: csp.<notation>  where notation itself contains dots
function parseGrade(id: string): number | null {
  if (!id.startsWith("csp.")) return null;
  const tail = id.slice(4);
  const tokens = tail.split(/[._-]/);
  // Prefer first token match
  for (const t of tokens) {
    const g = gradeFromToken(t);
    if (g !== null) return g;
  }
  return null;
}

const txt = await Deno.readTextFile("skills.tsv");
const lines = txt.split("\n");
const header = lines[0];
const cols = header.split("\t");
const iId = cols.indexOf("id"), iSrc = cols.indexOf("source"),
      iGs = cols.indexOf("grade_start"), iGe = cols.indexOf("grade_end");

let changed = 0, inspected = 0, unchanged = 0;
const out: string[] = [header];
for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) { out.push(lines[i]); continue; }
  const r = lines[i].split("\t");
  if (r[iSrc] !== "csp") { out.push(lines[i]); continue; }
  inspected++;
  const g = parseGrade(r[iId]);
  if (g === null) { unchanged++; out.push(lines[i]); continue; }
  const gs = String(g);
  if (r[iGs] === gs && r[iGe] === gs) { unchanged++; out.push(lines[i]); continue; }
  r[iGs] = gs;
  r[iGe] = gs;
  changed++;
  out.push(r.join("\t"));
}

await Deno.writeTextFile("skills.tsv.preC", txt);
await Deno.writeTextFile("skills.tsv", out.join("\n"));
console.log(`CSP skills inspected: ${inspected}, refined: ${changed}, unchanged: ${unchanged}`);
