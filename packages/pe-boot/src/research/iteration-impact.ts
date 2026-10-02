import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { type IterationImpacts, IterationImpactsSchema, validateIterationImpacts } from "./iteration-model.ts";
import { ResearchError } from "./model.ts";

export const IterationImpactSubmissionSchema = Type.Object(
	{
		substantive: Type.Optional(IterationImpactsSchema.properties.substantive),
		summary: Type.Optional(IterationImpactsSchema.properties.summary),
		impacts: Type.Optional(IterationImpactsSchema.properties.impacts),
		gaps: Type.Optional(IterationImpactsSchema.properties.gaps),
		impactUpdates: Type.Optional(
			Type.Array(
				Type.Object(
					{
						index: Type.Integer({ minimum: 0, maximum: 199 }),
						impact: IterationImpactsSchema.properties.impacts.items,
					},
					{ additionalProperties: false },
				),
				{ maxItems: 200 },
			),
		),
	},
	{ additionalProperties: false },
);
const validator = Compile(IterationImpactSubmissionSchema);

/** Array positions identify repairs without changing persisted impact documents. */
export function mergeImpactSubmission(previous: IterationImpacts | undefined, input: unknown): IterationImpacts {
	if (!validator.Check(input)) throw new ResearchError(400, "Invalid impact submission");
	const { impactUpdates, ...fields } = input;
	if (!previous) {
		if (impactUpdates || fields.substantive === undefined || !fields.summary || !fields.impacts || !fields.gaps)
			throw new ResearchError(
				400,
				"当前会话首次影响提交必须包含substantive、summary、impacts和gaps；历史稿仅作参考。",
			);
		return structuredClone(validateIterationImpacts(fields));
	}
	if (!Object.keys(fields).length && !impactUpdates?.length) throw new ResearchError(400, "影响修正提交不能为空。");
	if (fields.impacts && impactUpdates) throw new ResearchError(400, "impacts与impactUpdates不能同时提交。");
	if (
		impactUpdates &&
		(new Set(impactUpdates.map((u) => u.index)).size !== impactUpdates.length ||
			impactUpdates.some((u) => u.index >= previous.impacts.length))
	)
		throw new ResearchError(400, "影响修正index重复或不存在。");
	const merged = structuredClone({ ...previous, ...fields });
	for (const update of impactUpdates ?? []) merged.impacts[update.index] = structuredClone(update.impact);
	return validateIterationImpacts(merged);
}

/** Recognize annual aliases only; do not infer quarter, fiscal-year, or business equivalence. */
export function equivalentComparisonPeriod(left: string | null, right: string): boolean {
	if (!left) return false;
	const normalize = (value: string) => value.replace(/\s/g, "").toLowerCase();
	if (normalize(left) === normalize(right)) return true;
	const annual = (value: string) =>
		normalize(value).match(/^(?:截至)?(20\d{2})(?:e|年|年度|年全年|年12月31日止年度)?$/)?.[1];
	const year = annual(left);
	return !!year && year === annual(right);
}
