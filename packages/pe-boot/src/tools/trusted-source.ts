import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchWindSnapshot, listWindSnapshots, WIND_CATEGORIES, windApiKey } from "../trusted-sources.ts";

export const peTrustedSourceTool = defineTool({
	name: "pe_trusted_source",
	label: "可信源 · Wind",
	description:
		"Fetch Wind A-share, HK and US quotes, financials, company events, holders, announcements, news or analytics into immutable project evidence. Fetch uses paid quota. For quote, query is an exact Wind code (at most 50 comma-separated). For other categories, specify company/topic, metrics and dates/reporting periods. analytics calls Alice Market analytics_data.get_financial_data for custom valuation calculations, historical valuation percentiles or cross-company computations that predefined tools cannot provide; it never substitutes for quote/K-line retrieval. State calculation inputs and assumptions, not a request for a guaranteed future price. Other categories use the corresponding specialized Wind MCP service. Use list to discover snapshots and pe_source_detail for exact citations. A fetch always calls Wind again; identical responses reuse the saved evidence. Does not publish a framework or create a schedule.",
	promptSnippet:
		"Use pe_trusted_source to fetch Wind data on each stock tracking update. financials supplies fundamentals; analytics maps to Alice Market get_financial_data for custom valuation computations unsupported by predefined services. Cite source: IDs and distinguish data from analytical assumptions. Empty results are not proof of no change.",
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
