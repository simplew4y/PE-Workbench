import type { IterationObservations } from "./iteration-model.ts";
import { type FrameworkContent, ResearchError } from "./model.ts";

/** New evidence has no trusted disclosure date yet; ingestion time is not an information cutoff. */
export function synchronizeIterationScope(candidate: FrameworkContent): FrameworkContent {
	return {
		...candidate,
		sections: {
			...candidate.sections,
			researchSetup: { ...candidate.sections.researchSetup, informationCutoff: null },
		},
	};
}

type Observation = IterationObservations["observations"][number];
const moneyPattern = /(?:RMB\s*|人民币\s*)?(-?\d[\d,]*(?:\.\d+)?)\s*(billion|million|十亿元|百万元|亿元)/gi;
const scales: Record<string, number> = { billion: 1e9, million: 1e6, 十亿元: 1e9, 百万元: 1e6, 亿元: 1e8 };
function quarters(text: string): string[] {
	return [
		...text
			.replace(/一季度|first quarter/gi, "Q1")
			.replace(/二季度|second quarter/gi, "Q2")
			.replace(/三季度|third quarter/gi, "Q3")
			.replace(/四季度|fourth quarter/gi, "Q4")
			.matchAll(/Q[1-4]/gi),
	].map((m) => m[0].toUpperCase());
}

/** Use evidence-linked text only; coincidentally equal numbers elsewhere are unrelated. */
export function validateObservationMoney(observation: Observation, text: string): void {
	if (typeof observation.value !== "number") return;
	const scale =
		scales[
			observation.unit
				?.replace(/^RMB\s*/i, "")
				.trim()
				.toLowerCase() || ""
		];
	if (!scale) return;
	for (const match of text.matchAll(moneyPattern)) {
		const value = Number(match[1].replace(/,/g, ""));
		if (value === observation.value && scales[match[2].toLowerCase()] !== scale)
			throw new ResearchError(400, `金额单位不符：${observation.id}，不能写成${match[0]}。`);
	}
}

export function validateObservationContext(observation: Observation): void {
	const { context } = observation;
	const basis = `${observation.quote}\n${context.basisQuote}`;
	const sourceQuarters = quarters(basis);
	if (quarters(observation.period || "").some((quarter) => sourceQuarters.length && !sourceQuarters.includes(quarter)))
		throw new ResearchError(400, `季度期间与引述不一致：${observation.id}`);
	if (typeof observation.value === "number") {
		for (const match of observation.quote.matchAll(moneyPattern)) {
			if (Number(match[1].replace(/,/g, "")) !== observation.value) continue;
			const unit =
				observation.unit
					?.replace(/^RMB\s*/i, "")
					.trim()
					.toLowerCase() || "";
			if (scales[unit] !== scales[match[2].toLowerCase()])
				throw new ResearchError(400, `原始金额单位不符：${observation.id}`);
		}
	}
	validateObservationMoney(observation, observation.gaps.join("\n"));
	// Contrast notes can describe another value's cumulative basis. Keep all clauses
	// containing this observation's value so ambiguous equal values stay conservative.
	const valueClauses =
		typeof observation.value === "number"
			? context.basisQuote
					.split(/[，。；;]|,(?!\d{3}(?:\D|$))/)
					.filter((clause) =>
						Array.from(clause.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)).some(
							(match) => Number(match[0].replace(/,/g, "")) === observation.value,
						),
					)
			: [];
	const cumulativeBasis = `${observation.quote}\n${valueClauses.length ? valueClauses.join("\n") : context.basisQuote}`;
	if (/累计|cumulative|to date/i.test(cumulativeBasis) && context.periodKind !== "cumulative")
		throw new ResearchError(400, `累计口径不符：${observation.id}`);
	if (context.periodKind === "cumulative" && !context.asOf)
		throw new ResearchError(400, `累计指标缺少截至日期：${observation.id}`);
	if (context.periodKind === "cumulative" && context.asOf && !observation.period?.includes(context.asOf))
		throw new ResearchError(400, `累计期间必须包含截至日期，不能标为单季度：${observation.id}`);
	if (context.asOf && !basis.replace(/\s/g, "").toLowerCase().includes(context.asOf.replace(/\s/g, "").toLowerCase()))
		throw new ResearchError(400, `截至日期必须沿用原文表述并有引述支持：${observation.id}`);
	if (/预测|forecast|\b20\d{2}E\b/i.test(basis) && observation.role === "fact")
		throw new ResearchError(400, `预测不能标为事实：${observation.id}`);
	if (/截至|as of/i.test(basis) && /门店|stores/i.test(basis) && observation.role === "guidance")
		throw new ResearchError(400, `已披露门店数量不能标为指引：${observation.id}`);
	if (/units sold|销量/i.test(basis) && /出货|shipments/i.test(observation.metric))
		throw new ResearchError(400, `销量不能改写为出货：${observation.id}`);
}

/** Semantic ambiguities require review even in projects registered for automatic publication. */
export function observationReviewReasons(observations: IterationObservations): string[] {
	return [
		...new Set(
			observations.observations.flatMap((observation) => {
				const { context } = observation;
				const reasons = context.reviewReasons.map((reason) => `${observation.id}：${reason}`);
				if (!observation.period || !observation.unit || !context.scope || context.periodKind === "unknown")
					reasons.push(`${observation.id}：期间、单位或业务口径待核实`);
				if (
					context.eventKind !== "none" ||
					/\blaunched\b|\bunveiled\b|正式上市|亮相|发售/i.test(`${observation.quote} ${context.basisQuote}`)
				)
					reasons.push(`${observation.id}：事件含义、日期及其影响需人工核查`);
				return reasons;
			}),
		),
	];
}

export function validateLinkedObservationText(observation: Observation, text: string): void {
	validateObservationMoney(observation, text);
	const basis = `${observation.quote} ${observation.context.basisQuote}`;
	if (
		/units sold|销量/i.test(basis) &&
		/出货|shipments/i.test(text) &&
		!/(?:不是|非|而非|不能|不等于|不用|不得|避免)[^。；\n]{0,8}(?:出货|shipments)|出货[^。；\n]{0,8}(?:纠正|改为|修正)|(?:销量|units sold)[^。；\n]{0,12}(?:与|和)[^。；\n]{0,8}(?:出货|shipments)[^。；\n]{0,8}(?:口径混淆|混用)/i.test(
			text,
		)
	)
		throw new ResearchError(400, `销量不能改写为出货：${observation.id}`);
	if (
		/EV.*AI|汽车.*其他|EV.*other/i.test(basis) &&
		/汽车独立(?:净利润|利润|盈亏|亏损)/.test(text) &&
		!/不等于|非|不能|未披露/.test(text)
	)
		throw new ResearchError(400, `合并分部不能改写为汽车独立盈亏：${observation.id}`);
}
