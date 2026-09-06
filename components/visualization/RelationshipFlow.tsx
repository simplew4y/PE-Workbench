"use client";

import { useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { RelationshipMapComponent } from "@/lib/generative-ui/protocol";
import { layoutRelationship, type ResearchNodeData } from "./relationship-layout";

function ResearchNode({ data }: NodeProps<Node<ResearchNodeData>>) {
  return (
    <Card
      className={`h-full w-full overflow-visible border py-0 ${data.primary ? "border-[var(--pe-accent)] shadow-[0_10px_30px_-14px_var(--pe-accent)]" : "border-[color-mix(in_srgb,var(--pe-accent)_40%,var(--border))] shadow-[0_8px_24px_-15px_rgba(15,23,42,0.55)]"}`}
      style={{ background: `color-mix(in srgb, var(--pe-accent) ${data.primary ? 16 : 9}%, var(--card))` }}
    >
      <CardContent className="relative flex h-full flex-col items-center justify-center px-4 py-2.5 text-center">
        {Array.from({ length: data.inputCount }, (_, index) => (
          <Handle
            key={`target-${index}`}
            id={`target-${index}`}
            type="target"
            position={Position.Left}
            className="!-left-1 !size-2 !border-2 !border-background !bg-[var(--pe-accent)] opacity-80 dark:!border-card"
            style={{ top: `${((index + 1) / (data.inputCount + 1)) * 100}%` }}
          />
        ))}
        {data.group && <Badge variant="secondary" className="mb-1 h-4 max-w-full truncate px-1.5 text-[8px] font-normal text-muted-foreground">{data.group}</Badge>}
        <div className="line-clamp-2 text-xs font-semibold leading-snug text-foreground">{data.label}</div>
        {data.edgeLabels.length > 0 && (
          <div className="mt-1 line-clamp-2 max-w-full text-[8px] leading-3 text-[var(--pe-accent)]">
            {data.edgeLabels.join(" · ")}
          </div>
        )}
        {Array.from({ length: data.outputCount }, (_, index) => (
          <Handle
            key={`source-${index}`}
            id={`source-${index}`}
            type="source"
            position={Position.Right}
            className="!-right-1 !size-2 !border-2 !border-background !bg-[var(--pe-accent)] opacity-80 dark:!border-card"
            style={{ top: `${((index + 1) / (data.outputCount + 1)) * 100}%` }}
          />
        ))}
      </CardContent>
    </Card>
  );
}

const nodeTypes = { research: ResearchNode };

export function RelationshipFlow({ component, interactive = false }: { component: RelationshipMapComponent; interactive?: boolean }) {
  const { nodes, edges, height } = useMemo(() => layoutRelationship(component), [component]);
  const styledEdges = useMemo(() => edges.map((edge) => ({
    ...edge,
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--pe-accent)", width: 14, height: 14 },
    style: { stroke: "var(--pe-accent)", strokeWidth: 1.35, opacity: 0.72 },
  })), [edges]);
  return (
    <div className="w-full overflow-hidden rounded-xl border border-border/60 bg-gradient-to-br from-muted/25 via-card/40 to-muted/15" style={{ height }}>
      <ReactFlow
        nodes={nodes}
        edges={styledEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.14, minZoom: 0.56, maxZoom: 1.08 }}
        minZoom={0.45}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={interactive}
        zoomOnScroll={interactive}
        zoomOnPinch={interactive}
        zoomOnDoubleClick={interactive}
      >
        <Background gap={28} size={0.7} color="var(--border)" className="opacity-35" />
        {interactive && <Controls showInteractive={false} position="bottom-right" />}
      </ReactFlow>
    </div>
  );
}
