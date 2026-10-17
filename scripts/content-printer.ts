// 独立运行（Node >=22.19），仅使用 Node 内置模块：
// node content-printer.ts /absolute/path/to/reader-output.jsonl
// node content-printer.ts /absolute/path/to/reader-output-directory
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const READER_TOOLS = new Set([
	"pe_workbook_inspect",
	"pe_workbook_search",
	"pe_excel_range",
	"pe_excel_cells",
	"pe_formula_trace",
	"pe_excel_render",
	"pe_research_read",
	"pe_session_workbook",
]);

export interface TextContent {
	type: "text";
	text: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTextContent(value: unknown): value is TextContent {
	return isObject(value) && value.type === "text" && typeof value.text === "string";
}

function extractContent(value: unknown): TextContent[] {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (Array.isArray(value)) return value.flatMap((entry: unknown) => extractContent(entry));
	if (!isObject(value)) return [];
	if (isTextContent(value)) return [value];
	// 会话 JSONL：只取 reader 的 toolResult.content，不打印聊天正文或 details。
	if (isObject(value.message)) {
		const message = value.message;
		if (message.role !== "toolResult" || typeof message.toolName !== "string" || !READER_TOOLS.has(message.toolName))
			return [];
		return extractContent(message.content);
	}
	// 单独保存的工具结果或 { content: [...] } 文件。
	if (value.role !== undefined && value.role !== "toolResult") return [];
	if (value.toolName !== undefined && (typeof value.toolName !== "string" || !READER_TOOLS.has(value.toolName)))
		return [];
	if (typeof value.content === "string" || Array.isArray(value.content)) return extractContent(value.content);
	return [];
}

/** 输入产物文件或目录；返回文件里已保存的 content，不重新读取 Excel 或生成内容。 */
export function loadContent(inputPath: string): TextContent[] {
	const path = resolve(inputPath);
	if (statSync(path).isDirectory()) {
		return readdirSync(path, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name))
			.filter((entry) => entry.isDirectory() || (entry.isFile() && [".json", ".jsonl", ".ndjson"].includes(extname(entry.name).toLowerCase())))
			.flatMap((entry) => loadContent(join(path, entry.name)));
	}
	const source = readFileSync(path, "utf8");
	if ([".jsonl", ".ndjson"].includes(extname(path).toLowerCase())) {
		return source.split(/\r?\n/).flatMap((line, index) => {
			if (!line.trim()) return [];
			try {
				return extractContent(JSON.parse(line));
			} catch (error) {
				throw new Error(`Invalid JSON at ${path}:${index + 1}`, { cause: error });
			}
		});
	}
	return extractContent(JSON.parse(source));
}

export function print(content: readonly TextContent[]): void {
	for (const block of content) console.log(block.text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const inputPath = process.argv[2];
		if (!inputPath) throw new Error("Usage: node content-printer.ts <reader-output-file-or-directory>");
		const content = loadContent(inputPath);
		if (!content.length) throw new Error("No saved reader content found. Provide a tool-result JSON file or session JSONL; navigation/manifest caches are not LLM content.");
		print(content);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
