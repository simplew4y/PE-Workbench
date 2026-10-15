import { expect, it } from "vitest";
import { shanghaiToday, trackingPeriods } from "../src/research/tracking-periods.ts";

it("enumerates every quarter including the valuation quarter and current incomplete quarter", () => {
	expect(trackingPeriods("2025-06-30", "2026-10-15")).toEqual([
		"2025年第二季度",
		"2025年第三季度",
		"2025年第四季度",
		"2026年第一季度",
		"2026年第二季度",
		"2026年第三季度",
		"2026年第四季度",
	]);
	expect(shanghaiToday(new Date("2026-10-15T17:00:00Z"))).toBe("2026-10-16");
});

it.each(["2026-02-30", "unknown", "2027-01-01"])("rejects unconfirmed or future valuation date %s", (date) => {
	expect(() => trackingPeriods(date, "2026-10-15")).toThrow();
});
