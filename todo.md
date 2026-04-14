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

## Known limits (future work)
- [ ] 5.1% orphan rate — mostly peer-orphan leaves (javascript's only candidates are sibling languages, LLM rightly rejects). Fix needs true topic hierarchy (Wikidata P279 etc.)
- [ ] Some occupation tags still reflect embedding bias more than truth (e.g. `computer-numerically-controlled-tool-operators` on generic skills)
- [ ] Dedupe is conservative (cosine 0.96 + Jaccard 0.7); some genuine duplicates remain

## Ideas
- [ ] which skills are most valuable? use occupation salaries
- [ ] ucsd map of science visualization
- [ ] Wikidata P279 subclass hierarchy as parent-topic source
