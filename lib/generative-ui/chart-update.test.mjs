import assert from "node:assert/strict";
import test from "node:test";
import * as echarts from "echarts/core";
import { BarChart, TreemapChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { updateChart } from "./chart-update.ts";

echarts.use([BarChart, TreemapChart, GridComponent, TooltipComponent, SVGRenderer]);
const options = [
  {animation:false,xAxis:{type:"category",data:["A","B"]},yAxis:{type:"value"},series:[{type:"bar",data:[10,20]}]},
  {animation:false,series:[{type:"treemap",data:[{name:"A",value:80},{name:"B",value:20}]}]},
];

test("reproduces the deferred replacement hover-data gap in ECharts", () => {
  const chart = echarts.init(null, null, {renderer:"svg",ssr:true,width:600,height:300});
  try {
    chart.setOption(options[0]);
    chart.setOption(options[0], {notMerge:true,lazyUpdate:true});
    assert.throws(() => chart.getModel().getSeriesByIndex(0).getDataParams(0), /getRawIndex/);
  } finally { chart.dispose(); }
});

test("series hover data stays ready immediately after every replacement", () => {
  const chart = echarts.init(null, null, {renderer:"svg",ssr:true,width:600,height:300});
  try {
    for (let index=0;index<12;index++) {
      updateChart(chart, options[index % options.length]);
      const params = chart.getModel().getSeriesByIndex(0).getDataParams(0);
      assert.equal(typeof params.dataIndex, "number");
      assert.ok(params.data !== undefined);
    }
  } finally { chart.dispose(); }
  assert.doesNotThrow(() => updateChart(chart, options[0]));
});
