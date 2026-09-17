import type { ModelCost } from "@earendil-works/pi-ai";

export interface PlatformSpecs {
  context_window?: number;
  max_output_tokens?: number;
  reasoning?: boolean;
  cost?: ModelCost;
  thinking_cost?: ModelCost;
  metadata?: { verified_at?: string; pricing_note?: string; max_output_tokens_thinking?: number;
    configuration_mode?: string; synced_at?: string; billing_policy?: string; region?: string;
    bailian_costs?: Record<string, ModelCost>; bailian_schedule?: string };
}

export function PePlatformModelSpecs({ model }: { model: PlatformSpecs }) {
  return <span className="mt-2 block space-y-1 text-[11px] text-text-muted">
    <span className="block">上下文 {model.context_window?.toLocaleString() ?? "未提供"} · 最大输出 {model.max_output_tokens?.toLocaleString() ?? "未提供"} · {model.reasoning ? "支持推理" : "未声明推理能力"}</span>
    {model.metadata?.max_output_tokens_thinking && <span className="block">思考模式输出上限 {model.metadata.max_output_tokens_thinking.toLocaleString()}</span>}
    {model.cost && <span className="block">缓存命中 ¥{model.cost.cacheRead}/百万 tokens</span>}
    {model.thinking_cost && <span className="block">思考模式：输入 ¥{model.thinking_cost.input} / 输出 ¥{model.thinking_cost.output}（每百万 tokens，基础档）</span>}
    {model.cost?.tiers?.map((tier) => <span className="block" key={tier.inputTokensAbove}>
      输入超过 {tier.inputTokensAbove.toLocaleString()}：输入 ¥{tier.input} / 输出 ¥{tier.output} / 缓存 ¥{tier.cacheRead}（每百万 tokens）
    </span>)}
    {model.metadata?.pricing_note && <span className="block">{model.metadata.pricing_note}</span>}
    {model.metadata?.configuration_mode === "bailian_sync" && <>
      <span className="block">百炼自动同步 · {model.metadata.region} · {model.metadata.billing_policy === "follow" ? "收费跟随上游" : "平台固定收费"}</span>
      <span className="block text-text-dim">最近同步 {model.metadata.synced_at ? new Date(model.metadata.synced_at).toLocaleString() : "未知"} · 会话费用为估算，以后台结算为准</span>
      {model.metadata.bailian_costs?.["normal/peak"] && <span className="block">上游峰谷输入 / 输出：高峰 ¥{model.metadata.bailian_costs["normal/peak"].input} / ¥{model.metadata.bailian_costs["normal/peak"].output}，空闲 ¥{model.metadata.bailian_costs["normal/offpeak"]?.input} / ¥{model.metadata.bailian_costs["normal/offpeak"]?.output}（每百万 tokens；仅作上游参考）</span>}
    </>}
    {model.metadata?.verified_at && <span className="block text-text-dim">规格核验 {model.metadata.verified_at} · 会话费用为估算，以后台结算为准</span>}
  </span>;
}
