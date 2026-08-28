import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import PDFDocument from "pdfkit";

const FONT_REGULAR = "PE-Noto-Sans-Hans-Regular";
const FONT_BOLD = "PE-Noto-Sans-Hans-Bold";
const PAGE_MARGIN = 54;
const TEXT_COLOR = "#172033";
const MUTED_COLOR = "#596579";
const ACCENT_COLOR = "#283750";
const REVIEW_COLOR = "#8A4B00";

export interface MemoPdfSource {
	evidenceId: string;
	citation: string;
}

export interface MemoPdfClaim {
	text: string;
	status: "supported" | "not_covered" | "needs_review";
	sources: MemoPdfSource[];
}

export interface MemoPdfSection {
	title: string;
	claims: MemoPdfClaim[];
}

export interface RenderMemoPdfOptions {
	title: string;
	topic: string;
	datasetId: string;
	memoVersionId: string;
	versionNo: number;
	revisionOf?: string;
	asOfDate: string;
	createdAt: string;
	sections: MemoPdfSection[];
}

function resolveFontPath(filename: string): string {
	const require = createRequire(import.meta.url);
	const packageRoot = dirname(dirname(require.resolve("@embedpdf/fonts-sc")));
	return join(packageRoot, "fonts", filename);
}

function ensureVerticalSpace(document: PDFKit.PDFDocument, height: number): void {
	if (document.y + height > document.page.height - document.page.margins.bottom) document.addPage();
}

function writeMetadataRow(document: PDFKit.PDFDocument, label: string, value: string): void {
	const y = document.y;
	document.font(FONT_BOLD).fontSize(9).fillColor(MUTED_COLOR).text(label, PAGE_MARGIN, y, {
		width: 92,
		lineBreak: false,
	});
	document
		.font(FONT_REGULAR)
		.fillColor(TEXT_COLOR)
		.text(value, PAGE_MARGIN + 92, y, {
			width: document.page.width - PAGE_MARGIN * 2 - 92,
		});
	document.x = PAGE_MARGIN;
}

function writeClaim(document: PDFKit.PDFDocument, claim: MemoPdfClaim): void {
	ensureVerticalSpace(document, 48);
	const statusPrefix =
		claim.status === "not_covered" ? "资料未覆盖：" : claim.status === "needs_review" ? "待复核：" : "";
	document
		.font(FONT_REGULAR)
		.fontSize(10.5)
		.fillColor(claim.status === "supported" ? TEXT_COLOR : REVIEW_COLOR)
		.text(`• ${statusPrefix}${claim.text}`, { indent: 10, paragraphGap: 3, lineGap: 2 });
	if (claim.sources.length === 0) return;
	for (const source of claim.sources) {
		document
			.font(FONT_REGULAR)
			.fontSize(8.5)
			.fillColor(MUTED_COLOR)
			.text(`来源：${source.citation} [${source.evidenceId}]`, { indent: 24, paragraphGap: 2, lineGap: 1 });
	}
	document.moveDown(0.25);
}

function addPageFurniture(document: PDFKit.PDFDocument, memoVersionId: string): void {
	const range = document.bufferedPageRange();
	for (let pageOffset = 0; pageOffset < range.count; pageOffset += 1) {
		document.switchToPage(range.start + pageOffset);
		const contentBottomMargin = document.page.margins.bottom;
		document.page.margins.bottom = 0;
		document
			.font(FONT_REGULAR)
			.fontSize(7.5)
			.fillColor(MUTED_COLOR)
			.text("PE-Workbench · Investment Memo", PAGE_MARGIN, 24, {
				width: document.page.width - PAGE_MARGIN * 2,
				lineBreak: false,
			});
		document
			.moveTo(PAGE_MARGIN, 39)
			.lineTo(document.page.width - PAGE_MARGIN, 39)
			.lineWidth(0.5)
			.strokeColor("#D8DEE8")
			.stroke();
		const footerY = document.page.height - 30;
		document
			.font(FONT_REGULAR)
			.fontSize(7.5)
			.fillColor(MUTED_COLOR)
			.text(memoVersionId, PAGE_MARGIN, footerY, {
				width: document.page.width - PAGE_MARGIN * 2 - 70,
				lineBreak: false,
			});
		document.text(`${pageOffset + 1} / ${range.count}`, document.page.width - PAGE_MARGIN - 80, footerY, {
			width: 70,
			align: "right",
			lineBreak: false,
		});
		document.page.margins.bottom = contentBottomMargin;
	}
}

export async function renderMemoPdf(options: RenderMemoPdfOptions): Promise<Buffer> {
	const document = new PDFDocument({
		size: "A4",
		margins: { top: PAGE_MARGIN, right: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN },
		bufferPages: true,
		compress: true,
		info: {
			Title: options.title,
			Author: "PE-Workbench",
			Subject: options.topic,
			Creator: "PE-Workbench pe-boot",
			CreationDate: new Date(options.createdAt),
		},
	});
	document.registerFont(FONT_REGULAR, resolveFontPath("NotoSansHans-Regular.otf"));
	document.registerFont(FONT_BOLD, resolveFontPath("NotoSansHans-Bold.otf"));

	const chunks: Buffer[] = [];
	const completed = new Promise<Buffer>((resolve, reject) => {
		document.on("data", (chunk: Buffer) => chunks.push(chunk));
		document.on("end", () => resolve(Buffer.concat(chunks)));
		document.on("error", reject);
	});

	document.font(FONT_BOLD).fontSize(24).fillColor(ACCENT_COLOR).text(options.title, { lineGap: 4 });
	document.moveDown(0.5);
	document
		.moveTo(PAGE_MARGIN, document.y)
		.lineTo(document.page.width - PAGE_MARGIN, document.y)
		.lineWidth(1.4)
		.strokeColor(ACCENT_COLOR)
		.stroke();
	document.moveDown(0.9);
	writeMetadataRow(document, "主题", options.topic);
	writeMetadataRow(document, "数据集", options.datasetId);
	writeMetadataRow(document, "版本", `v${options.versionNo} (${options.memoVersionId})`);
	if (options.revisionOf) writeMetadataRow(document, "修订自", options.revisionOf);
	writeMetadataRow(document, "资料基准日", options.asOfDate);
	writeMetadataRow(document, "生成时间", options.createdAt);

	for (const section of options.sections) {
		ensureVerticalSpace(document, 90);
		document.moveDown(1.2);
		document.font(FONT_BOLD).fontSize(14).fillColor(ACCENT_COLOR).text(section.title, { lineGap: 2 });
		document.moveDown(0.35);
		for (const claim of section.claims) writeClaim(document, claim);
	}

	ensureVerticalSpace(document, 120);
	document.moveDown(1.2);
	document.font(FONT_BOLD).fontSize(14).fillColor(ACCENT_COLOR).text("资料边界");
	document.moveDown(0.35);
	document
		.font(FONT_REGULAR)
		.fontSize(9.5)
		.fillColor(MUTED_COLOR)
		.text("• 本 Memo 仅使用当前项目工作区的结构化资料。", { indent: 10, paragraphGap: 4 })
		.text("• “资料未覆盖”表示当前资料没有覆盖该问题；“待复核”表示引用缺失、无效或结论仍需人工判断。", {
			indent: 10,
			lineGap: 2,
		});

	addPageFurniture(document, options.memoVersionId);
	document.end();
	return completed;
}
