import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchWindSnapshot, listWindSnapshots, WIND_CATEGORIES, windApiKey } from "../trusted-sources.ts";

export const peTrustedSourceTool = defineTool({
	name: "pe_trusted_source",
	label: "可信源 · Wind",
	description:
		"Fetch Wind A-share, HK and US quotes, financials, company events, holders, announcements or news into immutable project evidence. Fetch uses paid quota. For quote, query is a company name or exact Wind code (at most 50 comma-separated). For other categories, query must specify company/topic, requested facts and absolute dates/reporting period. Personnel changes should be checked in announcements. Preserves original response, dates and units without treating media or forecasts as confirmed facts. Use list to discover saved snapshots and pe_source_detail to inspect exact source: line citations. Reuse unchanged snapshots. Does not publish a framework or create a schedule.",
	promptSnippet:
		"Use pe_trusted_source to fetch and save Wind external evidence for A/HK/US research, or list saved snapshots. Cite returned source: IDs; distinguish retrieval time, publication time, units, forecasts and original publishers. News retrieval is not independent verification; empty results are not proof of no change.",
	parameters: Type.Object({
		operation: Type.Union([Type.Literal("status"), Type.Literal("list"), Type.Literal("fetch")]),
		category: Type.Optional(Type.Union(WIND_CATEGORIES.map((value) => Type.Literal(value)))),
		query: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
	}),
	async execute(_id, params, signal, _onUpdate, ctx) {
		signal?.throwIfAborted();
		if (params.operation === "fetch" && (!params.category || !params.query))
			throw new Error("Fetch requires category and query");
		const result =
			params.operation === "status"
				? {
						provider: "wind",
						configured: Boolean(windApiKey()),
						permissions: "Verify per category with an actual fetch",
						categories: WIND_CATEGORIES,
					}
				: params.operation === "list"
					? { snapshots: listWindSnapshots(ctx.cwd) }
					: await fetchWindSnapshot(ctx.cwd, { category: params.category!, query: params.query! }, signal);
		return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
	},
});
