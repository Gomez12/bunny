import { isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import MermaidBlock from "./MermaidBlock";

const REMARK_PLUGINS = [remarkGfm];
// Skip mermaid so rehype-highlight doesn't rewrite its className or children.
const REHYPE_PLUGINS: [typeof rehypeHighlight, { plainText: string[] }][] = [
  [rehypeHighlight, { plainText: ["mermaid"] }],
];

const MERMAID_DIRECTIVE =
  /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|sankey-beta|xychart-beta|block-beta)\b/;

function collectText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return collectText(props.children);
  }
  return "";
}

function extractMermaidSource(children: ReactNode): string | null {
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement(child)) return null;
  const props = child.props as { className?: string; children?: ReactNode };
  const hasTag = props.className ? /\blanguage-mermaid\b/.test(props.className) : false;
  const text = collectText(props.children).replace(/\n$/, "");
  if (hasTag) return text;
  // Fallback: untagged fence whose content starts with a mermaid directive.
  if (!props.className && MERMAID_DIRECTIVE.test(text)) return text;
  return null;
}

const COMPONENTS: Components = {
  pre(props) {
    const source = extractMermaidSource(props.children);
    if (source !== null) return <MermaidBlock code={source} />;
    return <pre {...props} />;
  },
};

interface Props {
  text: string;
}

export default function MarkdownContent({ text }: Props) {
  const [mode, setMode] = useState<"md" | "raw">("md");
  return (
    <div className="bubble__content-wrap">
      <button
        type="button"
        className="bubble__md-toggle"
        onClick={() => setMode((m) => (m === "md" ? "raw" : "md"))}
        title={mode === "md" ? "Show raw markdown" : "Render markdown"}
      >
        {mode === "md" ? "raw" : "md"}
      </button>
      {mode === "md" ? (
        <div className="bubble__content bubble__content--markdown">
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={COMPONENTS}
          >
            {text}
          </ReactMarkdown>
        </div>
      ) : (
        <div className="bubble__content">{text}</div>
      )}
    </div>
  );
}
