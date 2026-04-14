- [x] let's redo everything from scratch
  - skills:id,title,description,difficulty,prereqs[],occupations[],topics[],certs[]
  - pipeline stages 1-4 shipped (list, embed, tag, difficulty)
  - 103,736 skills from ESCO/ONET/Lightcast/OpenSALT
  - Lightcast infilled via Claude Haiku batch (31,587 defs)
  - ONET Tasks/DWAs/Tech added
  - ESCO+ONET direct occupation/topic relations
  - Within-topic kNN for difficulty

- [ ] stage 5: link prereqs by cluster, working backward most→least difficult (local LLM picker from k nearest-easier neighbors)
- [ ] stage 6: clean/compress/infill final output

- [ ] which skills are most valuable? use occupation salaries
- [ ] ucsd map of science https://journals.plos.org/plosone/article/figures?id=10.1371%2Fjournal.pone.0039464 https://github.com/Science-Integrity-Alliance/science-map
- [ ] first deliverable: compose all the skills into a big ladder thing as an html file (or digraph, which we can generate html from)
- [ ] LearningQ / Achieve the Core / Gooru — blocked by paywalls or dead APIs
- [ ] Wikidata P279 subclass hierarchy — deferred
