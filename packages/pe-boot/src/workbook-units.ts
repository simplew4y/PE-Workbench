export interface Quantity {
	dimension: string;
	scale: number;
	label: string;
}

const CURRENCIES: Record<string, string> = {
	CNY: "CNY",
	RMB: "CNY",
	EUR: "EUR",
	USD: "USD",
	HKD: "HKD",
	GBP: "GBP",
	JPY: "JPY",
	人民币: "CNY",
	欧元: "EUR",
	美元: "USD",
	港元: "HKD",
	英镑: "GBP",
	日元: "JPY",
};

const SCALES: Record<string, number> = {
	"": 1,
	元: 1,
	k: 1e3,
	千: 1e3,
	千元: 1e3,
	_10k: 1e4,
	万: 1e4,
	万元: 1e4,
	m: 1e6,
	million: 1e6,
	百万: 1e6,
	百万元: 1e6,
	_100m: 1e8,
	亿: 1e8,
	亿元: 1e8,
	bn: 1e9,
	billion: 1e9,
};

function scaledLabel(scale: number): string {
	return (
		{ 1: "", 1000: "千", 10000: "万", 1000000: "百万", 100000000: "亿", 1000000000: "十亿" } as Record<number, string>
	)[scale];
}

/** Canonical units accepted for assertions and display conversions. */
export function quantity(unit: string): Quantity | undefined {
	const canonical = unit.normalize("NFKC").trim();
	const currency = /^(EUR|USD|CNY|RMB|HKD|GBP|JPY)(k|m|bn|_10k|_100m)?(\/share)?$/u.exec(canonical);
	if (currency) {
		const name = CURRENCIES[currency[1]];
		const scale = SCALES[currency[2] ?? ""];
		return {
			dimension: `${name}${currency[3] ?? ""}`,
			scale,
			label: `${scaledLabel(scale)}${name}${currency[3] ? "/股" : ""}`,
		};
	}
	const shares = /^shares(?:_(k|10k|m|100m|bn))?$/u.exec(canonical);
	if (shares) {
		const scale = SCALES[shares[1] === "10k" || shares[1] === "100m" ? `_${shares[1]}` : (shares[1] ?? "")];
		return { dimension: "shares", scale, label: `${scaledLabel(scale)}股` };
	}
	if (canonical === "%") return { dimension: "ratio", scale: 1, label: "%" };
	if (canonical === "per_share") return { dimension: "unknown_currency/share", scale: 1, label: "每股金额" };
	if (canonical === "share_count_unspecified_scale") return { dimension: "unknown_share_scale", scale: 1, label: "" };
	if (["x", "multiple", "times", "倍"].includes(canonical)) return { dimension: "multiple", scale: 1, label: "倍" };
	return undefined;
}

type UnitKind = "amount" | "per_share" | "shares" | "ratio" | "multiple";

function metricKind(label: string | undefined): UnitKind | undefined {
	const text = (label ?? "").normalize("NFKC").toLowerCase();
	if (/\beps\b|per[\s_-]+share|每股|股价|目标价|\b(?:target|current|reference|share) price\b/u.test(text))
		return "per_share";
	if (/\bshares\b|\bshare count\b|股数|股份数量/u.test(text)) return "shares";
	if (/\bp\s*\/\s*e\b|\bev\s*\/\s*ebitda\b|\bmultiple\b|市盈率|估值倍数|倍数/u.test(text)) return "multiple";
	if (
		/\b(?:growth|margin|rate|yield|wacc)\b|\bmarket share\b|增长率|增速|利润率|毛利率|税率|折现率|收益率|市场份额/u.test(
			text,
		)
	)
		return "ratio";
	if (
		/\b(?:revenue|sales|costs?|profit|income|earnings|ebitda|ebit|fcf|cash|capex|depreciation|assets?|debt|equity|value|capital)\b|收入|成本|利润|净利|现金流|折旧|资本开支|营运资金|资产|债务|股权价值|企业价值/u.test(
			text,
		)
	)
		return "amount";
	return undefined;
}

function quantityKind(value: Quantity): UnitKind {
	if (value.dimension.endsWith("/share")) return "per_share";
	if (value.dimension === "shares" || value.dimension === "unknown_share_scale") return "shares";
	if (value.dimension === "ratio" || value.dimension === "multiple") return value.dimension;
	return "amount";
}

const SCALE_TOKEN = "(?:_100m|_10k|billion|million|百万元|千元|万元|亿元|百万|bn|亿|万|千|元|k|m)";
const CURRENCY_TOKEN = "(?:CNY|RMB|EUR|USD|HKD|GBP|JPY|人民币|欧元|美元|港元|英镑|日元)";

/** Parse every explicit unit before consulting the caller's expected unit. */
function sourceQuantities(text: string): Quantity[] {
	let remaining = text
		.normalize("NFKC")
		.replace(new RegExp(`(${CURRENCY_TOKEN})\\s*\\(\\s*(${SCALE_TOKEN})\\s*\\)`, "giu"), "$1 $2");
	const found: Quantity[] = [];
	const consume = (pattern: RegExp, parse: (match: RegExpExecArray) => Quantity): void => {
		const matches = [...remaining.matchAll(pattern)];
		for (const match of matches) found.push(parse(match));
		for (const match of matches.reverse())
			remaining =
				remaining.slice(0, match.index) +
				" ".repeat(match[0].length) +
				remaining.slice(match.index + match[0].length);
	};
	consume(/\b(?:per_share|share_count_unspecified_scale)\b/gu, (match) => quantity(match[0])!);
	consume(
		/\bper share\s*\(currency (?:unknown|unspecified)\)|每股金额[（(]币种(?:未知|未说明)[）)]/giu,
		() => quantity("per_share")!,
	);
	consume(
		/\bshares?\s*\(scale (?:unknown|unspecified)\)|股数[（(](?:倍率|尺度)(?:未知|未说明)[）)]/giu,
		() => quantity("share_count_unspecified_scale")!,
	);
	consume(
		new RegExp(
			`(?<![A-Za-z0-9_])(${SCALE_TOKEN})?\\s*(${CURRENCY_TOKEN})\\s*(${SCALE_TOKEN})?\\s*((?:/|per\\s+)(?:shares?|股))?(?![A-Za-z0-9_])`,
			"giu",
		),
		(match) => {
			if (match[1] && match[3]) throw new Error("Ambiguous source unit scale");
			const currency = CURRENCIES[match[2].toUpperCase()];
			const scale = SCALES[(match[1] ?? match[3] ?? "").toLowerCase()];
			return {
				dimension: `${currency}${match[4] ? "/share" : ""}`,
				scale,
				label: `${scaledLabel(scale)}${currency}${match[4] ? "/股" : ""}`,
			};
		},
	);
	consume(
		new RegExp(
			`(?<![A-Za-z0-9_])(${SCALE_TOKEN})?\\s*(shares?|股)(?:[_\\s]+(${SCALE_TOKEN}|100m|10k))?(?![A-Za-z0-9_])`,
			"giu",
		),
		(match) => {
			if (match[1] && match[3]) throw new Error("Ambiguous source share scale");
			const suffix = (match[1] ?? match[3] ?? "").toLowerCase();
			const scale = SCALES[suffix === "100m" || suffix === "10k" ? `_${suffix}` : suffix];
			return { dimension: "shares", scale, label: `${scaledLabel(scale)}股` };
		},
	);
	consume(/%|百分比|(?<![A-Za-z])percent(?:age)?(?![A-Za-z])/giu, () => quantity("%")!);
	consume(/倍|(?<![A-Za-z])(?:multiple|times|x)(?![A-Za-z])/giu, () => quantity("x")!);
	if (
		/\b(?:millions?|billions?|thousands?|trillions?|lakh|crore|bn|mn|k|m|AUD|CAD|CHF|SGD)\b|百万元|万元|亿元|千元|人民币|欧元|美元|港元|英镑|日元/iu.test(
			remaining,
		)
	)
		throw new Error("Source unit contains an unresolved currency or scale");
	return found;
}

export function resolveSourceQuantity(args: {
	text: string;
	expectedUnit: string;
	field?: "value" | "number_format";
	metricLabel?: string;
}): Quantity {
	let text = args.text.trim();
	if (!text) throw new Error("Source unit is missing");
	if (args.field === "number_format") {
		const unquoted = text.replace(/"[^"]*"|\\./gu, "");
		if (/[0#?],+(?=$|[^0#?,])/u.test(unquoted))
			throw new Error("Number format display scaling does not establish the source storage unit");
		// Keep unit literals in order across numeric placeholders: "EUR"0.00"/share"
		// and [$EUR-407]0.00"/share" both explicitly state EUR per share.
		text = [...text.matchAll(/"([^"]*)"|\[\$(CNY|RMB|EUR|USD|HKD|GBP|JPY)(?:-[A-Za-z0-9]+)?\]|\\(.)|%|;/gu)]
			.map((match) => match[1] ?? match[2] ?? match[3] ?? match[0])
			.join("");
	}
	const candidates = sourceQuantities(text);
	const kind = metricKind(args.metricLabel);
	const applicable = kind ? candidates.filter((candidate) => quantityKind(candidate) === kind) : candidates;
	const unique = [
		...new Map(applicable.map((candidate) => [`${candidate.dimension}:${candidate.scale}`, candidate])).values(),
	];
	if (unique.length === 0) throw new Error("Source unit is missing or does not establish the metric's unit");
	if (unique.length !== 1) throw new Error("Source unit is ambiguous; use a more specific original context");
	const expected = quantity(args.expectedUnit);
	if (!expected) throw new Error("Expected unit is not a supported canonical unit");
	const source = unique[0];
	if (source.dimension !== expected.dimension || source.scale !== expected.scale)
		throw new Error("Source unit conflicts with expected unit dimension or scale");
	return source;
}
