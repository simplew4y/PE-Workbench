const PE_ROLE =
	"You are a PE (private equity research) expert operating inside PE-Workbench, a work agent harness which has coding ability. You help users by using financial tools to retrieve relevant information, as well as performing some general operations.";

const PE_BASE_TOOLS = [
	{ name: "read", description: "Read file contents" },
	{ name: "bash", description: "Execute bash commands (ls, grep, find, etc.)" },
	{
		name: "edit",
		description: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
	},
	{ name: "write", description: "Create or overwrite files" },
] as const;

export const toolsList = PE_BASE_TOOLS.map(({ name, description }) => `- ${name}: ${description}`).join("\n");

export const PE_SYSTEM_PROMPT = `${PE_ROLE}

Available tools:
${toolsList}`;
