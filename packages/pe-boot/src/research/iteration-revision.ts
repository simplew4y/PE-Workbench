import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { type FrameworkContent, FrameworkContentSchema, ResearchError, validateFrameworkContent } from "./model.ts";

const judgment = FrameworkContentSchema.properties.sections.properties.investmentJudgments.properties.items.items;
export const IterationRevisionSubmissionSchema = Type.Object(
	{
		sections: Type.Optional(Type.Partial(FrameworkContentSchema.properties.sections)),
		judgmentUpdates: Type.Optional(
			Type.Array(
				Type.Object(
					{
						id: judgment.properties.id,
						patch: Type.Partial(Type.Omit(judgment, ["id"]), { additionalProperties: false }),
					},
					{ additionalProperties: false },
				),
				{ minItems: 1, maxItems: 100 },
			),
		),
	},
	{ additionalProperties: false },
);
const validator = Compile(IterationRevisionSubmissionSchema);

/** Preserve unchanged judgments on the server instead of asking the model to copy them. */
export function mergeIterationRevision(basis: FrameworkContent, input: unknown): FrameworkContent {
	if (!validator.Check(input)) throw new ResearchError(400, "Invalid framework revision patch");
	if (!Object.keys(input.sections ?? {}).length && !input.judgmentUpdates?.length)
		throw new ResearchError(400, "框架修订不能为空。");
	if (input.sections?.investmentJudgments && input.judgmentUpdates)
		throw new ResearchError(400, "判断章节与判断局部修订不能同时提交。");
	const candidate = structuredClone(basis);
	candidate.sections = { ...candidate.sections, ...input.sections };
	const seen = new Set<string>();
	for (const update of input.judgmentUpdates ?? []) {
		const index = candidate.sections.investmentJudgments.items.findIndex((item) => item.id === update.id);
		if (index < 0 || seen.has(update.id) || !Object.keys(update.patch).length)
			throw new ResearchError(400, "判断修订ID重复、不存在或未提供修改字段。");
		seen.add(update.id);
		candidate.sections.investmentJudgments.items[index] = {
			...candidate.sections.investmentJudgments.items[index],
			...update.patch,
		};
	}
	return validateFrameworkContent(candidate);
}
