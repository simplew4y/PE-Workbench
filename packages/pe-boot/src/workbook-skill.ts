import { fileURLToPath } from "node:url";

export const financialModelReaderSkillPath = fileURLToPath(
	new URL("../skills/pe-financial-model-reader/SKILL.md", import.meta.url),
);
