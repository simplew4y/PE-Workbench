import type { ModelCost } from "@earendil-works/pi-ai";

export interface PlatformSpecs {
  context_window?: number;
  max_output_tokens?: number;
  reasoning?: boolean;
  cost?: ModelCost;
  metadata?: { verified_at?: string; pricing_note?: string; max_output_tokens_thinking?: number };
}

export function PePlatformModelSpecs({ model }: { model: PlatformSpecs }) {
  return <span className="mt-2 block space-y-1 text-[11px] text-text-muted">
    <span className="block">上下文 {model.context_window?.toLocaleString() ?? "未提供"} · 最大输出 {model.max_output_tokens?.toLocaleString() ?? "未提供"} · {model.reasoning ? "支持推理" : "未声明推理能力"}</span>
    {model.metadata?.max_output_tokens_thinking && <span className="block">思考模式输出上限 {model.metadata.max_output_tokens_thinking.toLocaleString()}</span>}
    {model.cost && <span className="block">缓存命中 ¥{model.cost.cacheRead}/百万 tokens</span>}
    {model.cost?.tiers?.map((tier) => <span className="block" key={tier.inputTokensAbove}>
      输入超过 {tier.inputTokensAbove.toLocaleString()}：输入 ¥{tier.input} / 输出 ¥{tier.output} / 缓存 ¥{tier.cacheRead}（每百万 tokens）
    </span>)}
    {model.metadata?.pricing_note && <span className="block">{model.metadata.pricing_note}</span>}
    {model.metadata?.verified_at && <span className="block text-text-dim">规格核验 {model.metadata.verified_at} · 会话费用为估算，以后台结算为准</span>}
  </span>;
}
