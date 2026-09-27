# Wind trusted-source integration

`pe_trusted_source` is registered with the existing PE agent extension. No separate MCP server installation or new dependency is required. The SDK exports `fetchWindSnapshot`, `listWindSnapshots`, and `queryWind` for backend callers.

## Credentials

Set `WIND_API_KEY` in the server environment, or use the local user file `~/.wind-aifinmarket/config` containing `WIND_API_KEY=...` (permissions 0600). Environment configuration takes precedence. The tool exposes only whether a key is configured, never the key. Data permissions and credits remain Wind account properties.

## Agent usage

```json
{"operation":"status"}
{"operation":"fetch","category":"quote","query":"0700.HK"}
{"operation":"fetch","category":"financials","query":"查询苹果公司（AAPL.O）2025财年营业收入、净利润、报告期和单位"}
{"operation":"fetch","category":"announcements","query":"查询腾讯控股（0700.HK）2026-09-01至2026-09-14高管变动公告，返回发布日期与原文链接"}
{"operation":"list"}
```

Categories: `quote`, `financials`, `events`, `holders`, `announcements`, `news`. Quotes accept at most 50 comma-separated names/codes. Other queries should name the company/topic, requested information, and absolute period. Announcement/news retrieval is capped at five results per request and is **not** an exhaustive change feed. Use announcements to investigate personnel changes; the structured events endpoint does not establish complete personnel coverage.

## Evidence flow

1. Query a fixed, read-only Wind MCP endpoint with a 60-second request budget and 4 MB response limit. No automatic paid retries or alternative-provider fallback.
2. Save successful responses as versioned TXT originals through the existing document catalog. HTTP, JSON-RPC, MCP and explicit backend errors are not saved as evidence.
3. Store provider, query, category, endpoint, tool, retrieval time, evidence type and original MCP response. Text chunks make long response bodies accessible through bounded line citations. The retrieval time is not a publication or event time.
4. Repeating the same query with an identical response reuses the existing document version. A changed response creates a new version. This compares whole query responses, not independently identified news events; changing the query also creates a different document identity.
5. `pe_source_detail` resolves the returned `source:` references, including historical versions, and checks the original checksum. `pe_document_open` renders a line-cited reading view.
6. Framework proposals and background research can select these document IDs as fixed inputs. The isolated research engine reads snapshots with `pe_research_read` (`lineStart`, `lineEnd`); it does not fetch mutable live data during a run.

Wind is the retrieval provider. Original publishers, publication dates, currencies, units, actuals/forecasts and revisions must be checked in the returned material. Announcement results may include retrieval excerpts or summaries; saving them does not mean the exchange original PDF was downloaded. Media articles and internal memos are not independent confirmation of their claims. No result is not proof of no event.

## Scope

This connects retrieval, persistence, citation preview and framework evidence input. It does not install a periodic monitor, infer a watchlist, automatically publish framework versions, download linked attachments, or add a source-management UI. Existing framework publication behavior is unchanged. These application policies are separate from Wind access.

For an existing server, compile the PE SDK using the normal development workflow and reload the server/session to register the new tool. A browser refresh alone does not replace an already-created agent's tool registry.

## Validation

`test/trusted-sources.test.ts` covers fake MCP responses, historical citations, unchanged-response reuse, framework publication with pinned inputs, tampered originals, cross-project rejection, backend/authentication errors and reading long news responses. Unit tests make no paid requests.

Upstream contracts: [stock tools](https://github.com/Wind-Alice/AliceMarket/blob/main/skills/wind-mcp-skill/references/stock.md), [announcement/news tools](https://github.com/Wind-Alice/AliceMarket/blob/main/skills/wind-mcp-skill/references/financial-docs.md).
