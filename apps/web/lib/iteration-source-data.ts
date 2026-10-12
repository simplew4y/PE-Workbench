import type { IterationObservations, IterationSourceData } from "@earendil-works/pe-boot";
import { parseSourceId } from "@earendil-works/pe-boot/source";

export function sourceDataObservations(row: IterationSourceData, observations?: IterationObservations) {
  return observations?.observations.filter(observation =>
    observation.docId === row.docId && observation.sourceField === row.metric
    && observation.value === row.value && observation.period === row.period
    && observation.unit === row.unit && observation.context.scope === row.scope
    && observation.quote === row.quote
    && observation.evidenceIds.some(id => {
      const ref = parseSourceId(id);
      return ref?.docId === row.docId && ref.location.kind === "text"
        && ref.location.lineStart <= row.line && ref.location.lineEnd >= row.line;
    })) ?? [];
}

export function windReviewTasks(reasons: string[]) {
  const categories = [
    { title: "币种与单位", pattern: /币种|记账|换汇|单位/, action: "核对对应来源的记账币种和单位；未确认的金额不换算、不计算预测偏差。" },
    { title: "期间与统计口径", pattern: /报告期|期间|单期|单季|累计|年化/, action: "确认是全年、半年累计还是单季；尚未披露的全年结果留待未来披露，不要求现在核实。" },
    { title: "财务与业务定义", pattern: /口径|定义|归母|分部|IFRS|EBIT|调整后|一次性/i, action: "核对利润定义、集团与分部范围；供应商补查未返回定义时，保留原判断。" },
    { title: "实际或预测", pattern: /角色|实际或预测|数据类型/, action: "核对供应商字段定义或公告，不能把未标注的数据直接认定为已披露实际值。" },
    { title: "未取得的数据与其他问题", pattern: /[\s\S]/, action: "查看查询回执及关联修改；缺少证据的结论暂不采用。" },
  ];
  const grouped = categories.map(category => ({ ...category, reasons: [] as string[] }));
  for (const reason of new Set(reasons)) {
    const category = grouped.find(item => item.pattern.test(reason));
    category?.reasons.push(reason);
  }
  return grouped.filter(category => category.reasons.length);
}
