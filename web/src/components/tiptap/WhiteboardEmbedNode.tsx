import { Node, mergeAttributes } from "@tiptap/react";
import { ReactNodeViewRenderer, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { useEffect, useState } from "react";
import { fetchWhiteboard } from "../../api";

function WhiteboardEmbedView({ node }: ReactNodeViewProps) {
  const whiteboardId = node.attrs.whiteboardId as number;
  const mode = (node.attrs.mode as string) || "live";
  const snapshotUrl = node.attrs.snapshotUrl as string | undefined;
  const [thumbnail, setThumbnail] = useState<string | null>(snapshotUrl || null);
  const [name, setName] = useState<string>("");
  const [error, setError] = useState(false);

  useEffect(() => {
    if (mode === "static" && snapshotUrl) {
      setThumbnail(snapshotUrl);
      return;
    }
    void fetchWhiteboard(whiteboardId)
      .then((wb) => {
        setThumbnail(wb.thumbnail || null);
        setName(wb.name);
      })
      .catch(() => setError(true));
  }, [whiteboardId, mode, snapshotUrl]);

  return (
    <NodeViewWrapper className="doc-wb-embed" data-mode={mode}>
      <div className={`doc-wb-embed__inner doc-wb-embed--${mode}`}>
        {error ? (
          <div className="doc-wb-embed__error">Whiteboard #{whiteboardId} not found</div>
        ) : thumbnail ? (
          <img src={thumbnail} alt={name || `Whiteboard #${whiteboardId}`} className="doc-wb-embed__img" />
        ) : (
          <div className="doc-wb-embed__placeholder">Loading whiteboard...</div>
        )}
        <div className="doc-wb-embed__label">
          {mode === "live" ? "\u{1F504}" : "\u{1F4F7}"} {name || `Whiteboard #${whiteboardId}`}
          <span className="doc-wb-embed__badge">{mode}</span>
        </div>
      </div>
    </NodeViewWrapper>
  );
}

export const WhiteboardEmbed = Node.create({
  name: "whiteboardEmbed",
  group: "block",
  atom: true,

  addAttributes() {
    return {
      whiteboardId: { default: 0 },
      mode: { default: "live" },
      snapshotUrl: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-whiteboard-embed]",
        getAttrs: (el) => {
          const dom = el as HTMLElement;
          return {
            whiteboardId: Number(dom.getAttribute("data-whiteboard-id")),
            mode: dom.getAttribute("data-mode") || "live",
            snapshotUrl: dom.getAttribute("data-snapshot-url") || null,
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-whiteboard-embed": "",
        "data-whiteboard-id": HTMLAttributes.whiteboardId,
        "data-mode": HTMLAttributes.mode,
        "data-snapshot-url": HTMLAttributes.snapshotUrl || "",
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(WhiteboardEmbedView);
  },
});

export default WhiteboardEmbed;
