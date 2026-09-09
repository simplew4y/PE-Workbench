import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
describe("consensus card UI",()=>{it("uses remote card sources for citation",async()=>{const s=await readFile(new URL("./PeConsensusCard.tsx",import.meta.url),"utf8");assert.match(s,/PeSourceCitation/u);assert.match(s,/evidence_ids/u);assert.match(s,/issuer_count/u);assert.match(s,/recent_changes|root_cause/u);});});
