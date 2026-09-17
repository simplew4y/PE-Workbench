import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import type { Root, RootContent } from "hast";
import { markdownRemarkPlugins, markdownRehypePlugins, normalizeDisplayMath } from "./markdown";

const blockTags = new Set(["p", "div", "section", "blockquote", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "table", "thead", "tbody", "tr", "th", "td", "br", "hr"]);
const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
const processor = unified()
  .use(remarkParse)
  .use(markdownRemarkPlugins ?? [])
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(markdownRehypePlugins ?? []);

function visibleText(node: Root | RootContent): string {
  if (node.type === "text") return node.value;
  if (!("children" in node)) return "";
  const content = node.children.map(visibleText).join("");
  return node.type === "element" && blockTags.has(node.tagName) ? "\n" + content + "\n" : content;
}

/** Validate browser selections against the stored answer's sanitized rendered text.
 * Markdown emphasis and link destinations must not force a whole-answer fallback.
 */
export function isRenderedResearchExcerpt(original: string, excerpt: string): boolean {
  const selected = normalize(excerpt);
  if (!selected) return false;
  // Parse and sanitize the same Markdown tree as the UI without rendering React
  // components: App Router server modules cannot import react-dom/server.
  const markdown = normalizeDisplayMath(original);
  const tree = processor.runSync(processor.parse(markdown), markdown);
  return normalize(visibleText(tree)).includes(selected);
}
