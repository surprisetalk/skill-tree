- [ ] let's redo everything from scratch
  - skills:id,title,description,difficulty,prereqs[],occupations[],topics[],certs[]
    - invert-binary-tree\tinvert a binary tree\t...\t41,40\tprogrammer\tcs,math\tcissp
  - sources
    - professional: ESCO, O*NET, lightcast
    - k-12: csp, opensalt
    - topics (for tags): wikipedia, lcsh, dbpedia
  - goal: every skill can be reached from base kindergarten skills
  - avoid: cycles, highly connected nodes, subjectivity
  - note: professions/occpuations are TAGS on nodes, not nodes themselves. we want to minimize the number of occupation tags on each node, and minimize number of covering nodes per tag.
  - pipeline
    1. list skills
    2. calc embeddings
    3. guess occupations,topics,certs based on embeddings
    4. difficulty 1-20 using random ranking competitions
    5. link prereqs by cluster, working backward from most difficult to least difficult
    6. clean/compress/infill

- [x] Universal knowledge backbones. **LCSH and DBpedia downloaded.** Wikidata (https://www.wikidata.org) is arguably the single most valuable resource—100+ million items with 1+ billion relationships, completely free under CC0. Its P279 (subclass of) hierarchy already forms a massive knowledge DAG, and it interlinks with nearly every other knowledge system via dedicated properties. Query it via SPARQL at https://query.wikidata.org. The Library of Congress Subject Headings (LCSH) provide ~340,000 authority records with broader/narrower/related term relationships, downloadable as SKOS/RDF from https://id.loc.gov/ Wikipediadownload/—a clean, freely available subject graph spanning all fields. DBpedia (https://www.dbpedia.org) offers a 768-class, 3,000-property cross-domain ontology explicitly structured as a DAG (classes may have multiple superclasses since v3.7), with 228M+ entities, all under CC BY-SA. Wikipedia's category graph contains ~1.7 million categories Wikiworkshop but requires significant cleaning (it contains cycles and administrative categories); access via SQL dumps at https://dumps.wikimedia.org or the wikicat Python library (https://github.com/xhluca/wikicat). GitHub
- [x] Skills and competency taxonomies. ESCO (https://esco.ec.europa.eu) is the European Commission's taxonomy of 13,890+ skills/competence concepts linked to ~3,000 occupational profiles, downloadable in RDF/CSV/JSON-LD under the EUPL license in 28 languages. O*NET (https://www.onetcenter.org/database.html) provides public domain taxonomies of 33 knowledge areas, 35 skills, and 52 abilities across 1,016 occupations with quantitative importance ratings—downloadable as tab-delimited files, updated quarterly. Lightcast Open Skills (https://lightcast.io/open-skills) offers 32,000+ skills extracted from hundreds of millions of job postings in a 3-tier hierarchy, updated biweekly. Learn & Work Ecosystem Library
- [x] Prerequisite and dependency datasets. MOOCCubeX (https://github.com/THU-KEG/MOOCCubeX) from Tsinghua University is the richest open prerequisite dataset: 4,216 courses, 637,572 concepts, and explicit prerequisite relations in CS, math, and psychology, with 296M+ behavioral records. Semantic Scholar The Liang et al. (2017) University Course Dataset provides 1,008 annotated concept prerequisite pairs. Semantic Scholar The Course-Skill Atlas (Nature Scientific Data, 2024: https://www.nature.com/articles/s41597-024-03931-8) maps skills from 3+ million course syllabi at ~3,000 U.S. institutions to O*NET categories. LectureBank (Li et al., AAAI 2019) provides 1,352 lecture files with 208 labeled prerequisite relations for NLP education. Semantic Scholar
- [x] https://github.com/THU-KEG/EDUKG
- [x] Common Standards Project API — all 50 US state standards in unified JSON (api.commonstandardsproject.com). CC BY 3.0 US.
- [x] ASN CCSS Math + ELA — Common Core standards as JSON-LD from ASN (documents D10003FB, D10003FC). Note: ASN direct downloads currently return 403; data cached locally.
- [ ] LearningQ (Khan Academy topic tree) — github.com/AngusGLChen/LearningQ has crawlers but no hosted data. KA API is dead (removed July 2020). Data would need to be obtained by contacting authors (angus.glchen@gmail.com).
- [ ] Achieve the Core Coherence Map — CCSS Math connections. Data locked behind achievethecore.org web UI, no bulk export. Source code at github.com/achievethecore/atc-coherence-map (CC0) but data endpoint is internal.
- [ ] Gooru Learning competency map — open-source adaptive learning platform (gooru.org). API-only, no bulk data export available.
- [x] use library categories (LCSH: 511k subjects, 298k broader prereq edges integrated)
- [x] DBpedia category hierarchy (~1.47M categories, ~3M broader edges integrated as taxonomy_edges.tsv)
- [x] Course-Skill Atlas top10_DWA_per_FOS bridge (62 fields of study linked to O*NET DWAs)
- [ ] Wikidata P279 subclass hierarchy — highest-value missing source. Requires dedicated data/wikidata.ts script to produce a cached subset (SPARQL batch or filtered dump). 20GB+ raw, ~200MB P279-only subset. Defer until needed for cross-domain skill mapping.
- [ ] Paul Otlet's Mundaneum (1895–1934) Wikipedia scaled to 15.8 million index cards Wikipedia with the Universal Decimal Classification, whose synthetic notation could express relations between subjects rather than just hierarchical containment. JSTOR Otlet even envisioned personal workstations ("Mondothèques") combining reference works, catalogs, and screens—essentially personal computers decades before the technology existed. History-Computer The project was destroyed by Nazi forces in 1940. SOCKS H.G. Wells proposed the "World Brain" (1937)—a continuously updated, expert-maintained World Encyclopedia. Wikipedia Vannevar Bush's Memex (1945) introduced "associative trails" linking related documents, AbeBooks directly inspiring hypertext.
- [ ] Modern visualization efforts include Katy Börner's UCSD Map of Science (with Boyack and Klavans)—a data-driven consensus map Springer clustering 554 subdisciplines into 13 disciplines PLOS from 10 years of citation data, published in PLoS ONE (2012). GitHub The map reveals that disciplines form a continuous circle rather than discrete clusters, NCBI with biochemistry as the most interdisciplinary field. Börner's Atlas trilogy (MIT Press, 2010/2015/2021) remains the definitive reference on science mapping. Wikipedia Dominic Walliman's "Domain of Science" YouTube channel and poster series DFTBA (Map of Mathematics, Physics, Chemistry, Computer Science, Biology) provide beautiful single-field overviews My Modern Met but no unified cross-domain graph. Open Knowledge Maps (https://openknowledgemaps.org) generates AI-driven visual maps from the 100 most relevant papers on any topic, ResearchGate querying PubMed or BASE's 270M+ documents.
- [ ] https://github.com/ThoAppelsin/bu-prerequisite-tree // love this ladder visualization
- [ ] first deliverable: compose all the skills into a big ladder thing as an html file (or digraph, which we can generate html from)
- [ ] https://github.com/md-nobin/Skill-Tree
- [ ] ucsd map of science https://journals.plos.org/plosone/article/figures?id=10.1371%2Fjournal.pone.0039464 https://github.com/Science-Integrity-Alliance/science-map
- [ ] which skills are most valuable? use occupation salaries
- [x] USE VECTOR EMBEDDINGS TO MERGE SKILLS
- [x] let's run every skill through a local llm to fill out more cols/dims and then use a local llm to find prerequisite pairs (infer_prereqs.ts: Dice similarity candidate selection + Claude Haiku confirmation, cached to data/llm_prereqs.json)
- [x] graph-quality pipeline (pipeline.ts): dedup_standards → csp_hierarchy → semantic_bridges → csp_refine_grades → break_cycles → validate. Orphan rate 72.6% → 5.7%, 0 cycles.

