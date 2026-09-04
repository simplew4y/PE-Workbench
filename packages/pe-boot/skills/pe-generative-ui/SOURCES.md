# Sources and Adaptation Notes

This Skill is an original PE-Workbench adaptation informed by these public implementations. It does not embed their runtimes or permit arbitrary generated code.

## CopilotKit OpenGenerativeUI

- Repository: https://github.com/CopilotKit/OpenGenerativeUI
- Master playbook: https://github.com/CopilotKit/OpenGenerativeUI/blob/main/apps/agent/skills/master-playbook/SKILL.md
- SVG diagrams: https://github.com/CopilotKit/OpenGenerativeUI/blob/main/apps/agent/skills/svg-diagrams/SKILL.md
- Advanced visualization: https://github.com/CopilotKit/OpenGenerativeUI/blob/main/apps/agent/skills/advanced-visualization/SKILL.md
- License: MIT
- Adapted ideas: progressive disclosure, visual selection, narrative rhythm, and separating text explanation from UI compression.

## A2UI

- Repository: https://github.com/a2ui-project/a2ui
- Protocol: https://github.com/a2ui-project/a2ui/blob/main/specification/v1_0/docs/a2ui_protocol.md
- License: Apache-2.0
- Adapted ideas: versioned declarative data, a trusted component catalog, stable surface identity, strict validation, and transport-independent rendering.

## Vercel AI Elements and AI SDK

- AI Elements Skill: https://github.com/openai/plugins/blob/main/plugins/vercel/skills/ai-elements/SKILL.md
- AI SDK: https://github.com/vercel/ai
- Chatbot example: https://github.com/vercel/chatbot
- Adapted ideas: typed message parts, streaming-safe rendering, explicit tool states, and restrained conversational UI.

## assistant-ui

- Repository: https://github.com/assistant-ui/assistant-ui
- Tool UI registration discussion: https://github.com/assistant-ui/assistant-ui/discussions/3951
- Adapted idea: renderers are pre-registered so persisted history and server rendering do not depend on dynamically injected component code.

## MCP Apps

- Repository: https://github.com/modelcontextprotocol/ext-apps
- Specification: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- Reserved idea: sandboxed interactive apps may be added later for calculators and scenario models. The current PE renderer intentionally uses trusted native components instead.
