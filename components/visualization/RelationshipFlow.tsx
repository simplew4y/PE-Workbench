"use client";

import { useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { RelationshipMapComponent } from "@/lib/generative-ui/protocol";

type ResearchNodeData = { label: string; group?: string; primary?: boolean };

function ResearchNode({ data }: NodeProps<Node<ResearchNodeData>>) {
  return (
    <Card className={`min-w-36 max-w-52 py-0 shadow-sm ${data.primary ? "ring-2 ring-[var(--pe-accent)]" : ""}`}>
      <CardContent className="relative px-4 py-3 text-center">
        <Handle type="target" position={Position.Left} className="!size-2 !border-0 !bg-[var(--pe-series-1)]" />
        <div className="text-xs font-semibold leading-snug text-foreground">{data.label}</div>
        {data.group && <Badge variant="outline" className="mt-2 h-5 text-[9px] font-normal">{data.group}</Badge>}
        <Handle type="source" position={Position.Right} className="!size-2 !border-0 !bg-[var(--pe-accent)]" />
      </CardContent>
    </Card>
  );
}

const nodeTypes = { research: ResearchNode };

export function RelationshipFlow({ component, interactive = false }: { component: RelationshipMapComponent; interactive?: boolean }) {
  const { nodes, edges } = useMemo(() => layout(component), [component]);
  const height = Math.max(300, Math.ceil(nodes.length / 3) * 150);
  return (
    <div className="w-full overflow-hidden rounded-xl border bg-card/40" style={{ height }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.22 }}
        minZoom={0.5}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={interactive}
        zoomOnScroll={interactive}
        zoomOnPinch={interactive}
        zoomOnDoubleClick={interactive}
      >
        <Background gap={22} size={1} color="var(--border)" />
        {interactive && <Controls showInteractive={false} position="bottom-right" />}
      </ReactFlow>
    </div>
  );
}

function layout(component: RelationshipMapComponent): { nodes: Node<ResearchNodeData>[]; edges: Edge[] } {
  const columns = Math.min(3, Math.max(1, component.nodes.length));
  const nodes: Node<ResearchNodeData>[] = component.nodes.map((node, index) => ({
    id: node.id,
    type: "research",
    position: { x: (index % columns) * 250, y: Math.floor(index / columns) * 145 + (index % 2 ? 22 : 0) },
    data: { label: node.label, group: node.group, primary: index === 0 },
  }));
  const edges: Edge[] = component.edges.map((edge, index) => ({
    id: `${edge.from}:${edge.to}:${index}`,
    source: edge.from,
    target: edge.to,
    label: edge.label,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--pe-accent)" },
    style: { stroke: "var(--pe-accent)", strokeWidth: 1.4 },
    labelStyle: { fill: "var(--text-muted)", fontSize: 10 },
    labelBgStyle: { fill: "var(--bg)", fillOpacity: 0.9 },
  }));
  return { nodes, edges };
}
