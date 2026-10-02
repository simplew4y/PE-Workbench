import { describe, expect, it } from "vitest";
import type { IterationObservations } from "../src/research/iteration-model.ts";
import {
	quoteContainsNumber,
	validateLinkedObservationText,
	validateObservationContext,
} from "../src/research/iteration-quality.ts";

function delivery(value: number, basisQuote: string): IterationObservations["observations"][number] {
	return {
		id: "delivery",
		docId: "excel",
		subject: "测试公司",
		metric: "汽车交付",
		value,
		period: "2026 Q2",
		unit: "辆",
		role: "fact",
		quote: String(value),
		evidenceIds: ["source:test"],
		gaps: [],
		context: {
			periodKind: "single",
			asOf: null,
			scope: "汽车单季度交付",
			basisQuote,
			eventKind: "none",
			reviewReasons: [],
		},
	};
}

describe("iteration evidence context", () => {
	it("accepts equivalent cumulative cutoff formats while retaining exact evidence checks", () => {
		const observation = delivery(30000, "截至2026 6 30累计30,000辆");
		observation.context.periodKind = "cumulative";
		observation.context.asOf = "2026 6 30";
		for (const period of ["2026-06-30止六个月", "截至2026年6月30日止六个月", "截至2026/06/30累计"]) {
			observation.period = period;
			expect(() => validateObservationContext(observation)).not.toThrow();
		}
		for (const period of ["截至2026年6月3日", "2026 H1"]) {
			observation.period = period;
			expect(() => validateObservationContext(observation)).toThrow();
		}
		observation.period = "截至2026 6 30";
		observation.context.asOf = "2026 6 3";
		expect(() => validateObservationContext(observation)).toThrow("累计期间");
		observation.period = "截至2026年6月30日止六个月";
		observation.context.asOf = "2026-06-30";
		expect(() => validateObservationContext(observation)).toThrow("引述支持");
	});
	it("matches accounting negatives without inventing a minus for positive text", () => {
		expect(quoteContainsNumber("(3,338,791) (2,144,240)", -3338791)).toBe(true);
		expect(quoteContainsNumber("（0.81）", -0.81)).toBe(true);
		expect(quoteContainsNumber("-3,338,791", -3338791)).toBe(true);
		expect(quoteContainsNumber("3,338,791", -3338791)).toBe(false);
		expect(quoteContainsNumber("(3,338,791)", -3338792)).toBe(false);
	});
	it("separates quarter delivery from another value's cumulative contrast note", () => {
		expect(() =>
			validateObservationContext(delivery(30000, "历史累计交付为超过90,000辆，不能替代Q2单季度30,000辆。")),
		).not.toThrow();
	});
	it("still rejects the cumulative value presented as a quarter", () => {
		expect(() =>
			validateObservationContext(delivery(90000, "历史累计交付为超过90,000辆，不能替代Q2单季度30,000辆。")),
		).toThrow("累计口径不符");
	});
	it("keeps equal-valued cumulative and quarter clauses ambiguous", () => {
		expect(() => validateObservationContext(delivery(30000, "累计30,000辆；Q2单季度30,000辆，须核实。"))).toThrow(
			"累计口径不符",
		);
	});
	it("keeps cumulative headings when their value is on another line", () => {
		expect(() => validateObservationContext(delivery(30000, "历史累计交付\n30,000辆"))).toThrow("累计口径不符");
	});
	it("allows monitoring warnings against mixing sales and shipments", () => {
		const observation = delivery(0.25, "高端手机终端销量占比0.25");
		for (const text of ["核对终端销量占比，不用渠道出货占比替代", "终端销量与渠道出货量口径混淆"])
			expect(() => validateLinkedObservationText(observation, text)).not.toThrow();
	});
	it("still rejects replacing sales with shipments", () => {
		const observation = delivery(0.25, "高端手机终端销量占比0.25");
		expect(() => validateLinkedObservationText(observation, "高端手机出货占比25%")).toThrow("销量不能改写为出货");
	});
});
