import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	availablePeCapabilities,
	PE_LAZY_TOOL_NAMES,
	PE_SKILLS_DIRECTORY,
	type PeCapabilityOptions,
	resolvePeCapabilities,
} from "./capabilities.ts";

import { buildToolsList } from "./system-prompt.ts";

const STATE_TYPE = "pe-capability-state";
const CONTEXT_TYPE = "pe-capability-instructions";

interface LoadedWorkflows {
	ids: string[];
	instructions: string;
	revision: string;
	tools: string[];
}

function readWorkflows(ids: readonly string[]): LoadedWorkflows {
	const normalizedIds = [...new Set(ids)].sort();
	const capabilities = resolvePeCapabilities(normalizedIds);
	const files = [...new Set(capabilities.flatMap((capability) => capability.files))];
	const instructions = files
		.map((file) => {
			const path = join(PE_SKILLS_DIRECTORY, file);
			const { frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8"));
			if (frontmatter["disable-model-invocation"] === true)
				throw new Error(`PE workflow is disabled for model invocation: ${file}`);
			return `<workflow_file path="${path}">\n${body}\n</workflow_file>`;
		})
		.join("\n\n");
	return {
		ids: normalizedIds,
		instructions,
		revision: createHash("sha256").update(instructions).digest("hex").slice(0, 16),
		tools: [...new Set(capabilities.flatMap((capability) => capability.tools))],
	};
}

function savedIds(ctx: ExtensionContext): string[] | undefined {
	const entry = ctx.sessionManager
		.getBranch()
		.reverse()
		.find((item) => item.type === "custom" && item.customType === STATE_TYPE);
	if (entry?.type !== "custom" || !entry.data || typeof entry.data !== "object") return undefined;
	const data = entry.data as { version?: unknown; ids?: unknown };
	if (data.version !== 1 || !Array.isArray(data.ids) || !data.ids.every((id): id is string => typeof id === "string"))
		return undefined;
	return data.ids;
}

export function registerPeCapabilities(pi: ExtensionAPI, options: PeCapabilityOptions = {}): void {
	let loaded: LoadedWorkflows | undefined;
	const lazyTools = (options.lazyUi ?? process.env.PE_LAZY_UI_ENABLED?.trim() !== "0") ? PE_LAZY_TOOL_NAMES : [];

	const activate = (next: LoadedWorkflows): string[] => {
		const active = pi.getActiveTools();
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		// Host-disabled regular tools stay disabled; only pilot lazy tools can be added.
		const additions = next.tools.filter(
			(name) =>
				lazyTools.includes(name) &&
				available.has(name) &&
				options.canActivateTool?.(name) !== false &&
				!active.includes(name),
		);
		if (additions.length) pi.setActiveTools([...active, ...additions]);
		return additions;
	};
	const persist = (next: LoadedWorkflows): void => {
		if (loaded?.revision === next.revision && JSON.stringify(loaded.ids) === JSON.stringify(next.ids)) return;
		pi.appendEntry(STATE_TYPE, { version: 1, ids: next.ids, revision: next.revision });
		loaded = next;
	};
	const restore = (_event: unknown, ctx: ExtensionContext): void => {
		loaded = undefined;
		const active = pi.getActiveTools();
		// Empty sessions remain empty. SDK allow-lists also filter getAllTools().
		if (active.length === 0) return;
		pi.setActiveTools(active.filter((name) => !lazyTools.includes(name)));
		const ids = savedIds(ctx) ?? options.initialCapabilities;
		const next = ids?.length ? readWorkflows(ids) : undefined;
		if (next) {
			activate(next);
			loaded = next;
		}
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);

	const capabilities = availablePeCapabilities();
	pi.registerTool(
		defineTool({
			name: "pe_load_capability",
			label: "Load PE workflow",
			description:
				"Load workflows for the current task and activate their permitted lazy native tools. Replaces the previous workflow selection; include all still-needed workflows (e.g. report + UI). Instructions are pinned once in context, including after compaction. Additional references remain readable by absolute path. Available: " +
				capabilities.map((capability) => `${capability.id}: ${capability.description}`).join("; "),
			parameters: Type.Object({
				capabilities: Type.Array(Type.Union(capabilities.map((capability) => Type.Literal(capability.id))), {
					minItems: 1,
					maxItems: 4,
				}),
			}),
			async execute(_id, args, signal) {
				signal?.throwIfAborted();
				const next = readWorkflows(args.capabilities);
				const available = new Set(pi.getAllTools().map((tool) => tool.name));
				if (
					next.tools.some(
						(name) =>
							lazyTools.includes(name) && (!available.has(name) || options.canActivateTool?.(name) === false),
					)
				)
					throw new Error("The session tool allow-list does not permit this capability's lazy tools.");
				signal?.throwIfAborted();
				const addedTools = activate(next);
				persist(next);
				const active = new Set(pi.getActiveTools());
				const unavailableTools = next.tools.filter((name) => !active.has(name));
				const details = { capabilities: next.ids, revision: next.revision, addedTools, unavailableTools };
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								...details,
								instructions:
									"Selected workflow files are supplied in PE workflow context. Follow them before calling tools. Unavailable tools remain unavailable; do not invent their results.",
							}),
						},
					],
					details,
				};
			},
		}),
	);

	pi.on("before_agent_start", (event) => {
		if (!loaded && options.initialCapabilities?.length && pi.getActiveTools().length) {
			persist(readWorkflows(options.initialCapabilities));
		}
		// Explicit host activation is a known entrypoint, including allow-lists without the loader.
		if (
			lazyTools.includes("pe_render_ui") &&
			pi.getActiveTools().includes("pe_render_ui") &&
			!loaded?.tools.includes("pe_render_ui") &&
			options.canActivateTool?.("pe_render_ui") !== false
		) {
			persist(readWorkflows([...(loaded?.ids ?? []), "pe-generative-ui"]));
		}
		return {
			systemPrompt: event.systemPrompt.replace(
				/Default tool capabilities \(actual availability follows native schemas\):\n[\s\S]*?\n\n/,
				() =>
					"Tools available at task start (native schemas track subsequent additions):\n" +
					buildToolsList(pi.getActiveTools()) +
					"\n\n",
			),
		};
	});
	pi.on("tool_call", (event) => {
		if (lazyTools.includes(event.toolName) && options.canActivateTool?.(event.toolName) === false)
			return { block: true, reason: "This tool is disabled by the session tool selection." };
		if (lazyTools.includes(event.toolName) && !loaded?.tools.includes(event.toolName))
			return {
				block: true,
				reason:
					'First call pe_load_capability with capabilities including "pe-generative-ui", then retry using its native schema.',
			};
	});
	pi.on("context", (event) => {
		const messages = event.messages.filter(
			(message) => message.role !== "custom" || message.customType !== CONTEXT_TYPE,
		);
		if (!loaded || pi.getActiveTools().length === 0) return { messages };
		const unavailableTools = loaded.tools.filter((name) => !pi.getActiveTools().includes(name));
		const instruction = {
			role: "custom" as const,
			customType: CONTEXT_TYPE,
			display: false,
			timestamp: 0,
			content:
				"PE workflows: " +
				loaded.ids.join(", ") +
				" (revision " +
				loaded.revision +
				").\nUnavailable tools: " +
				(unavailableTools.join(", ") || "none") +
				". Loading instructions never authorizes saving or trading. Files below are current workflow instructions; do not reread them unless needed for additional references.\n\n" +
				loaded.instructions,
		};
		// Never insert between an assistant tool call and its results.
		let index = messages.length - 1;
		while (index >= 0 && messages[index].role !== "user") index--;
		messages.splice(index < 0 ? 0 : index, 0, instruction);
		return { messages };
	});
}
