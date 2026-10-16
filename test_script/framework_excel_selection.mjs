import { openPeDataset } from "../packages/pe-boot/src/tools/database.ts";
import { readWorkbookDocumentAsync } from "../packages/pe-boot/src/workbook-reader.ts";
import { excelColumnLabel, parseExcelCellRange } from "../packages/pe-boot/src/source.ts";

export async function workbookCatalog(db, datasetId, docId, signal) {
	const cached = db.prepare("SELECT sheet_name,used_range FROM excel_sheets WHERE dataset_id=? AND doc_id=? ORDER BY sheet_index").all(datasetId, docId);
	const sheets = cached.length ? cached : (await readWorkbookDocumentAsync(db, datasetId, docId, { action: "inspect", section: "sheets", limit: 200 }, { signal })).sheets;
	const labels = db.prepare(`SELECT sheet_name,cell_ref,display_value FROM excel_cells WHERE dataset_id=? AND doc_id=?
		AND col_index<=5 AND numeric_value IS NULL AND is_formula=0 AND length(trim(display_value)) BETWEEN 2 AND 100
		ORDER BY sheet_name,row_index,col_index LIMIT 80`).all(datasetId, docId);
	return { sheets: sheets.map(sheet => ({ name: sheet.sheet_name, usedRange: sheet.used_range })),
		labels: labels.map(cell => ({ sheet: cell.sheet_name, cell: cell.cell_ref, label: cell.display_value })),
		instruction: "仅为定位目录，不包含完整工作簿。优先使用框架已有单元格引用；地址未知时按指标原文及期间检索，找不到则记录缺口。" };
}

export function validateExcelReads(reads = []) {
	if (!Array.isArray(reads) || reads.length > 8) throw new Error("最多选择8处关键Excel范围");
	let cells = 0;
	for (const read of reads) {
		if (!read || ![read.docId, read.sheet, read.purpose].every(value => typeof value === "string" && value.trim()))
			throw new Error("Excel读取需要docId、sheet和对应核心观点的purpose");
		if (read.range !== undefined) {
			const bounds = parseExcelCellRange(read.range);
			if (!bounds) throw new Error("Excel需要精确单元格或小范围，不能读取整行整列");
			cells += (bounds.rowEnd - bounds.rowStart + 1) * (bounds.columnEnd - bounds.columnStart + 1);
		} else {
			if (typeof read.query !== "string" || !read.query.trim() || read.query.length > 100 ||
				(read.periods !== undefined && (!Array.isArray(read.periods) || read.periods.length > 3 || read.periods.some(period => typeof period !== "string" || !period.trim() || period.length > 30))))
				throw new Error("Excel检索需要一个指标名称及最多3个期间");
			cells += 25;
		}
	}
	if (cells > 200) throw new Error("关键Excel读取合计最多200个单元格（每项指标检索预留25格）");
	return reads;
}

export async function readSelectedExcel(materials, reads, signal) {
	validateExcelReads(reads);
	const { database: db } = openPeDataset(materials.baseline.project, materials.baseline.datasetId);
	try {
		const receipts = [];
		for (const request of reads) {
			signal?.throwIfAborted();
			const receipt = { request, cells: [], gaps: [], status: "returned" };
			try {
				const book = materials.documents.find(doc => doc.id === request.docId && doc.workbook);
				if (!book || !book.workbook.sheets.some(sheet => sheet.name === request.sheet)) throw new Error("工作表不属于本轮空间资料");
				const budget = request.range ? 200 : 25;
				const seen = new Set();
				function append(cells) {
					for (const cell of cells) {
						const key = `${cell.sheet_name}!${cell.cell_ref}`;
						if (seen.has(key) || receipt.cells.length >= budget) continue;
						seen.add(key);
						const value = String(cell.display_value ?? "");
						receipt.cells.push({ sheet: cell.sheet_name, cell: cell.cell_ref, value: value.slice(0, 600), numericValue: cell.numeric_value,
							formula: cell.formula?.slice(0, 500), numberFormat: cell.number_format, cacheStatus: cell.formula_cache_status,
							...(value.length > 600 || cell.formula?.length > 500 ? { truncated: true } : {}) });
					}
				}
				const read = options => readWorkbookDocumentAsync(db, materials.baseline.datasetId, request.docId, options, { signal });
				if (request.range) {
					append((await read({ action: "read", sheet: request.sheet, range: request.range, limit: 200 })).cells);
				} else {
					const matches = await read({ action: "search", sheet: request.sheet, query: request.query, limit: 3 });
					append(matches.cells);
					if (matches.matching_cell_count > 1) receipt.gaps.push("指标有多个匹配，以下为候选；需结合表头和框架确认，不能默认已定位。");
					const ranges = [];
					if (request.periods?.length) {
						for (const period of request.periods) {
							const periodMatches = await read({ action: "search", sheet: request.sheet, query: period, limit: 3 });
							const headers = periodMatches.cells;
							if (periodMatches.matching_cell_count > 1) receipt.gaps.push(`${period}有多个期间匹配，以下为候选；需结合表头和框架确认，不能默认已定位该期间。`);
							append(headers);
							let found = false;
							for (const metric of matches.cells) for (const header of headers) {
								if (header.row_index >= metric.row_index || header.col_index <= metric.col_index) continue;
								ranges.push({ sheet: request.sheet, range: `${excelColumnLabel(header.col_index)}${metric.row_index}` });
								found = true;
							}
							if (!found) receipt.gaps.push(`未能明确定位${period}列，未猜测该期间数值；可沿用框架已有精确地址。`);
						}
					} else {
						for (const metric of matches.cells) if (metric.col_index < 16_384) ranges.push({ sheet: request.sheet,
							range: `${excelColumnLabel(metric.col_index + 1)}${metric.row_index}` });
						receipt.gaps.push("无期间的指标仅提供标签右侧相邻值，须结合原框架判断其含义。");
					}
					if (ranges.length) append((await read({ action: "read", ranges: ranges.slice(0, budget - receipt.cells.length), limit: budget - receipt.cells.length })).cells);
				}
				if (!receipt.cells.length) receipt.gaps.push("未找到关键单元格，不代表原假设已被验证。");
			} catch (error) {
				signal?.throwIfAborted();
				receipt.status = "failed"; receipt.error = error.message;
			}
			receipts.push(receipt);
		}
		return receipts;
	} finally { db.close(); }
}
