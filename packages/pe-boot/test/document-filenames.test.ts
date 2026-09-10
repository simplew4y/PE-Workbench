import { describe, expect, it } from "vitest";
import { portablePeFilename } from "../src/document-filenames.ts";

describe("portable document filenames", () => {
	it("preserves valid Unicode punctuation and composes combining characters", () => {
		expect(portablePeFilename("  研究报告（LULU.US）：模型＃预测？.pdf  ")).toBe(
			"研究报告（LULU.US）：模型＃预测？.pdf",
		);
		expect(portablePeFilename("Cafe\u0301.pdf")).toBe("Café.pdf");
	});

	it("maps only Windows-invalid ASCII punctuation and is idempotent", () => {
		const result = portablePeFilename('模型（A股）:2026<预测>"|?*.xlsx');
		expect(result).toBe("模型（A股）：2026＜预测＞＂｜？＊.xlsx");
		expect(portablePeFilename(result)).toBe(result);
	});

	it("leaves path separators for the caller to reject", () => {
		for (const value of ["../report.pdf", "folder/report.pdf", "folder\\report.pdf"]) {
			expect(portablePeFilename(value)).toBe(value);
		}
	});
});
