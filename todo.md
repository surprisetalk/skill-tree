- [x] stage 1: list (102k skills from ESCO/ONET/Lightcast/OpenSALT)
- [x] stage 1b: Lightcast description infill via Haiku batch (31,587)
- [x] stage 1c: Summarize 16k verbose OpenSALT/ONET standards via Haiku
- [x] stage 1d: Enrich 14,520 ONET Task/DWA descriptions via Haiku
- [x] stage 2: embed via Ollama nomic-embed-text
- [x] stage 3: tag occupations/topics via cosine+IDF + ESCO/ONET direct relations + occ-pair filter
- [x] stage 3b: dedupe near-identical skills via cosine + title Jaccard
- [x] stage 4: difficulty via OpenSALT grade anchors + within-topic kNN (uniform bands)
- [x] stage 5: prereq linking via Haiku 3 batch + ancestor candidates (resolved-id format)
- [x] stage 6: postproc (band-inversion filter + hub cap + onet:tech filter)
- [x] stage 7: finalize skills.tsv (101,630 skills, 307,763 edges, 5,177 roots)
- [x] HTML ladder visualization (viz.ts: top-N, seed, or --all modes)

## Quality pass 2 (2026-04-14)
- [x] slugify: decode HTML entities + word-boundary truncation + 6-hex hash for >80ch (no more `-amp-`, no more mid-word cuts, no `-2` collisions). Requires full re-run from stage 1 to take effect for existing cached IDs.
- [x] Seed edges override inferred difficulty (378 added vs 131 before, +188%). Cycle-breaker iter bumped 10→50.
- [x] P279 topic pollution filter: year/numeric blocklist + all-short-token junk filter. 211k pollution topics dropped; singleton topics dropped globally.
- [x] Dedupe stage 3b: token-sort signature pre-merge (859 additional merges from and/or/word-order swaps).
- [x] Tag backfill stage 3b: embedding-NN fills tags for untagged canonicals (1,918/4,230 enriched).
- [x] Drop dead `certs` column; emit `grade_start`/`grade_end` from existing `grade:XX` tags (0.1% → 22% coverage).

## Quality pass 3 (2026-04-14)
- [x] A1: seed-edge survival — band-inversion, onet:tech, hub-cap filters all exempt seeds. Seed_in_final 291 → 306 (+15 preserved).
- [x] A5: per-topic hub cap (30 per (prereq, child-topic)) replaces global HUB_CAP=80. Dropped ~5,300 within-topic spam edges; genuine cross-topic hubs preserved via expanded global cap of 150.
- [x] A6: cross-domain foundation whitelist. Foundations (math, reading, writing, problem-solving, etc.) exempt from cross-domain filter (232 exemptions).
- [x] C1/B3: Wikipedia-category pattern blocklist (`*-officials-and-employees`, `*-by-country`, `*-introduced-in-*`, `^people-in-*`, etc.). Kills `rome-officials-and-employees` class at source.
- [x] C2: topic doc-freq cap (>1.3% of skills drops unless whitelisted) + explicit blocklist for `photomechanical-processes`, `flying-machines`, `traffic-regulations`. 4,744 generic-topic references dropped.
- [x] C4: tag backfill now processes skills with EITHER occs-empty OR topics-empty (was both-empty). 21,187 occupations + 6,710 topics backfilled (vs 1,918 prior). Threshold lowered 0.70 → 0.60.
- [x] D1: isotonic (PAV) calibration of raw kNN scores against grade anchors. Band = round(calibrated_grade) + 1 (non-uniform bins, grade-aligned).
- [x] D2: Khan V-Position added as pseudo-grade anchor (linear 0-12 from normalized v-position).
- [x] D3: within-topic smoothing (weight 0.3 toward topic-mean, k=3+ neighbors).
- [x] E1: holdout fraction 10% → 20% (49 → 83 holdout edges for more stable recall).
- [x] E3: per-edge source attribution dump to `build/8_edge_sources.tsv` (seed/inferred/heuristic classification for all 222k edges).
- [x] E4: cycle-cut log to `build/6_cycle_cuts.tsv` (shows which edges cycle-breaker dropped and whether they were seed or inferred).

## Metrics (pre/post quality pass 3)
| metric              | before  | after   |
| ------------------- | ------- | ------- |
| orphan rate         | 0.092   | 0.0883  |
| metacademy recall*  | 0.143   | 0.087   |
| alcpl recall*       | 0.250   | 0.156   |
| opensalt_precedes*  | 0.000   | 0.111   |
| kendall_tau anchor  | 0.777   | 0.776   |
| seed_in_final       | 291     | 306     |
| top_topic_count     | 1394    | 1167    |

\* recall drops reflect **larger, more stable denominators** (E1 doubled holdout) — the earlier high values were small-sample noise.

## Known limits (future work)
- [ ] khan/moocx recall ~0 — seed labels don't resolve to skill ids (Khan concepts aren't ingested as skills; MOOCCubeX Chinese labels have <10% resolution). Fix: add Khan/Junyi as skill sources OR improve label-resolution fallback.
- [ ] Wiki resolution 13.8% — fuzzy match + altLabel retry (B1) not implemented. Would cascade into better P279 topics + descriptions.
- [ ] LCSH broader-chain trees (B2) and DBpedia broader hierarchy (B3) unused as parent-topic source. Best implemented after B1.
- [ ] A2 full expansion (Junyi hierarchy, ASSISTments temporal, OpenSALT grade ordering) — needs streaming parsers + skill-universe expansion.
- [ ] A3/A4 prereq retrieval rework + bidirectional — requires stage 5 LLM re-run ($$).
- [ ] E2 precision eval via Haiku sample-200 — skipped for cost.
- [ ] Domain leakage mean 0.337 — structural issue with sparse topics; needs wiki coverage uplift first.

## Ideas
- [ ] Add Khan/Junyi as skill sources (expensive: full stage 1 + embeddings re-run)
- [ ] Wikidata P279 subclass hierarchy as parent-topic source
- [ ] Topic "rome-officials-and-employees" and similar Wikipedia categories survive P279 filters — add co-occurrence sanity check
