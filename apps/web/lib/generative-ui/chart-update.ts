import type { EChartsCoreOption, EChartsType } from "echarts/core";

export function updateChart(chart: EChartsType, option: EChartsCoreOption): void {
  if (chart.isDisposed()) return;
  chart.dispatchAction({ type: "hideTip" });
  // notMerge replaces the model immediately. Deferring preparation leaves the
  // old canvas hover targets pointing at new, unprepared series data.
  chart.setOption(option, { notMerge: true, lazyUpdate: false });
}
