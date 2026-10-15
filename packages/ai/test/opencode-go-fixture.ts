import { getModel } from "../src/compat.ts";

// Pin historical protocol regressions independently of the live OpenCode Go catalog.
export const opencodeGoKimiFixture = {
	...getModel("opencode", "kimi-k2.6"),
	provider: "opencode-go",
	thinkingLevelMap: { minimal: null, low: null, medium: null },
	baseUrl: "https://opencode.ai/zen/go/v1",
} as const;
