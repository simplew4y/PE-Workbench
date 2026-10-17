import assert from "node:assert/strict";
import { test } from "node:test";
import { printWindData } from "./query_wind.mjs";

test("prints only Wind text blocks, preserving their content and request order", async () => {
	const requests = [{ category: "financials", query: "营业收入" }, { category: "news", query: "中国销售" }];
	const calls = [];
	let text = "";
	await printWindData(requests, async (request) => {
		calls.push(request);
		return { content: [{ type: "image", data: "ignored" }, { type: "text", text: `数据：${request.query}` }] };
	}, { write: (value) => { text += value; } });
	assert.deepEqual(calls, requests);
	assert.equal(text, "数据：营业收入\n数据：中国销售\n");
});

test("stops on failure without retrying or sending later paid requests", async () => {
	let calls = 0;
	let text = "";
	await assert.rejects(printWindData([{}, {}, {}], async () => {
		calls++;
		if (calls === 2) throw new Error("WIND_HTTP_403");
		return { content: [{ type: "text", text: "已返回数据" }] };
	}, { write: (value) => { text += value; } }), /WIND_HTTP_403/);
	assert.equal(calls, 2);
	assert.equal(text, "已返回数据\n");
});

test("does not print protocol envelopes when Wind returns no text", async () => {
	let text = "";
	await assert.rejects(printWindData([{}], async () => ({ content: [{ type: "image" }] }), {
		write: (value) => { text += value; },
	}), /WIND_EMPTY_RESPONSE/);
	assert.equal(text, "");
});
