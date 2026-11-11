## Next

Each entry below is a `deno task status` condition that fails, or a stage that
is not built. Rerun one stage: `sh build/chain/chain.sh <stage>` (load `.env`
first for `enrich` and `prereq`).

- [ ] A skill's band says when a typical learner can first learn it. Today 10/23
      sanity skills fit (goal 80%). 42k unanchored skills pile into band 11: no
      anchor sits above grade 12, so a workplace or college skill averages its
      high-school neighbors. Fewer neighbors and a steeper weight both leave the
      pile (cos^8 kept: τ 0.73 → 0.85). Decision (you, 11 Nov): no college-level
      anchors.
  1. The sanity rows above grade 12 (`machine-learning` 13-16, `accounting`
     10-13) cannot fit with K-12 anchors only. Correct those rows in
     `data/_sanity.tsv`, as its `REVIEW:` note in `pipeline.ts` asks.
  2. Then read the K-8 misses (`drawing` band 10, `nutrition` 12,
     `reading-comprehension` 12): find which anchors pull each one up.

- [ ] Difficulty bands agree with seeds: under 1% of seed pairs fail to fit
      bands 1–20. Today 76/5,876 (1.3%): khan 34, learningcommons 13.
  1. Read `seed_anchor_conflict_samples` in `build/4_stats.json` per source.
     Khan pairs such as
     `add-within-20(3) > solving-addition-and-subtraction-word-problems(2)` come
     from a merge of a K and a grade-1 standard; fix the merge or the anchor at
     its source.

- [ ] Expert recall is above 0.05 (`EXPERT_RECALL_FLOOR`). Today 6/258; it
      needs 13. On 12 missed pairs (11 Nov): 7 prereqs never enter the candidate
      pool, 5 sit in the wrong band order, and every prereq that was in the pool
      got picked and kept. Pools hold topic and cosine neighbors (K-2 "count
      objects in a circle" for `image-processing`); a cross-domain prereq
      (`linear-algebra → computer-vision`) is near neither. A band-gap cap (8)
      cleared the K-2 noise but brought in no expert prereq.
  1. Add one-level expand-and-snap as a candidate source: Claude names up to 8
     prereqs of each skill, each name snaps to a skill (the pilot's snap), and a
     "none" drops. No recursion, so no drift. Try it on the 252 missed pairs'
     dependents before a full run.
  2. The 5 band-order misses are sense merges ("paraphrasing" NLP vs K-12): list
     them after step 1.

- [ ] A full build finishes in under 2 hours of compute at the CSP scale: 364k
      skills, about 290k grade anchors. Today `difficulty` and the `prereq`
      candidate pools scan skills times anchors. Decision (you, 10 Nov):
      performance first, then a review together, then all of CSP.
  1. Timings at 93k (stage logs print them): `difficulty` kNN 326 s of 326 s,
     with 19,003 skills on the global fallback over 30k anchors. Candidates:
     cosine top 744 s, cross-topic 271 s, topic pool 32 s, full scan 27 s;
     27,613 of 93,485 skills take the full scan.
  2. Done for kNN: a stride sample of at most 2,000 anchors per skill (326 s →
     55 s; 1.8% of bands moved by more than 2). Not for candidates: a stride
     sample of 3,000 kept mean Jaccard 0.74 on 935 skills, so exact pools stay.
     Bound them with a nearest-neighbor index (HNSW library, or a token index),
     and measure the cross-topic pool build (438 s), which iterates every topic
     per skill.
  3. Measure at scale in a jj workspace: apply side commit `lopuqmnx` (the CSP
     parse), then run `list` through `prereq` with `SKIP_LLM=1`, and time each
     stage. Ollama must embed about 269k new titles first.
  4. Stop for the review with the timings and the new status numbers.

## Blocked on you

- [ ] Skills from every Common Standards Project (CSP) set appear in
      `skills.tsv`. Blocker: the performance entry, then your review. Decision:
      every current set; the 1,508 sets that state no licence count as permitted
      for now (you, 10 Nov). Side commit `lopuqmnx` grows `1_skills.tsv` from
      95,375 to 364,519 rows.
  1. Rebase `lopuqmnx` onto main. It parses leaf standards of current sets,
     treats a parent as a heading, tags grades when a set names at most 4, and
     skips a notation that lists several codes.
  2. Stage `prereq` then sends about 116M input and 59M output tokens.
  3. Stage `dedupe` merges a CSP row and an OpenSALT row that carry the same
     `code:*` tag before the cosine pass.
  4. Readme: CSP attributions per set licence (CC BY 4.0 US, CC BY 3.0 US).

- [ ] `deno task status` also scores prereq edges against Junyi crowd labels.
      Blocker: a PSLC DataShop login. You make the account.
  1. Fetch dataset 1198 `relationship_annotation_training.csv` (1,131 pairs). It
     is non-commercial, so use it for eval only.
  2. Score it with the LectureBank precision and recall code.

- [ ] ASN standards that CSP lacks appear in `skills.tsv`. Blocker: ASN bulk
      access needs your email request.
  1. Only single documents download
     (`asn.desire2learn.com/resources/{id}_full.json`). Bulk needs the batch
     service. CSP first imported its states from ASN, so ASN adds mostly
     duplicates.

- [ ] Delete the CSP API key from git history, or confirm that it is CSP's
      public demo key. Blocker: you. Commit `4724493^` holds a hardcoded
      `api-key` in `data/download.ts`, and `origin/main` already has that
      commit. A history rewrite changes every later commit hash.
  1. Check whether the key belongs to your CSP account.
  2. If yes: rotate it at CSP. The API answers without a key today, so new code
     sends none.

- [ ] England's school curriculum (Oak National Academy, KS1–KS4, 17 subjects)
      appears in `skills.tsv`, with unit order as seed edges. Blocker: a free
      API key through Oak's HubSpot form. You request it.
  1. Fetch the bulk JSON per subject and phase. Before you parse it, check one
     file for quiz fields: the schema has none, but the bulk page lists them.
  2. Each unit becomes a skill. Consecutive units within one `thread` become
     seed pairs.
  3. Resolve each `priorKnowledgeRequirements` string to a skill id with the
     `seed-edges` resolver.
  4. Skip lessons with `restricted: true`. OGL v3 covers the rest.

- [ ] Apprenticeship knowledge, skills, and behaviours (Skills England, levels
      2–7) appear in `skills.tsv`, tagged by occupation. Blocker: a free API
      key, granted at Skills England's discretion. The licence requires the
      Skills England logo and attribution on every derived product. Decision:
      sponge carries the logo. You request the key.
  1. `GET /api/v1/Occupations` with header `X-API-KEY`, then each
     `/Occupations/{stdCode}`.
  2. Each `knowledges`, `skills`, and `behaviours` item becomes a skill. Its
     standard's `level` is a difficulty anchor, and `soc` links the occupation.
  3. `/OccupationalProgression/{stdCode}` gives `stdCodeFrom → stdCodeTo`
     occupation edges. Keep them out of the skill DAG.
