import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { sourceId, sourceUrl } from "@earendil-works/pe-boot/source";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { normalizeDisplayMath } = await jiti.import("../lib/markdown.ts");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function renderMarkdown(markdown, props = {}) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(MarkdownBody, {
        cwd: "/home/me/project",
        onOpenFile() {},
        ...props,
      }, markdown),
    ),
  );
}

test("opens non-file markdown links in a safe new tab", () => {
  const html = renderMarkdown("[docs](https://example.com/docs)");

  assert.match(
    html,
    /<a (?=[^>]*href="https:\/\/example\.com\/docs")(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>docs<\/a>/,
  );
  assert.doesNotMatch(html, /\snode=/);
});

test("keeps local file markdown links in the app", () => {
  const html = renderMarkdown("[file](components/MarkdownBody.tsx)");

  assert.match(html, /<a href="components\/MarkdownBody\.tsx">file<\/a>/);
  assert.doesNotMatch(html, /target=|rel=|\snode=/);
});

test("renders PE evidence links as compact source markers with accessible labels", () => {
  const id = sourceId({ docId: "doc-1", location: { kind: "pdf", pageStart: 2, pageEnd: 2 } });
  const html = renderMarkdown(
    `结论。[访谈.pdf p.2](${sourceUrl(id)})`,
  );

  assert.match(html, /data-pe-source-citation="true"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
  assert.match(html, /<span class="sr-only">查看原始证据：访谈\.pdf p\.2<\/span>/);
  assert.match(html, /title="查看原始证据：访谈\.pdf p\.2"/);
  assert.ok(!html.includes(id));
});

test("renders legacy PE evidence links as compact source markers", () => {
  const html = renderMarkdown("结论。[访谈.pdf p.2](#pe-source?evidence_id=chunk%3Achunk-storage)");

  assert.match(html, /data-pe-source-citation="true"/);
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
  assert.match(html, /<span class="sr-only">查看原始证据：访谈\.pdf p\.2<\/span>/);
  assert.doesNotMatch(html, /chunk-storage/);
});

test("restores compact source markers for expanded citation URLs in existing answers", () => {
  const html = renderMarkdown("结论。[年报 p.11](https://pe-workbench.local/pe-source?evidence_id=chunk%3A79ec64a5c48325c412a23d00d979e354216d1598)");
  assert.match(html, /data-pe-source-citation="true"/);
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
  assert.match(html, /<span class="sr-only">查看原始证据：年报 p\.11<\/span>/);
  assert.doesNotMatch(html, /target="_blank"|href="https:\/\/pe-workbench/);
});

test("renders a valid pe-ui entity card as native UI", () => {
  const markdown = `\`\`\`pe-ui
{"version":1,"type":"entity-card","entity":"company","name":"比亚迪","metrics":[{"label":"收入","value":"8,210亿元"}]}
\`\`\``;
  const html = renderMarkdown(markdown);

  assert.match(html, /aria-label="company: 比亚迪"/);
  assert.match(html, />公司</);
  assert.match(html, />8,210亿元</);
  assert.doesNotMatch(html, /language-pe-ui/);
});

test("renders a chart with an editorial summary as native UI", () => {
  const markdown = `\`\`\`pe-ui
{"version":1,"type":"chart","chart":"line","title":"增长正在失速","categories":["2024","2025"],"series":[{"name":"营业收入","values":[7771.02,8039.65],"unit":"亿元"}]}
\`\`\``;
  const html = renderMarkdown(markdown);

  assert.match(html, /增长正在失速/);
  assert.match(html, /aria-label="折线图"/);
  assert.match(html, /较上期/);
  assert.doesNotMatch(html, /language-pe-ui/);
});

test("falls back to source code for an invalid completed pe-ui block", () => {
  const html = renderMarkdown("```pe-ui\n{invalid}\n```");

  assert.match(html, /markdown-code-lang[^>]*>pe-ui</);
  assert.match(html, /\{invalid\}/);
});

test("keeps incomplete pe-ui blocks as loading placeholders during streaming", () => {
  const html = renderMarkdown('```pe-ui\n{"version":1,"type":"entity-card"', { isStreaming: true });

  assert.match(html, /role="status"/);
  assert.match(html, /aria-label="正在生成界面"/);
  assert.doesNotMatch(html, /markdown-code-block/);
});

test("renders emphasis next to Chinese punctuation", () => {
  const html = renderMarkdown("这是**“重点”**内容，**结论（已核实）。**请继续。", { isStreaming: true });
  assert.match(html, /<strong>“重点”<\/strong>/);
  assert.match(html, /<strong>结论（已核实）。<\/strong>/);
});

test("keeps Chinese punctuation outside automatic links", () => {
  const html = renderMarkdown("来源 https://example.com。后续说明。");
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /<\/a>。后续说明。/);
});

test("completes streaming emphasis without changing completed text", () => {
  assert.match(renderMarkdown("结论：**持续增长", { isStreaming: true }), /<strong>持续增长<\/strong>/);
  assert.match(renderMarkdown("结论：**持续增长"), /\*\*持续增长/);
});

test("keeps incomplete streaming links as text until their target arrives", () => {
  const html = renderMarkdown("查看[来源](https://exam", { isStreaming: true });
  assert.match(html, /来源/);
  assert.doesNotMatch(html, /<a\b|streamdown:|href=/);
});

test("preserves code controls and switches from raw streaming code to highlighting", () => {
  const code = "```typescript\nconst value = 42;\n";
  const streaming = renderMarkdown(code, { isStreaming: true });
  const completed = renderMarkdown(`${code}\`\`\``);
  for (const html of [streaming, completed]) {
    assert.match(html, /markdown-code-block/);
    assert.match(html, /markdown-code-lang">typescript/);
    assert.match(html, /markdown-code-action/);
    assert.doesNotMatch(html, /\snode=/);
  }
  assert.match(streaming, /const value = 42;/);
  assert.doesNotMatch(streaming, /linenumber/);
  assert.match(completed, /linenumber/);
  assert.match(renderMarkdown("```\nplain code\n```"), /markdown-code-lang">text/);
  assert.match(renderMarkdown("`inline`"), /class="markdown-inline-code">inline<\/code>/);
});

test("retains Mermaid source and disables preview during streaming", () => {
  const code = "```mermaid\ngraph TD\n  A --> B\n```";
  assert.match(renderMarkdown(code), /markdown-code-lang">mermaid/);
  assert.match(renderMarkdown(code, { isStreaming: true }), /disabled=""/);
});

test("preserves table alignment and local image routing", () => {
  const html = renderMarkdown("| 指标 | 金额 |\n| :--- | ---: |\n| 收入 | 100 |\n\n![图](./chart.png)");
  assert.match(html, /markdown-table-wrap/);
  assert.match(html, /<td style="text-align:right">100<\/td>/);
  assert.match(html, /src="\/api\/files\/.*chart\.png\?type=read"/);
  assert.match(html, /loading="lazy"/);
});

test("hides frontmatter and sanitizes HTML in static and streaming messages", () => {
  const markdown = '---\ntitle: hidden-metadata\n---\n\n<b>Visible</b><script>badScript()</script><iframe src="https://example.com"></iframe><img src="x" onerror="badEvent()" /><span style="color:red">Text</span>\n\n[unsafe](javascript:alert(1))';
  for (const isStreaming of [false, true]) {
    const html = renderMarkdown(markdown, { isStreaming });
    assert.match(html, /<b>Visible<\/b>/);
    assert.doesNotMatch(html, /hidden-metadata|badScript|badEvent|<iframe|onerror|color:red|javascript:/);
  }
});

test("preserves document-wide references during streaming", () => {
  const markdown = "[资料][doc]\n\n另一段。\n\n[doc]: https://example.com/report";
  for (const isStreaming of [false, true]) {
    const html = renderMarkdown(markdown, { isStreaming });
    assert.match(html, /href="https:\/\/example\.com\/report"/);
  }
});

test("keeps frontmatter rules consistent without hiding ordinary separators", () => {
  for (const isStreaming of [false, true]) {
    assert.doesNotMatch(renderMarkdown("\uFEFF---\r\ntitle: hidden\r\n---\r\n\r\n正文", { isStreaming }), /hidden/);
    assert.match(renderMarkdown("正文\n\n---\n\n后续", { isStreaming }), /<hr/);
    assert.match(renderMarkdown("---\ntitle: incomplete", { isStreaming }), /incomplete/);
  }
});

test("keeps single-tilde CJK numeric ranges literal instead of striking them", () => {
  for (const isStreaming of [false, true]) {
    const html = renderMarkdown("5~7U 保证金 × 100~200倍杠杆", { isStreaming });
    assert.doesNotMatch(html, /<del>/);
    assert.match(html, /5~7U/);
    assert.match(html, /100~200倍/);
  }
});

test("still renders double-tilde strikethrough", () => {
  const html = renderMarkdown("~~gone~~");

  assert.match(html, /<del>gone<\/del>/);
});

test("renders LaTeX parenthesis delimiters as inline math", () => {
  const html = renderMarkdown(String.raw`射线为 \(r_c = K^{-1}p\)。`);

  assert.match(html, /class="katex"/);
  assert.match(html, /r_c/);
});

test("renders paired LaTeX bracket delimiters as display math", () => {
  const html = renderMarkdown(String.raw`\[
P(\lambda)=o_b+\lambda r_b
\]`);
  const oneLineHtml = renderMarkdown(String.raw`\[P(\lambda)=o_b+\lambda r_b\]`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /lambda/);
  assert.match(oneLineHtml, /class="katex-display"/);
});

test("leaves an unmatched LaTeX bracket delimiter unchanged", () => {
  const markdown = String.raw`before
\[
x + y
after`;

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside Markdown code", () => {
  const markdown = "    \\(indented\\)\n\n`code\n\\(inline\\)`\n\n```text\n\\[\nfenced\n\\]\n```";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside raw HTML code", () => {
  const markdown = "<code>\\(inline\\)</code>\n\n<pre>\n\\(block\\)\n</pre>";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize escaped delimiters or link destinations", () => {
  const escaped = String.raw`Literal: \\(x+y\\).`;
  const link = String.raw`[docs](https://example.com/\(manual\))`;

  assert.equal(normalizeDisplayMath(escaped), escaped);
  assert.equal(normalizeDisplayMath(link), link);
});
