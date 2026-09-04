# Relationship Diagrams

Use `relationship_map` only when relationships are more important than prose order.

Good cases:

- parent company, subsidiaries, and business segments;
- buyer, target, seller, and financing parties;
- raw materials, production, distribution, and customers;
- source document, extracted fact, conclusion, and unresolved question;
- dependencies between risks and operating indicators.

## Construction rules

- Keep node labels short.
- Use stable ASCII IDs unrelated to display labels.
- Prefer 3-10 nodes; 16 is a hard ceiling.
- Every edge must have a clear direction.
- Add an edge label only when the relationship is not obvious.
- Do not fabricate ownership percentages, control relationships, or transaction links.
- If the graph becomes dense, split it into two surfaces that answer different questions rather than producing a hairball.
