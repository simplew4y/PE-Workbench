import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { informationSourceConfig } from "../information-source-model.ts";
import { parseSourceId } from "../source.ts";
import { workbookContextSourceSchema } from "../workbook-context.ts";
import type { FrameworkIteration } from "./iteration-model.ts";
import {
	getIterationModelConfig,
	IterationModelConfigInputSchema,
	readCurrentIterationWorkbook,
} from "./iteration-model-update.ts";
import { type FrameworkContent, ResearchError } from "./model.ts";
import { readResearchInput } from "./pi-engine.ts";
import { shanghaiToday, trackingPeriods } from "./tracking-periods.ts";

const text = Type.String({ minLength: 1, maxLength: 1000 });
export const AutomaticSetupSchema = Type.Object(
	{
		companyName: Type.String({ minLength: 1, maxLength: 200 }),
		companyTicker: text,
		valuationDate: Type.Union([Type.String({ pattern: "^20\\d{2}-\\d{2}-\\d{2}$" }), Type.Null()]),
		dateSource: Type.Union([workbookContextSourceSchema, Type.Null()]),
		dateLabelSource: Type.Union([workbookContextSourceSchema, Type.Null()]),
		identitySources: Type.Array(Type.Object({ evidenceId: text, quote: text }, { additionalProperties: false }), {
			maxItems: 6,
		}),
		model: IterationModelConfigInputSchema,
		summary: text,
	},
	{ additionalProperties: false },
);
export type AutomaticSetup = Static<typeof AutomaticSetupSchema>;
const validator = Compile(AutomaticSetupSchema);

export function validateAutomaticSetup(
	cwd: string,
	datasetId: string,
	run: FrameworkIteration,
	basis: FrameworkContent,
	input: unknown,
): AutomaticSetup {
	if (!validator.Check(input)) throw new ResearchError(400, "自动识别结果尚不完整，请继续核对已有文件。");
	const setup = input;
	if (!run.inputs.some((doc) => doc.docId === setup.model.docId))
		throw new ResearchError(400, "识别的模型不属于本轮项目文件。");
	const source = informationSourceConfig(setup.companyName, setup.companyTicker, ["wind-financials"]);
	const explicitCodes = [
		...new Set(JSON.stringify(basis).match(/\b[A-Z0-9-]+\.(?:HK|SH|SZ|BJ|O|N|PA|L|US)\b/gu) ?? []),
	];
	const identityQuotes: string[] = [];
	for (const identity of setup.identitySources) {
		const reference = parseSourceId(identity.evidenceId);
		if (!reference || !run.inputs.some((input) => input.docId === reference.docId))
			throw new ResearchError(400, "公司身份引用不属于本项目资料。");
		const location = reference.location;
		if (location.kind === "block") throw new ResearchError(400, "请引用可直接读取的公司身份原文页、文本行或单元格。");
		const value =
			location.kind === "excel"
				? readCurrentIterationWorkbook(cwd, datasetId, reference.docId, {
						action: "read",
						sheet: location.sheet,
						range: location.range,
						limit: 100,
					})
				: (readResearchInput(
						cwd,
						datasetId,
						{ objective: "核对公司身份", inputs: run.inputs, asOf: run.createdAt },
						{
							docId: reference.docId,
							...(location.kind === "pdf"
								? { page: location.pageStart }
								: { lineStart: location.lineStart, lineEnd: location.lineEnd }),
						},
					) as Record<string, unknown>);
		const original =
			typeof value.text === "string"
				? value.text
				: ((value.cells as Record<string, unknown>[]) ?? [])
						.map((cell) => String(cell.display_value ?? cell.raw_value ?? ""))
						.join("\n");
		if (!original.replace(/\s/gu, "").includes(identity.quote.replace(/\s/gu, "")))
			throw new ResearchError(400, "公司身份引述与项目原文不符，请重新读取。");
		identityQuotes.push(identity.quote);
	}
	const identity = identityQuotes.join("\n");
	const documentedIdentity =
		identity.toUpperCase().includes(source.companyTicker) && identity.includes(setup.companyName);
	if (
		run.company?.ticker
			? run.company.ticker.toUpperCase() !== source.companyTicker
			: !documentedIdentity && (explicitCodes.length !== 1 || explicitCodes[0] !== source.companyTicker)
	)
		throw new ResearchError(400, "证券代码与项目或现有框架尚未对应，请继续查阅项目内的身份信息，不能猜测。");
	if (
		!JSON.stringify(basis).includes(setup.companyName) &&
		setup.companyName !== run.company?.name &&
		!documentedIdentity
	)
		throw new ResearchError(400, "公司名称尚未与现有框架对应，请继续核对原文。");
	if (setup.valuationDate) trackingPeriods(setup.valuationDate, shanghaiToday(new Date(run.createdAt)));
	if ((setup.model.valuationDate ?? null) !== setup.valuationDate)
		throw new ResearchError(400, "模型日期与识别的估值日期不一致。");
	if ((getIterationModelConfig(cwd, datasetId)?.revision ?? 0) !== setup.model.expectedRevision)
		throw new ResearchError(409, "本轮识别期间模型已更新，请重新运行。");
	if (setup.valuationDate === null) {
		if (setup.dateSource || setup.dateLabelSource)
			throw new ResearchError(400, "估值日期未确认时保留空值，不得附上替代日期。");
	} else if (setup.dateSource && setup.dateLabelSource) {
		for (const context of [setup.dateSource, setup.dateLabelSource]) {
			const result = readCurrentIterationWorkbook(cwd, datasetId, setup.model.docId, {
				action: "read",
				sheet: context.sheet,
				range: context.cell,
				limit: 1,
			});
			const cell = (result.cells as Record<string, unknown>[] | undefined)?.[0];
			const actual = context.field === "number_format" ? cell?.number_format : cell?.display_value;
			if (String(actual ?? "").trim() !== context.text.trim())
				throw new ResearchError(400, "估值日期或标签引述与模型原文不符，请重新读取。");
		}
		const date = /(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})/u.exec(setup.dateSource.text);
		if (!date || `${date[1]}-${date[2].padStart(2, "0")}-${date[3].padStart(2, "0")}` !== setup.valuationDate)
			throw new ResearchError(400, "估值日期须与模型中的日期原文一致，不能根据文件名推断。");
	} else if (
		setup.dateSource ||
		setup.dateLabelSource ||
		!basis.sections.valuation.scenarios.some((scenario) => scenario.asOf === setup.valuationDate)
	) {
		throw new ResearchError(400, "请在现有模型中查明估值日期及其标签，或沿用框架已明确的估值基准日。");
	}
	const judgments = new Set(basis.sections.investmentJudgments.items.map((judgment) => judgment.id));
	for (let offset = 0; offset < setup.model.mappings.length; offset += 100) {
		const mappings = setup.model.mappings.slice(offset, offset + 100);
		const result = readCurrentIterationWorkbook(cwd, datasetId, setup.model.docId, {
			action: "read",
			ranges: mappings.map((mapping) => ({ sheet: mapping.sheet, range: mapping.cell })),
			limit: 1000,
		});
		if (result.model_version_id !== setup.model.baseVersionId)
			throw new ResearchError(409, "当前模型版本已改变，请重新识别。");
		const cells = result.cells as Record<string, unknown>[];
		for (const mapping of mappings) {
			const cell = cells.find((item) => item.sheet_name === mapping.sheet && item.cell_ref === mapping.cell);
			if (
				!cell ||
				cell.is_formula ||
				typeof mapping.expectedValue !== "number" ||
				cell.numeric_value !== mapping.expectedValue
			)
				throw new ResearchError(
					400,
					`${mapping.sheet}!${mapping.cell}必须是已读取的数值输入，原值须与当前模型一致，不能改写公式。`,
				);
			if (mapping.judgmentIds?.some((id) => !judgments.has(id)))
				throw new ResearchError(400, "模型输入关联了不存在的框架假设。");
		}
	}
	return setup;
}
