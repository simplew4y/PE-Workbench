import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { queryWind } from "../packages/pe-boot/src/trusted-sources.ts";

// 复用现有客户端的鉴权、MCP 握手、超时与错误处理，不创建项目快照。
export async function printWindData(requests, fetcher = queryWind, output = process.stdout) {
	for (const request of requests) {
		const result = await fetcher(request);
		const texts = result.content.filter((block) => block.type === "text" && typeof block.text === "string");
		if (!texts.length) throw new Error("WIND_EMPTY_RESPONSE: Wind 未返回数据文本");
		for (const block of texts) output.write(`${block.text}\n`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		await printWindData(JSON.parse(readFileSync(0, "utf8")));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
