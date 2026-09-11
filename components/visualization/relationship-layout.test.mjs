import test from "node:test";
import assert from "node:assert/strict";
import { layoutRelationship } from "./relationship-layout.ts";

test("lays out dependency chains from left to right regardless of input order", () => {
  const result = layoutRelationship({
    kind: "relationship_map",
    title: "增长传导路径",
    nodes: [
      { id: "profit", label: "归母净利润" },
      { id: "margin", label: "毛利率" },
      { id: "brand", label: "高端品牌" },
      { id: "expense", label: "费用率" },
      { id: "channel", label: "DTC 渠道" },
    ],
    edges: [
      { from: "brand", to: "margin", label: "提价" },
      { from: "channel", to: "expense", label: "降低费用" },
      { from: "margin", to: "profit", label: "净利率" },
      { from: "expense", to: "profit", label: "费用率" },
    ],
  });

  const positions = new Map(result.nodes.map((node) => [node.id, node.position]));
  assert.ok(positions.get("brand").x < positions.get("margin").x);
  assert.ok(positions.get("channel").x < positions.get("expense").x);
  assert.ok(positions.get("margin").x < positions.get("profit").x);
  assert.ok(positions.get("expense").x < positions.get("profit").x);
  const profit = result.nodes.find((node) => node.id === "profit");
  assert.equal(profit.data.primary, true);
  assert.equal(profit.data.inputCount, 2);
  assert.equal(profit.data.outputCount, 0);
  assert.deepEqual(result.nodes.find((node) => node.id === "brand").data.edgeLabels, ["提价"]);
  assert.deepEqual(result.edges.map((edge) => edge.targetHandle), ["target-0", "target-0", "target-0", "target-1"]);
});

test("centers shorter layers and sizes the canvas from the busiest layer", () => {
  const result = layoutRelationship({
    kind: "relationship_map",
    title: "关系",
    nodes: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
      { id: "result", label: "Result" },
    ],
    edges: [
      { from: "a", to: "result" },
      { from: "b", to: "result" },
      { from: "c", to: "result" },
    ],
  });

  const sourceYs = result.nodes.filter((node) => node.id !== "result").map((node) => node.position.y);
  const resultNode = result.nodes.find((node) => node.id === "result");
  assert.equal(resultNode.position.y, (Math.min(...sourceYs) + Math.max(...sourceYs)) / 2);
  assert.ok(result.height >= 300);
  assert.ok(result.height <= 560);
});
