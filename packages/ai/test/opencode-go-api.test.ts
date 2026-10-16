import { describe, expect, it, vi } from "vitest";
import { googleGenerativeAIApi } from "../src/api/google-generative-ai.lazy.ts";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import type { Context, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

vi.mock("../src/api/google-generative-ai.lazy.ts", () => ({
	googleGenerativeAIApi: vi.fn(),
}));

describe("OpenCode Go Google API dispatch", () => {
	it("routes both streaming entry points to the Google adapter without dropping catalog models", () => {
		const events = new AssistantMessageEventStream();
		const stream = vi.fn(() => events);
		const streamSimple = vi.fn(() => events);
		vi.mocked(googleGenerativeAIApi).mockReturnValue({ stream, streamSimple });
		const provider = opencodeGoProvider();
		// Keep this regression independent of changes to the remotely hydrated catalog.
		const model: Model<"google-generative-ai"> = {
			id: "gemini-regression",
			name: "Gemini regression fixture",
			provider: "opencode-go",
			api: "google-generative-ai",
			baseUrl: "https://example.invalid",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 4096,
		};
		const context: Context = { messages: [] };
		const options = { apiKey: "test-only" };
		expect(provider.stream(model, context, options)).toBe(events);
		expect(provider.streamSimple(model, context, options)).toBe(events);
		expect(stream).toHaveBeenCalledWith(model, context, options);
		expect(streamSimple).toHaveBeenCalledWith(model, context, options);
		for (const entry of provider.getModels().filter((entry) => entry.api === "google-generative-ai")) {
			expect(provider.stream(entry, context, options)).toBe(events);
		}
	});
});
