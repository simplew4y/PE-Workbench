import { Type } from "typebox";
import { Compile } from "typebox/compile";
import {
	type IterationObservations,
	IterationObservationsSchema,
	validateIterationObservations,
} from "./iteration-model.ts";
import { ResearchError } from "./model.ts";

export const IterationExtractionSubmissionSchema = Type.Object(
	{
		observations: Type.Optional(IterationObservationsSchema.properties.observations),
		coverage: Type.Optional(IterationObservationsSchema.properties.coverage),
		removeObservationIds: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 8000 }), { maxItems: 200 }),
		),
	},
	{ additionalProperties: false },
);
const submissionValidator = Compile(IterationExtractionSubmissionSchema);

/** Retain unchanged observations during repairs; the merged result still requires full validation. */
export function mergeExtractionSubmission(
	previous: IterationObservations | undefined,
	input: unknown,
): IterationObservations {
	if (!submissionValidator.Check(input)) throw new ResearchError(400, "Invalid extraction submission");
	if (!previous) {
		if (!input.observations || !input.coverage)
			throw new ResearchError(
				400,
				"当前会话首次提交（包括恢复后的首次提交）必须同时包含完整observations和coverage。历史参考稿不会自动合并；请提交全部保留观察和每份新资料的coverage，再按ID局部修正。",
			);
		return structuredClone(validateIterationObservations(input));
	}
	if (!input.observations?.length && !input.coverage && !input.removeObservationIds?.length)
		throw new ResearchError(400, "修正提交不能为空。");
	const replacements = input.observations ?? [];
	if (new Set(replacements.map((o) => o.id)).size !== replacements.length)
		throw new ResearchError(400, "Duplicate observation IDs");
	const removed = new Set(input.removeObservationIds ?? []);
	if (removed.size && (!input.coverage || !input.coverage.some((c) => c.gaps.length)))
		throw new ResearchError(400, "删除无法核实的观察时，必须在coverage.gaps记录遗漏及原因。");
	if (
		[...removed].some((id) => !previous.observations.some((o) => o.id === id)) ||
		replacements.some((o) => removed.has(o.id))
	)
		throw new ResearchError(400, "删除ID不存在或同时被修正。");
	const merged = new Map(previous.observations.filter((o) => !removed.has(o.id)).map((o) => [o.id, o]));
	for (const observation of replacements) merged.set(observation.id, observation);
	return structuredClone(
		validateIterationObservations({
			observations: [...merged.values()],
			coverage: input.coverage ?? previous.coverage,
		}),
	);
}
