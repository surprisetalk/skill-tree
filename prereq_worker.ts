/// <reference lib="deno.worker" />
// Stage prereq starts one of these per core: each finds the candidates of its
// share of the skills (`candidateShare`), then exits.
import { type CandidateShare, candidateShare } from "./prereq.ts";

self.onmessage = (e: MessageEvent<CandidateShare>) => {
  self.postMessage(candidateShare(e.data));
};
