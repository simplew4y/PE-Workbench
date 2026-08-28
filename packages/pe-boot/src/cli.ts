#!/usr/bin/env node

import { main } from "@earendil-works/pi-coding-agent";
import { buildPeSystemPrompt } from "./system-prompt.ts";

process.title = "PE-Workbench";
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pe-workbench";
process.emitWarning = (() => {}) as typeof process.emitWarning;

const customPrompt = buildPeSystemPrompt(process.cwd());

await main([...process.argv.slice(2), "--system-prompt", customPrompt]);
