import { ResearchError } from "./model.ts";

export function trackingPeriods(valuationDate: string, asOf: string): string[] {
	for (const date of [valuationDate, asOf]) {
		if (
			!/^20\d{2}-\d{2}-\d{2}$/u.test(date) ||
			!Number.isFinite(Date.parse(date)) ||
			new Date(date).toISOString().slice(0, 10) !== date
		)
			throw new ResearchError(400, "请填写已确认的估值日期，不能用模型文件名日期代替。");
	}
	if (valuationDate > asOf) throw new ResearchError(400, "估值日期不能晚于本轮查询日期。");
	const first = Number(valuationDate.slice(0, 4)) * 4 + Math.floor((Number(valuationDate.slice(5, 7)) - 1) / 3);
	const last = Number(asOf.slice(0, 4)) * 4 + Math.floor((Number(asOf.slice(5, 7)) - 1) / 3);
	if (last - first >= 100) throw new ResearchError(400, "查询跨度超过100个季度，请先更新模型基准日期。");
	return Array.from(
		{ length: last - first + 1 },
		(_, index) => `${Math.floor((first + index) / 4)}年第${["一", "二", "三", "四"][(first + index) % 4]}季度`,
	);
}

export function shanghaiToday(now = new Date()): string {
	return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}
