import type { IterationChange } from "@earendil-works/pe-boot";

export function connectedReviewChanges(changes: readonly IterationChange[], selected: IterationChange): IterationChange[] {
  const groups = new Set([selected.groupId]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const change of changes) {
      if (!groups.has(change.groupId) && !change.dependencies.some((group) => groups.has(group))) continue;
      for (const group of [change.groupId, ...change.dependencies]) {
        if (!groups.has(group)) { groups.add(group); expanded = true; }
      }
    }
  }
  return changes.filter((change) => groups.has(change.groupId));
}
