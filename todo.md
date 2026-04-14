- [x] stage 1: list (103k skills from ESCO/ONET/Lightcast/OpenSALT)
- [x] stage 1b: Lightcast description infill via Haiku batch (31,587)
- [x] stage 1c: Summarize 16k verbose OpenSALT/ONET standards via Haiku
- [x] stage 2: embed via Ollama nomic-embed-text
- [x] stage 3: tag occupations/topics via cosine+IDF + ESCO/ONET direct relations
- [x] stage 4: difficulty via OpenSALT grade anchors + within-topic kNN
- [x] stage 5: prereq linking via Haiku 3 batch (347k raw edges, 0 cycles)
- [x] stage 6: postproc (hub cap + onet:tech filter → 332k final edges)
- [x] stage 7: finalize skills.tsv (100% reachable from 3,646 roots)

## Known limits (future work)
- [ ] orphan leaves like `javascript` whose top-K candidates are all peers; needs
      candidate selection from parent-topic skills (ancestor inclusion)
- [ ] difficulty bands lumpy (band 18 spike, bands 19 empty) due to raw
      value clustering; quantile binning at quantile edges ties
- [ ] 3.6% orphan rate; mostly tech tools with no earlier peers

## Ideas
- [ ] which skills are most valuable? use occupation salaries
- [ ] ucsd map of science visualization (https://journals.plos.org/plosone/article/figures?id=10.1371%2Fjournal.pone.0039464)
- [ ] render ladder HTML visualization
- [ ] dedupe near-identical titles via embedding cosine
- [ ] Wikidata P279 subclass hierarchy as a parent-topic source
