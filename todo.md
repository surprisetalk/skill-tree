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
- [x] A1: seed-edge survival — band-inversion, onet:tech, hub-cap filters all exempt seeds. 12 more seed edges preserved.
- [x] A5: per-topic hub cap (30 per (prereq, child-topic)) replaces global HUB_CAP=80. 5,318 within-topic spam edges dropped; genuine foundational hubs preserved via expanded global cap of 150.
- [x] A6: cross-domain foundation whitelist. Foundations (math, reading, writing, problem-solving, etc.) exempt from cross-domain filter (232 exemptions).
- [x] C1/B3: Wikipedia-category pattern blocklist (`*-officials-and-employees`, `*-by-country`, `*-introduced-in-*`, `^people-in-*`, etc.). Kills `rome-officials-and-employees` class at source.
- [x] C2: topic doc-freq cap (>1.3% of skills drops unless whitelisted) + explicit blocklist for `photomechanical-processes`, `flying-machines`, `traffic-regulations`. 4,744 generic-topic references dropped.
- [x] C4: tag backfill now processes skills with EITHER occs-empty OR topics-empty (was both-empty). 21,187 occupations + 6,710 topics backfilled (vs 1,918 prior). Threshold lowered 0.70 → 0.60.

## Known limits (future work)
- [ ] khan/moocx/opensalt_precedes recall still 0 — seed labels don't resolve to skill ids (Khan concepts aren't ingested as skills; MOOCCubeX Chinese labels have <10% resolution). Fix: add Khan/Junyi as skill sources OR improve label-resolution fallback.
- [ ] metacademy 0.143, alcpl 0.25. Cycle-breaker drops ~29 seed edges (all-seed SCCs). A2 full expansion (Junyi hierarchy, ASSISTments temporal, MOOCCubeX pairs, CSP grade ordering) deferred — needs streaming parsers + skill-universe expansion.
- [ ] Difficulty still uniform-banded (20 buckets of ~5050) — isotonic regression against grade anchors not implemented (D1-D3).
- [ ] Wiki resolution 13.8% — fuzzy match + altLabel retry (B1) not implemented.
- [ ] LCSH broader-chain trees (B2) and DBpedia hierarchy (B3) unused as parent-topic source.
- [ ] Orphan rate 9.1% (down from 9.2%). Peer-orphan leaves persist.
- [ ] Domain leakage mean 0.337 — structural issue with sparse topics; needs wiki coverage uplift first.

## Ideas
- [ ] A3+A4: expand stage 5 retrieval to topic-embedding peers + bidirectional verify (no new LLM calls)
- [ ] E1-E4: increase holdout to ≥500 edges; precision eval via Haiku sample-200; per-edge source/confidence dump
- [ ] Add Khan/Junyi as skill sources (expensive: full stage 1 + embeddings re-run)
- [ ] Wikidata P279 subclass hierarchy as parent-topic source
