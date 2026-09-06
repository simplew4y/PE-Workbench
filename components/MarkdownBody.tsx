"use client";

import { createContext, useContext, useMemo, type ComponentProps, type MouseEvent } from "react";
import { cjk } from "@streamdown/cjk";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
import { Streamdown, parseMarkdownIntoBlocks, type Components, type ExtraProps, type PluginConfig } from "streamdown";
import { resolveLocalFileHref } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { markdownRehypePlugins, markdownRemarkPlugins, normalizeDisplayMath } from "@/lib/markdown";
import { parsePeSourceHref } from "@/lib/pe-source";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";
import { PeSourceCitation } from "./PeSourceCitation";
import { PeUiBlock } from "./pe-ui/PeUiBlock";

const plugins: PluginConfig = {
  cjk: {
    ...cjk,
    remarkPluginsAfter: cjk.remarkPluginsAfter.map((plugin) => (
      plugin === remarkCjkFriendlyGfmStrikethrough ? [remarkCjkFriendlyGfmStrikethrough, { singleTilde: false }] : plugin
    )),
  },
};
const streamingOptions = { linkMode: "text-only" } as const;

interface MarkdownRenderContextValue {
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}

const MarkdownRenderContext = createContext<MarkdownRenderContextValue>({});

interface MarkdownBodyProps extends MarkdownRenderContextValue {
  children: string;
  className?: string;
}

function MarkdownCode({ className, children, ...props }: ComponentProps<"code"> & ExtraProps) {
  const { isStreaming, cwd, onOpenFile } = useContext(MarkdownRenderContext);
  delete props.node;
  const lang = className?.replace("language-", "").toLowerCase() ?? "";
  const raw = String(children);
  const isBlock = className?.includes("language-") || raw.includes("\n");
  if (isBlock) {
    if (lang === "mermaid") {
      return <MermaidBlock code={raw.replace(/\n$/, "")} isStreaming={isStreaming} />;
    }
    if (lang === "pe-ui") {
      return (
        <PeUiBlock
          code={raw.replace(/\n$/, "")}
          isStreaming={isStreaming}
          cwd={cwd}
          onOpenFile={onOpenFile}
        />
      );
    }
    return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} isStreaming={isStreaming} />;
  }
  return <code className="markdown-inline-code" {...props}>{children}</code>;
}

function MarkdownLink({ href, children, ...props }: ComponentProps<"a"> & ExtraProps) {
  const { cwd, onOpenFile } = useContext(MarkdownRenderContext);
  delete props.node;
  const peSource = parsePeSourceHref(href);
  if (peSource && cwd) {
    return (
      <PeSourceCitation className={props.className} cwd={cwd} evidenceId={peSource.evidenceId}>
        {children}
      </PeSourceCitation>
    );
  }
  const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
  if (!filePath || !onOpenFile) {
    return <a href={href} {...props} target="_blank" rel="noopener noreferrer">{children}</a>;
  }

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.currentTarget.getAttribute("target");
    if (target && target !== "_self") return;
    event.preventDefault();
    onOpenFile(filePath);
  };

  return <a href={href} {...props} onClick={handleClick}>{children}</a>;
}

function MarkdownImage({ src, alt, ...props }: ComponentProps<"img"> & ExtraProps) {
  const { cwd } = useContext(MarkdownRenderContext);
  delete props.node;
  const filePath = typeof src === "string" ? resolveLocalFileHref(src, cwd) : null;
  const imageSrc = filePath ? `/api/files/${encodeFilePathForApi(filePath)}?type=read` : src;
  // Dynamic local paths are served directly by the file API.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
}

// Context updates reach these components even when Streamdown's memo skips its
// own render. Stable component identities also preserve previews across updates.
const components: Components = {
  // Keep semantic elements and let the shared Markdown CSS own typography.
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  h5: "h5",
  h6: "h6",
  p: "p",
  strong: "strong",
  ol: "ol",
  ul: "ul",
  li: "li",
  hr: "hr",
  blockquote: "blockquote",
  thead: "thead",
  tbody: "tbody",
  tr: "tr",
  th: "th",
  td: "td",
  sup: "sup",
  sub: "sub",
  section: "section",
  code: MarkdownCode,
  pre({ children }) {
    return <>{children}</>;
  },
  a: MarkdownLink,
  img: MarkdownImage,
  table({ children }) {
    return (
      <div className="markdown-table-wrap">
        <table>{children}</table>
      </div>
    );
  },
};

function splitMarkdown(markdown: string): string[] {
  // Frontmatter and reference definitions need document-wide parsing. Leave
  // their syntax to remark; splitting them first can expose YAML or lose links.
  if (/^\uFEFF?---[ \t]*(?:\r\n|\n|\r)/.test(markdown) || /^ {0,3}\[(?:\\[^\r\n]|[^\]\\])+\]:/m.test(markdown)) {
    return [markdown];
  }
  return parseMarkdownIntoBlocks(markdown);
}

export function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile }: MarkdownBodyProps) {
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children]);
  const renderContext = useMemo(() => ({ cwd, isStreaming, onOpenFile }), [cwd, isStreaming, onOpenFile]);

  return (
    <MarkdownRenderContext.Provider value={renderContext}>
      <Streamdown
        className={["markdown-body space-y-0", className].filter(Boolean).join(" ")}
        mode={isStreaming ? "streaming" : "static"}
        isAnimating={isStreaming}
        plugins={plugins}
        remend={streamingOptions}
        remarkPlugins={markdownRemarkPlugins ?? undefined}
        rehypePlugins={markdownRehypePlugins ?? undefined}
        components={components}
        parseMarkdownIntoBlocksFn={splitMarkdown}
      >
        {normalizedMarkdown}
      </Streamdown>
    </MarkdownRenderContext.Provider>
  );
}
