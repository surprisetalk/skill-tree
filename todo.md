## Next

Each entry below is a `deno task status` condition that fails, or a stage that
is not built. Rerun one stage: `sh build/chain/chain.sh <stage>` (load `.env`
first for `enrich` and `prereq`).

- [ ] Stage `prereq` reaches more expert prereq pairs in its candidate pool, and
      classifies with Cloudflare Clef where Clef beats Haiku 5.5. Facts:
      `@cf/cloudflare/clef-flash` (9B), `noul` yes/no questions, 1–64 per call,
      $0.038/M input, 10k neurons a day free. `CLOUDFLARE_API_TOKEN` is in
      `.env`. Clef takes only fixed-choice calls: `prereq`, `prereq:snap`,
      `pilot:snap`. Pool (14 Nov, LectureBank 258 positives): 44% fail the
      easier-than guard in `candOk`, 37% share no topic with the dependent, 15%
      rank past the top slots, 2% reach the pool. Junyi: 17 of 70 reach it.
      Picks on Junyi (68 dependents): `clef-flash` p ≥ 0.5 8/8, Haiku 5/5; too
      few graded edges to decide. Study scripts: `build/clef/`.
  1. Add 20 exact-cosine slots from all valid skills, any topic, at the end of
     `candidateShare` (K 15 → 35). Measured: LectureBank 5 → 12 of 258, Junyi 17
     → 24 of 70. Cost: 2.3× prompt tokens a skill. Leave the easier-than guard
     on: a harder candidate yields inverted edges.
  2. Rerun the Junyi and LectureBank pick trials on the 35-candidate pools.
     Switch `prereq` to `clef-flash` only if its precision holds on at least 20
     graded edges.
  3. Count what a looser `resolveConcept` adds: 2,288 of 2,547 LectureBank and
     686 of 832 Junyi positive rows name a topic with no skill.

- [ ] `deno task test` finishes in under 10 s. Warm run (14 Nov): 10.7 s wall,
      58 s user, 630% CPU; the tests themselves take 0.4 s. The cost is the
      fixture runs at module load.
  1. Time each `run()` in `pipeline_test.ts` with `performance.now()`. Find the
     slowest before you cut anything.
  2. If the error-case list runs (`listWithData`, `listOpensalt`) dominate:
     `listDir` links full ESCO and O\*NET into each. Link head-truncated copies
     (header plus about 200 rows) there. Keep full data in the `LIST` run.
  3. Merge the Cert Atlas error cases into fewer runs when one run can assert
     several failures.

- [ ] A crash or Ctrl-C never leaves a torn build file that a later stage reads
      as valid. Now `stageTrees` truncates `1j`, `1k`, and `1l` in place, and
      `readTree` checks only line shape. `writeStats` writes `*_stats.json` in
      place too.
  1. Add `writeAtomic(path, text)` to `lib.ts`: write `path.tmp`, then
     `Deno.renameSync`. Use it in `writeStats` and at `sources.ts:1829`, which
     hand-rolls the same thing.
  2. In `stageTrees`, write all three `.tmp` files first, then rename all three,
     so the three files always come from one run.

- [ ] `data/download.ts` never leaves a half file, never hangs, and exits
      nonzero when a framework fails. Now `get()` pipes straight into `dest`
      with no timeout, and the next run skips the partial file. OpenSALT logs
      `WARN` on a failed package, continues, and exits 0.
  1. `get()`: add `AbortSignal.timeout` (10 min). Pipe to `dest.tmp`, then
     rename. The non-ok error states expected 2xx, received status, the URL, and
     a fix.
  2. OpenSALT: collect failed frameworks and throw after the loop, as `csp()`
     does. Add a 60 s timeout to both fetches. Write through `.tmp`. Bound the
     page loop (50 pages) and throw with the counter.
  3. `exists()`: return false only for `Deno.errors.NotFound`. Rethrow other
     errors. Now a permission error makes it fetch again over existing data.

- [ ] Stage `list` fails when CSP gives zero rows. Now an empty `data/csp`
      passes: the per-source zero-row guard (`sources.ts:1690`) omits `csp`, and
      the 20,000-row floor holds on the other sources.
  1. Add `"csp"` to that list. Run `deno task test` to confirm the 200-set
     sample gives CSP rows.

- [ ] Stage `postproc` crashes on a skill with no difficulty row. It does not
      sort it as raw 0. Now `rawDiff` and `band` (`prereq.ts:764`) copy `diffs`,
      and 12 lookups default with `?? 0` or `?? 20`. No lookup misses today, but
      a miss makes a missing prereq look easier than its dependent.
  1. Delete `rawDiff` and `band`. Add `diffOf(id)`: it returns `diffs.get(id)`
     or throws expected a difficulty row, received none, and the rerun fix.
  2. Replace every `rawDiff.get(x) ?? 0` and `band.get(x) ?? n` with
     `diffOf(x)`. The postproc fixture output stays identical.
  3. `graph.ts:1530`: the error names `build/1_skills.tsv`, but stage
     `difficulty` reads `TAGGED_DEDUPED`. Name `TAGGED_DEDUPED.path`.

- [ ] Status condition `kendall_tau_vs_anchor` grades every source, not only the
      first. Now `graph.ts:1643` keeps the first 2000 anchored skills in table
      order, which is one source at 279k anchors.
  1. Replace the truncation with a stride:
     `step = Math.ceil(sample.length / 2000)`, keep every `step`-th row. The
     pair cost stays 2M.
  2. After the next full build, check the new value against the 0.5 threshold in
     `pipeline.ts`.

- [ ] Stage `tag` takes less than its 4m11 at CSP scale. Now `oversamplePass`
      (`graph.ts:452`) tests every skill against every ref: about 392k × 9k Set
      lookups.
  1. Before the skill loop, build `tokToRefs: Map<string, number[]>` from
     `refToks`, without poisoned refs.
  2. Per skill, walk its tokens through `tokToRefs` to count `hits[r]` and set
     `rareHit[r]`. Reset only the refs it touched. Keep the gate: `rareHit` or
     `hits >= 2`.
  3. Sort survivors by ascending `r` before the dot product, so ties keep
     today's order. Diff the tag outputs on a sample build.

- [ ] Stage `seed-edges` takes less than its 5m50. The `opensalt_grade` pairing
      (`sources.ts:2471`) runs 13.3M (i, j) iterations and calls `sigT` on both
      labels in each. The `PAIR_CAP` check comes after the overlap count.
  1. After `nodes.sort`, compute `sigs = nodes.map((n) => sigT(n.label))` and
     index into it.
  2. Move the `PAIR_CAP` check above the overlap count. Output is unchanged: the
     count increments only after it.
  3. Diff the `opensalt_grade` rows of `1e_seed_edges.tsv` before and after.

- [ ] `deno task status` takes less than its 1m14. Now it reads the 1.2 GB
      `2_embeddings.bin` up to 5 times, and parses `1_skills.tsv`, the seeds,
      and the topological order twice each.
  1. Memoize `loadRawEmbeddings` in stage `status` only. A full chain runs in
     one process and stage `embed` rewrites the file, so a module memo goes
     stale. Check free RAM first: the memo holds 1.2 GB.
  2. In `stageStatus`, memoize `readSeeds`, `topoOrder(skills())`, and
     `readTable(SKILL_LIST)` the way `skills` already is.

- [ ] The first `embed` run spends no time on queue upkeep. `embedBatch`
      (`lib.ts`) shares a 392k queue across 8 workers with `queue.shift()`,
      which is O(n) per call.
  1. Replace the queue with a shared index: `let next = 0`, and each worker
     takes `missing[next++]` while `next < missing.length`.

- [ ] The code is about 150 lines smaller, with identical output. Run
      `deno task test` after each step.
  1. `prereq.ts:1782`: delete `emittedSet` and the orphan-edge check. It cannot
     fire: a skipped skill has no dependents, and the `EDGES` read already
     checks every id.
  2. Orphan fix (`prereq.ts:1082`): `wordToSkills` stores id arrays only to
     count stop words. Count tokens instead. A candidate is a token `w` with
     `skill.has(w)`. Sort by `heurUseCount`, then raw, stable. Delete the
     constant score.
  3. Delete `sigTok2` (`prereq.ts:1163`). It equals `orphanTitleTok`.
  4. Delete `sigTokens` (`graph.ts:921`). It equals `titleTokSet`. Check whether
     the `sigTokens` in `lib.ts:1930` is a third copy.
  5. `stageTag`: the direct ESCO and O\*NET merge appears three times. Add one
     local `withDirect(picked, direct, cap)`: dedupe by slug, prepend at score
     1.0, slice to cap.
  6. Add `gunzipText(path, fix)` to `lib.ts`. Call it from `readBncc`, the Cert
     Atlas block, and `readLearningCommons`, which repeat the same `gzip -dc`
     call and error text.
  7. Pilot `shortlist` (`prereq.ts:1992`) scans all vocab by hand. Use `ivfTop`
     as stage `prereq` does. Add a `REVIEW:` note: the shortlist is now
     approximate. Alternative: keep the exact scan, at about 70 ms a name, and
     the pilot then differs from production.

- [ ] A CSP standard and an OpenSALT standard with the same code are one skill,
      and the readme credits each CSP set's licence.
  1. Stage `dedupe` merges a CSP row and an OpenSALT row that carry the same
     `code:*` tag before the cosine pass.
  2. Readme: CSP attributions per set licence (CC BY 4.0 US, CC BY 3.0 US).

- [ ] A skill's band says when a typical learner can first learn it. Sanity fit
      is 10/23 at 93k and 13/23 at CSP scale (goal 80%). Decision (you, 14 Nov):
      run the median experiment before your row check. Decision (you, 11 Nov):
      no college-level anchors. CSP fixes `probability`, `budgeting`, `typing`,
      and `spreadsheets`. Misses at CSP scale: `nutrition` 13, `grammar` 12,
      `drawing` 9, `chemical-reactions` 11, `machine-learning` 12. A merged
      skill anchors at the lowest grade of its standards, so CSP pulls some
      down: `reading-comprehension` K, `pythagorean-theorem` grade 7,
      `project-management` grade 6. Rejected at 93k: a topic pool under 15
      anchors falls back to all anchors (sanity same, Kendall τ 0.85 → 0.81).
  1. Try the median grade of a merged skill's standards as its anchor, not the
     lowest, and rescore sanity and Kendall τ at CSP scale.
  2. You check the rows that CSP contradicts: `reading-comprehension` (CCSS has
     K reading standards), `pythagorean-theorem`, `project-management`, and the
     `data/_sanity.tsv` `REVIEW:` note in `pipeline.ts`.

## Blocked on you

- [ ] A course-catalog seed never puts a college requirement before a school
      concept: `academic-writing → drawing`, `songwriting → music-theory`,
      `medical-nutrition-therapy → nutrition`, `calculus → probability`. These
      are course seeds, not named prereqs: only 18 named edges put a
      specialisation first. Blocker: the CSP prereq run, since recall decides
      it. Dropping every course seed is rejected: at CSP scale recall falls 54 →
      31 and sanity stays 13/23. 97% of course pairs come from one institution,
      so a two-institution rule drops nearly all of them.
  1. Read the 80 course seeds that conflict with an anchor at CSP scale
     (`seed_anchor_conflicts_by_source` in the workspace's `4_stats.json`), and
     find a rule that drops those without the recall loss.

- [ ] Skills from every Common Standards Project (CSP) set appear in
      `skills.tsv`. Stage `list` parses them, and `build/2_cache.bin` holds
      their embeddings. Blocker: your go on the LLM spend (you, 14 Nov: timings
      approved, spend held). Decision: every current set; the 1,508 sets that
      state no licence count as permitted for now (you, 10 Nov).
  1. Run the full chain with `.env` loaded: stage `prereq` sends about 116M
     input and 59M output tokens.

- [ ] ASN standards that CSP lacks appear in `skills.tsv`. Blocker: ASN's reply.
      You sent the bulk-access request through
      `asn.desire2learn.com/content/contact-us` (12 Nov).
  1. Only single documents download
     (`asn.desire2learn.com/resources/{id}_full.json`). CSP first imported its
     states from ASN, so ASN adds mostly duplicates.

- [ ] England's school curriculum (Oak National Academy, KS1–KS4, 17 subjects)
      appears in `skills.tsv`, with unit order as seed edges. Blocker: the API
      key you requested (12 Nov), by email. Put it in `.env` as `OAK_API_KEY`.
      Keys do not expire. Calls send `Authorization: Bearer <key>`.
  1. Fetch the bulk JSON per subject and phase. Before you parse it, check one
     file for quiz fields: the schema has none, but the bulk page lists them.
  2. Each unit becomes a skill. Consecutive units within one `thread` become
     seed pairs.
  3. Resolve each `priorKnowledgeRequirements` string to a skill id with the
     `seed-edges` resolver.
  4. Skip lessons with `restricted: true`. OGL v3 covers the rest.

- [ ] Apprenticeship knowledge, skills, and behaviours (Skills England, levels
      2–7) appear in `skills.tsv`, tagged by occupation. Blocker: the API key
      you requested (12 Nov), granted at Skills England's discretion, by email.
      Put it in `.env` as `SKILLS_ENGLAND_API_KEY`. The licence (OGL v3)
      requires the Skills England logo and "© Skills England 2025" on every
      derived product. Decision: sponge carries the logo.
  1. `GET occupational-maps-api.skillsengland.education.gov.uk/api/v1/Occupations`
     with header `X-API-KEY`, then each `/Occupations/{stdCode}`.
  2. Each `knowledges`, `skills`, and `behaviours` item becomes a skill. Its
     standard's `level` is a difficulty anchor, and `soc` links the occupation.
  3. `/OccupationalProgression/{stdCode}` gives `stdCodeFrom → stdCodeTo`
     occupation edges. Keep them out of the skill DAG.
