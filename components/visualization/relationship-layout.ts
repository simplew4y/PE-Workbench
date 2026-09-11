import type { Edge, Node } from "@xyflow/react";
import type { RelationshipMapComponent } from "../../lib/generative-ui/protocol";

export type ResearchNodeData = {
  label: string;
  group?: string;
  primary?: boolean;
  inputCount: number;
  outputCount: number;
  edgeLabels: string[];
};

const NODE_WIDTH = 190;
const NODE_HEIGHT = 94;
const COLUMN_GAP = 116;
const ROW_GAP = 28;

export type RelationshipLayout = {
  nodes: Node<ResearchNodeData>[];
  edges: Edge[];
  height: number;
};

/**
 * Places a relationship graph by dependency rank instead of input order.
 * The longest path determines each node's column; a barycentric pass keeps
 * connected nodes close together inside the column and reduces crossings.
 */
export function layoutRelationship(component: RelationshipMapComponent): RelationshipLayout {
  const ids = component.nodes.map((node) => node.id);
  const idSet = new Set(ids);
  const incoming = new Map(ids.map((id) => [id, [] as string[]]));
  const outgoing = new Map(ids.map((id) => [id, [] as string[]]));
  const incomingEdges = new Map(ids.map((id) => [id, [] as number[]]));
  const outgoingEdges = new Map(ids.map((id) => [id, [] as number[]]));

  component.edges.forEach((edge, edgeIndex) => {
    if (!idSet.has(edge.from) || !idSet.has(edge.to) || edge.from === edge.to) return;
    outgoing.get(edge.from)?.push(edge.to);
    incoming.get(edge.to)?.push(edge.from);
    outgoingEdges.get(edge.from)?.push(edgeIndex);
    incomingEdges.get(edge.to)?.push(edgeIndex);
  });

  const rank = calculateRanks(ids, incoming, outgoing);
  const layers = new Map<number, string[]>();
  for (const id of ids) {
    const nodeRank = rank.get(id) ?? 0;
    const layer = layers.get(nodeRank) ?? [];
    layer.push(id);
    layers.set(nodeRank, layer);
  }

  const orderedRanks = [...layers.keys()].sort((a, b) => a - b);
  const order = new Map<string, number>();
  orderedRanks.forEach((nodeRank, columnIndex) => {
    const layer = layers.get(nodeRank) ?? [];
    if (columnIndex > 0) {
      layer.sort((left, right) => barycenter(left, incoming, order) - barycenter(right, incoming, order));
    }
    layer.forEach((id, index) => order.set(id, index));
  });

  const maxRows = Math.max(1, ...[...layers.values()].map((layer) => layer.length));
  const contentHeight = maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP;
  const nodes = component.nodes.map((node) => {
    const nodeRank = rank.get(node.id) ?? 0;
    const layer = layers.get(nodeRank) ?? [node.id];
    const rowIndex = layer.indexOf(node.id);
    const layerHeight = layer.length * NODE_HEIGHT + Math.max(0, layer.length - 1) * ROW_GAP;
    return {
      id: node.id,
      type: "research",
      position: {
        x: orderedRanks.indexOf(nodeRank) * (NODE_WIDTH + COLUMN_GAP),
        y: (contentHeight - layerHeight) / 2 + rowIndex * (NODE_HEIGHT + ROW_GAP),
      },
      style: { width: NODE_WIDTH, height: NODE_HEIGHT },
      data: {
        label: node.label,
        group: node.group,
        primary: (outgoing.get(node.id)?.length ?? 0) === 0,
        inputCount: incomingEdges.get(node.id)?.length ?? 0,
        outputCount: outgoingEdges.get(node.id)?.length ?? 0,
        edgeLabels: (outgoingEdges.get(node.id) ?? [])
          .map((edgeIndex) => component.edges[edgeIndex]?.label)
          .filter((label): label is string => Boolean(label)),
      },
    } satisfies Node<ResearchNodeData>;
  });

  const edges: Edge[] = component.edges.flatMap((edge, index) => {
    if (!idSet.has(edge.from) || !idSet.has(edge.to) || edge.from === edge.to) return [];
    return [{
      id: `${edge.from}:${edge.to}:${index}`,
      source: edge.from,
      target: edge.to,
      sourceHandle: `source-${outgoingEdges.get(edge.from)?.indexOf(index) ?? 0}`,
      targetHandle: `target-${incomingEdges.get(edge.to)?.indexOf(index) ?? 0}`,
      ariaLabel: edge.label,
      type: "default",
    }];
  });

  return { nodes, edges, height: Math.max(300, Math.min(560, contentHeight + 72)) };
}

function calculateRanks(
  ids: string[],
  incoming: Map<string, string[]>,
  outgoing: Map<string, string[]>,
): Map<string, number> {
  const rank = new Map(ids.map((id) => [id, 0]));
  const indegree = new Map(ids.map((id) => [id, incoming.get(id)?.length ?? 0]));
  const queue = ids.filter((id) => indegree.get(id) === 0);
  const visited = new Set<string>();

  while (queue.length) {
    const id = queue.shift()!;
    visited.add(id);
    for (const target of outgoing.get(id) ?? []) {
      rank.set(target, Math.max(rank.get(target) ?? 0, (rank.get(id) ?? 0) + 1));
      const nextIndegree = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, nextIndegree);
      if (nextIndegree === 0) queue.push(target);
    }
  }

  // Cyclic or disconnected cyclic nodes cannot be ranked topologically. Keep
  // them in a final column so malformed model output still renders safely.
  const finalRank = Math.max(0, ...rank.values()) + 1;
  for (const id of ids) if (!visited.has(id)) rank.set(id, finalRank);
  return rank;
}

function barycenter(id: string, incoming: Map<string, string[]>, order: Map<string, number>): number {
  const positions = (incoming.get(id) ?? []).map((source) => order.get(source)).filter((value): value is number => value !== undefined);
  if (!positions.length) return Number.MAX_SAFE_INTEGER;
  return positions.reduce((sum, value) => sum + value, 0) / positions.length;
}
