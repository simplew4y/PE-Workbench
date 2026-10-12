import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchOfficialFilings, OFFICIAL_FILING_PROVIDERS } from "../official-filings.ts";
import { fetchWindSnapshot, listWindSnapshots, WIND_CATEGORIES, windApiKey } from "../trusted-sources.ts";

export const peTrustedSourceTool = defineTool({
	name: "pe_trusted_source",
	label: "可信金融与官方披露源",
	description:
		"Fetch Wind market/financial data or ask the independent financial-information service to collect original filings from CNINFO, HKEX and SEC EDGAR. Wind fetch uses paid quota. Official filing requests are archived, deduplicated, screened and delivered back as immutable project evidence before framework review. Configure the service URL/token in PE-Workbench and SEC_EDGAR_USER_AGENT in the service. Queries are bounded and empty results never prove no disclosure. The tool does not publish a framework or create a schedule.",
	promptSnippet:
		"Use pe_trusted_source for Wind data and operation=fetch_official for original CNINFO, HKEX or SEC filings. Read returned document versions before revising a framework; preserve unaffected fields and trace evidence → assumption → thesis → valuation → monitoring. Cite source: IDs and distinguish disclosed facts from analysis. Empty results are not proof of no change.",
	parameters: Type.Object({
		operation: Type.Union([
			Type.Literal("status"),
			Type.Literal("list"),
			Type.Literal("fetch"),
			Type.Literal("fetch_official"),
		]),
		category: Type.Optional(Type.Union(WIND_CATEGORIES.map((value) => Type.Literal(value)))),
		query: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
		provider: Type.Optional(Type.Union(OFFICIAL_FILING_PROVIDERS.map((value) => Type.Literal(value)))),
		securityCode: Type.Optional(
			Type.String({ minLength: 1, maxLength: 10, description: "CNINFO/HKEX stock code or SEC CIK." }),
		),
		startDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
		endDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
	}),
	async execute(_id, params, signal, _onUpdate, ctx) {
		signal?.throwIfAborted();
		if (params.operation === "fetch" && (!params.category || !params.query))
			throw new Error("Fetch requires category and query");
		if (
			params.operation === "fetch_official" &&
			(!params.provider || !params.securityCode || !params.startDate || !params.endDate)
		)
			throw new Error("Official filing fetch requires provider, securityCode, startDate and endDate");
		const result =
			params.operation === "status"
				? {
						wind: { configured: Boolean(windApiKey()), categories: WIND_CATEGORIES },
						officialFilings: { providers: OFFICIAL_FILING_PROVIDERS },
						permissions: "Verify per category with an actual fetch",
					}
				: params.operation === "list"
					? { snapshots: listWindSnapshots(ctx.cwd) }
					: params.operation === "fetch_official"
						? await fetchOfficialFilings(
								ctx.cwd,
								{
									provider: params.provider!,
									securityCode: params.securityCode!,
									startDate: params.startDate!,
									endDate: params.endDate!,
									query: params.query,
									limit: params.limit,
								},
								signal,
							)
						: await fetchWindSnapshot(ctx.cwd, { category: params.category!, query: params.query! }, signal);
		return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
	},
});
