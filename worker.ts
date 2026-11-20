/// <reference lib="deno.worker" />
// One job of inWorkers (lib.ts) per worker: it does its share, replies, and
// exits.
import { type NearestShare, nearestShare } from "./lib.ts";
import { type CandidateShare, candidateShare } from "./prereq.ts";

self.onmessage = (e: MessageEvent<CandidateShare | NearestShare>) => {
  const m = e.data;
  self.postMessage(m.job === "nearest" ? nearestShare(m) : candidateShare(m));
};
