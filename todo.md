## Next

Each entry below is a `deno task status` condition that fails, or a stage that
is not built. Rerun one stage: `sh build/chain/chain.sh <stage>` (load `.env`
first for `enrich` and `prereq`).

- [ ] A skill's band says when a typical learner can first learn it. Today 10/23
      sanity skills fit (goal 80%). 42k unanchored skills pile into band 11: no
      anchor sits above grade 12. Decision (you, 11 Nov): no college-level
      anchors; long chains carry skills past 12. Stage `finalize` now lifts each
      unanchored skill a band above its prereqs. On the 11 Nov graph it moves
      21k skills 1-2 bands and no sanity row: chains are short
      (`machine-learning ← economic-statistics ← numeracy`). Recall builds them.
  1. After the recall entry lands, rebuild and read the sanity rows again.
  2. Correct the sanity rows only if a row is wrong, as the `REVIEW:` note in
     `pipeline.ts` asks; never to fit the build.

- [ ] Expert recall is above 0.05 (`EXPERT_RECALL_FLOOR`). Today 6/258; it
      needs 13. Retrieval cannot reach cross-domain prereqs. Trial (11 Nov,
      Haiku 5.5, scratch caches): Claude names up to 8 prereqs per skill, each
      snaps to a skill. On the 85 dependents of the 252 missed pairs it named 28
      expert prereqs; 14 pass the `easier` guard. Of its picks that hit an
      annotated LectureBank pair, 29 are positive and 37 negative. On 85 control
      skills, 70% of names snap, and the samples read right
      (`thermodynamics →
      develop-energy-saving-concepts`).
  1. The guard blocks half the picks, 90% of them with an unanchored dependent
     in the band-11 pile, and all 14 lost expert pairs. Let a named prereq of an
     unanchored skill skip the guard; the chain lift then orders the bands. Keep
     the guard when the dependent has an anchor.
  2. Add the expand-and-snap source to stage `prereq`: its picks join the
     candidate picks in `5_prereqs.tsv`. Cache snaps by name slug, so names
     repeat for free.
  3. A full run sends about 3× the input tokens of a prereq re-ask (3.5k in, 400
     out per skill). Then rebuild and score recall, precision, and the sanity
     rows.

- [ ] A full build finishes in under 2 hours of compute at the CSP scale: 364k
      skills, about 290k grade anchors. Decision (you, 10 Nov): performance
      first, then a review together, then all of CSP. Done at 93k: kNN stride
      sample (326 s → 55 s); candidates use an IVF index for big pools (cosine
      top 7× faster, pool Jaccard 0.966) and a token index for the cross-topic
      pool. The IVF build takes 55 s and grows with n·√n.
  1. Measure at scale in a jj workspace: apply side commit `lopuqmnx` (the CSP
     parse), then run `list` through `prereq` with `SKIP_LLM=1`, and time each
     stage. Ollama must embed about 269k new titles first.
  2. Stop for the review with the timings and the new status numbers.

- [ ] Stages `prereq` and `pilot` classify with Cloudflare Clef where it beats
      Haiku 5.5 on accuracy or cost. Clef is a decision model (Apache 2.0, on
      Workers AI or self-hosted): it answers up to 64 typed questions in one
      pass, as probabilities over fixed choices.
  1. Confirm the facts on Cloudflare's own model card and Workers AI pricing:
     the question limit, the choice format, and the price per 1k calls.
  2. Try the snap step first: one question, choices `none` and `1`–`10`. Compare
     with the Haiku answers in `build/pilot_snap.tsv`.
  3. Then the prereq pick: one yes/no question per candidate (15 per call). A
     probability gives a cut point; score it with LectureBank precision and
     recall.

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
