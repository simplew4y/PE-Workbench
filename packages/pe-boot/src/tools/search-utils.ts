//兼容旧项目并让中文查询能命中英文估值模型(非必要)
const TERM_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
	收入: ["revenue", "sales"],
	营收: ["revenue", "sales"],
	销售: ["revenue", "sales"],
	毛利: ["gross profit"],
	毛利率: ["gross margin"],
	利润: ["profit", "net profit", "net income"],
	净利: ["net profit", "net income"],
	净利润: ["net profit", "net income"],
	估值: ["valuation", "dcf", "pe", "peg"],
	现金流: ["cash flow", "fcf", "free cash flow"],
	储能: ["energy storage", "storage"],
	逆变器: ["inverter", "pv inverter"],
	光伏: ["solar", "pv"],
	订单: ["order", "orders"],
	出货: ["shipment", "shipments"],
	增长: ["growth", "yoy", "cagr"],
	风险: ["risk"],
	催化: ["catalyst", "order", "growth"],
	盈利: ["profit", "margin", "earnings"],
};

export function normalizeText(value: unknown): string {
	return String(value ?? "")
		.normalize("NFKC")
		.replace(/\s+/gu, " ")
		.trim();
}

export function queryTerms(query: string): string[] {
	const normalized = normalizeText(query).toLowerCase();
	const candidates: string[] = normalized.match(/[a-z0-9][a-z0-9._/%+-]{1,}/gu) ?? [];
	for (const sequence of normalized.match(/[\u4e00-\u9fff]{2,}/gu) ?? []) {
		candidates.push(sequence);
		if (sequence.length > 4) {
			for (const size of [2, 3, 4]) {
				for (let index = 0; index <= sequence.length - size; index += 1) {
					candidates.push(sequence.slice(index, index + size));
				}
			}
		}
	}
	for (const [term, synonyms] of Object.entries(TERM_SYNONYMS)) {
		if (normalized.includes(term)) candidates.push(term, ...synonyms);
	}
	if (candidates.length === 0) candidates.push(...(normalized.match(/[\u4e00-\u9fff]/gu) ?? []));

	const terms: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const term = normalizeText(candidate).toLowerCase();
		if (!term || seen.has(term)) continue;
		seen.add(term);
		terms.push(term);
		if (terms.length === 64) break;
	}
	return terms;
}

export function scoreText(value: unknown, terms: readonly string[]): number {
	const text = normalizeText(value).toLowerCase();
	if (!text) return 0;
	let score = 0;
	for (const term of terms) {
		let count = 0;
		let start = 0;
		while (count < 5) {
			const index = text.indexOf(term, start);
			if (index < 0) break;
			count += 1;
			start = index + term.length;
		}
		if (count > 0) score += count * Math.max(1, Math.min(term.length, 12) / 2);
	}
	return score;
}

export function clipText(value: unknown, maxChars: number): string {
	const text = normalizeText(value);
	if (text.length <= maxChars) return text;
	if (maxChars <= 3) return text.slice(0, maxChars);
	return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

export function bestExcerpt(value: unknown, terms: readonly string[], maxChars = 500): string {
	const text = normalizeText(value);
	if (text.length <= maxChars) return text;
	const lower = text.toLowerCase();
	const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
	const center = positions.length > 0 ? Math.min(...positions) : 0;
	const start = Math.max(0, center - Math.floor(maxChars / 3));
	const end = Math.min(text.length, start + maxChars);
	return `${start > 0 ? "..." : ""}${text.slice(start, end).trim()}${end < text.length ? "..." : ""}`;
}
