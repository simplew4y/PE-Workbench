import assert from "node:assert/strict";
import test from "node:test";
import { connectedReviewChanges } from "./iteration-review-groups.ts";

test("explicit batch review includes transitive and reverse dependencies without independent groups", () => {
  const changes = [
    { id: "judgment", groupId: "judgment", dependencies: ["summary"] },
    { id: "reason", groupId: "judgment", dependencies: [] },
    { id: "summary", groupId: "summary", dependencies: ["valuation"] },
    { id: "valuation", groupId: "valuation", dependencies: [] },
    { id: "independent", groupId: "unrelated", dependencies: [] },
  ];
  for (const change of changes.slice(0, 4)) assert.deepEqual(connectedReviewChanges(changes, change).map((entry) => entry.id), ["judgment", "reason", "summary", "valuation"]);
  assert.deepEqual(connectedReviewChanges(changes, changes[4]).map((entry) => entry.id), ["independent"]);
});

test("dependency cycles terminate and preserve display order", () => {
  const changes = [{ id: "first", groupId: "one", dependencies: ["two"] }, { id: "second", groupId: "two", dependencies: ["one"] }];
  assert.deepEqual(connectedReviewChanges(changes, changes[1]), changes);
});
