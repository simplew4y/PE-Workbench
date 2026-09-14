# Wind market response contract

Verified on 2026-09-14 against the stock MCP service. The regression fixtures in
`test/tracking-market.test.ts` retain the observed structure with synthetic prices.

| Request | Observed response |
| --- | --- |
| `get_stock_price_indicators` | `content[].text` is JSON with `data.columns: [{name, type}]`, `data.rows`, and `data.unit`. Relevant columns: `最新交易日` (`20260914`), `交易时间` (`2026-09-14T16:08:10.000+08:00`), `最新成交价`, `Wind代码`. `unit["最新成交价"]` was `港币`. |
| `get_stock_kline` | Columns include `TIME`, `OPEN`, `MATCH`, `HIGH`, `LOW`, `TURNOVER`, `VOLUME`, `CHANGEHANDRATE`, `AVPRICE`. `MATCH` is the daily closing value; `TIME` was midnight with an explicit offset. `unit["MATCH 单位："]` was `港币`. No stock-code column was returned; the single-stock request identifies the series. |

The live MCP `tools/list` schema uses `period: "10"` for daily bars. The
[Wind CLI reference](https://github.com/Wind-Alice/AliceMarket/blob/main/skills/wind-mcp-skill/references/stock.md)
documents the CLI alias `1d`; this SDK calls MCP directly. Requests explicitly use
`aftype: "2"` (unadjusted), `issusp: "0"`, `count: 0`, and absolute dates.

The original response, request identity and history range are saved as immutable
Wind snapshots. Each normalized price cites bounded `textChunks` lines containing
its source timestamp and price, including rows beyond the first 100 lines.
Current quotes remain separate from historical closes. Unknown units, mismatched
codes, malformed dates, duplicate days and out-of-range bars fail normalization.
