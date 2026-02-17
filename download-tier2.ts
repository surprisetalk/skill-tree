import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";

const DATA_DIR = new URL("./data/", import.meta.url).pathname;

const ONET_VERSION = "30_1";
const ONET_URL = `https://www.onetcenter.org/dl_files/database/db_${ONET_VERSION}_text.zip`;
const LIGHTCAST_GIST_URL =
  "https://gist.githubusercontent.com/ThatGuySam/8a6e7bd152793ac12b7f60420d1017c8/raw";

async function downloadOnet() {
  const dir = `${DATA_DIR}onet/`;
  await ensureDir(dir);

  const marker = `${dir}.downloaded`;
  try {
    await Deno.stat(marker);
    console.log("[O*NET] Already downloaded, skipping. Delete data/onet/.downloaded to re-download.");
    return;
  } catch { /* not yet downloaded */ }

  console.log(`[O*NET] Downloading db_${ONET_VERSION}_text.zip ...`);
  const resp = await fetch(ONET_URL);
  if (!resp.ok) throw new Error(`[O*NET] Download failed: ${resp.status} ${resp.statusText}`);

  const zipPath = `${dir}onet.zip`;
  const buf = await resp.arrayBuffer();
  console.log(`[O*NET] Downloaded ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB, extracting...`);
  await Deno.writeFile(zipPath, new Uint8Array(buf));

  const cmd = new Deno.Command("unzip", { args: ["-o", "-j", zipPath, "-d", dir] });
  const result = await cmd.output();
  if (!result.success) throw new Error(`[O*NET] unzip failed: ${new TextDecoder().decode(result.stderr)}`);

  await Deno.remove(zipPath);
  await Deno.writeTextFile(marker, new Date().toISOString());

  let count = 0;
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".txt")) count++;
  }
  console.log(`[O*NET] Extracted ${count} .txt files to data/onet/`);
}

async function checkEsco() {
  const dir = `${DATA_DIR}esco/`;
  await ensureDir(dir);

  let hasFiles = false;
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && (entry.name.endsWith(".csv") || entry.name.endsWith(".json"))) {
      hasFiles = true;
      break;
    }
  }

  if (hasFiles) {
    console.log("[ESCO] Found existing files in data/esco/");
  } else {
    console.log(`[ESCO] No data found. Manual download required:

  1. Go to https://esco.ec.europa.eu/en/use-esco/download
  2. Select version v1.2.1, format CSV, language English
  3. Accept terms and provide your email
  4. Download the CSV package from the link you receive
  5. Extract CSV files into: ${dir}
`);
  }
}

async function downloadLightcast() {
  const dir = `${DATA_DIR}lightcast/`;
  await ensureDir(dir);

  const dest = `${dir}skills.json`;
  try {
    await Deno.stat(dest);
    console.log("[Lightcast] Already downloaded, skipping. Delete data/lightcast/skills.json to re-download.");
    return;
  } catch { /* not yet downloaded */ }

  console.log("[Lightcast] Downloading skills snapshot from GitHub Gist...");
  const resp = await fetch(LIGHTCAST_GIST_URL);
  if (!resp.ok) throw new Error(`[Lightcast] Download failed: ${resp.status} ${resp.statusText}`);

  const json = await resp.text();
  await Deno.writeTextFile(dest, json);

  const parsed = JSON.parse(json);
  const skillCount = parsed.data?.length ?? "unknown";
  console.log(`[Lightcast] Saved ${skillCount} skills to data/lightcast/skills.json`);
  console.log(`[Lightcast] Note: This is a May 2023 snapshot. For fresh data, register at https://lightcast.io/open-skills/access`);
}

console.log("=== Downloading Tier 2: Skills & Competency Taxonomies ===\n");

await downloadOnet();
console.log();
await checkEsco();
console.log();
await downloadLightcast();

console.log("\n=== Done ===");
