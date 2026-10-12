import { expect, it, vi } from "vitest";
import { createResilientFetch, retryAfterMilliseconds } from "../src/resilient-fetch.ts";

it("honors Retry-After and recovers from a throttled upstream", async () => {
	const request = vi
		.fn()
		.mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "2" } }))
		.mockResolvedValueOnce(new Response("ok"));
	const delays: number[] = [];
	const resilient = createResilientFetch(request, {
		minimumIntervalMs: () => 0,
		wait: async (milliseconds) => {
			delays.push(milliseconds);
		},
	});

	const response = await resilient("https://data.sec.gov/submissions/example.json");

	expect(await response.text()).toBe("ok");
	expect(request).toHaveBeenCalledTimes(2);
	expect(delays).toContain(2000);
});

it("parses both Retry-After formats with a bounded delay", () => {
	expect(retryAfterMilliseconds(new Response(null, { headers: { "retry-after": "3" } }), 0)).toBe(3000);
	expect(
		retryAfterMilliseconds(new Response(null, { headers: { "retry-after": "Thu, 01 Jan 1970 00:02:00 GMT" } }), 0),
	).toBe(60_000);
});
