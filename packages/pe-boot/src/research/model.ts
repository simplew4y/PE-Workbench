import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

const text = Type.String({ minLength: 1, maxLength: 8_000, pattern: "\\S" });
const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" });
export const FrameworkContentSchema = Type.Object(
	{
		title: Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }),
		objective: text,
		horizon: text,
		items: Type.Array(
			Type.Object(
				{
					id,
					kind: Type.Union([
						Type.Literal("thesis"),
						Type.Literal("hypothesis"),
						Type.Literal("metric"),
						Type.Literal("event"),
						Type.Literal("question"),
					]),
					claim: text,
					rationale: text,
					subject: text,
					verification: text,
					invalidation: text,
					origin: Type.Union([Type.Literal("user"), Type.Literal("research")]),
					evidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
						maxItems: 100,
						uniqueItems: true,
					}),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 100 },
		),
		coverageGaps: Type.Array(text, { maxItems: 100 }),
	},
	{ additionalProperties: false },
);

export type FrameworkContent = Static<typeof FrameworkContentSchema>;
export interface ResearchInput {
	docId: string;
	version: number;
	parserVersion: string | null;
	readyAt: string;
}
export interface FrameworkDraft {
	id: string;
	baseVersionId: string | null;
	revision: number;
	status: "open" | "published" | "rejected";
	content: FrameworkContent;
	inputs: ResearchInput[];
	createdAt: string;
}
export interface FrameworkVersion {
	id: string;
	version: number;
	parentVersionId: string | null;
	content: FrameworkContent;
	inputs: ResearchInput[];
	createdAt: string;
}
export interface FrameworkState {
	currentVersionId: string | null;
	drafts: FrameworkDraft[];
	versions: FrameworkVersion[];
}

export class ResearchError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "ResearchError";
		this.status = status;
	}
}

const validator = Compile(FrameworkContentSchema);
export function validateFrameworkContent(value: unknown): FrameworkContent {
	if (!validator.Check(value)) throw new ResearchError(400, "Invalid framework content");
	if (new Set(value.items.map((item) => item.id)).size !== value.items.length)
		throw new ResearchError(400, "Framework item IDs must be unique");
	for (const item of value.items) {
		if (item.origin === "research" && item.evidenceIds.length === 0)
			throw new ResearchError(
				400,
				"Research claims require evidence; unverified user hypotheses must be labeled user",
			);
	}
	return value;
}
