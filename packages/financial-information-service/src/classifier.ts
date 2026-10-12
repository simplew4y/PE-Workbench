import type { FrameworkUpdateCandidate, InformationImportance, SourceDisclosure } from "./types.ts";

const HIGH_PRIORITY = [
	/annual report|interim report|quarterly report|financial statements?|results announcement/iu,
	/10-k|10-q|20-f|40-f|earnings release/iu,
	/年度报告|半年度报告|季度报告|财务报告|审计报告|业绩预告|业绩快报|盈利预警|利润预警/u,
];

const MEDIUM_PRIORITY = [
	/8-k|6-k|guidance|forecast|profit warning|acquisition|disposal|debt|dividend|buyback/iu,
	/经营数据|重大合同|收购|出售|重组|债务|分红|回购|股权激励|关联交易|管理层变动/u,
];

export function classifyDisclosure(disclosure: SourceDisclosure): {
	importance: InformationImportance;
	reasons: string[];
} {
	const value = `${disclosure.category || ""}\n${disclosure.title}`;
	if (HIGH_PRIORITY.some((pattern) => pattern.test(value))) {
		return { importance: "high", reasons: ["标题或表单类型表明这是财报、业绩或审计类披露"] };
	}
	if (MEDIUM_PRIORITY.some((pattern) => pattern.test(value))) {
		return { importance: "medium", reasons: ["披露涉及经营、资本配置、融资或治理事件"] };
	}
	return {
		importance: "low",
		reasons: ["未命中高优先级规则；为保护召回率仍提交 PE-Workbench 做影响判断"],
	};
}

export function candidateFilename(disclosure: SourceDisclosure, contentType: string): string {
	const id = disclosure.externalId.replaceAll(/[^A-Za-z0-9_-]+/gu, "-").slice(0, 100);
	return `${disclosure.provider}-${id}${contentType === "application/pdf" ? ".pdf" : ".html"}`;
}

export function buildCandidate(
	id: string,
	subscriptionId: string,
	datasetId: string,
	disclosure: SourceDisclosure,
	contentHash: string,
	contentType: string,
	retrievedUrl: string,
	createdAt: string,
): FrameworkUpdateCandidate {
	const classification = classifyDisclosure(disclosure);
	return {
		schemaVersion: 1,
		id,
		subscriptionId,
		datasetId,
		provider: disclosure.provider,
		externalId: disclosure.externalId,
		securityCode: disclosure.securityCode,
		issuer: disclosure.issuer,
		title: disclosure.title,
		...(disclosure.category ? { category: disclosure.category } : {}),
		publishedAt: disclosure.publishedAt,
		canonicalUrl: disclosure.canonicalUrl,
		retrievedUrl,
		contentHash,
		contentType,
		filename: candidateFilename(disclosure, contentType),
		importance: classification.importance,
		reasons: classification.reasons,
		requiresReview: true,
		createdAt,
	};
}
