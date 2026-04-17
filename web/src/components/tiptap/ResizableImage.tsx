import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { useCallback, useRef, useState } from "react";

function ResizableImageView({ node, updateAttributes, selected }: ReactNodeViewProps) {
  const { src, alt, width } = node.attrs;
  const imgRef = useRef<HTMLImageElement>(null);
  const [resizing, setResizing] = useState(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = imgRef.current?.offsetWidth ?? 200;

      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const newWidth = Math.max(80, startWidth + delta);
        updateAttributes({ width: newWidth });
      };

      const onMouseUp = () => {
        setResizing(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      setResizing(true);
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [updateAttributes],
  );

  return (
    <NodeViewWrapper className="doc-resizable-img" data-drag-handle>
      <div
        className={`doc-resizable-img__wrap${selected ? " doc-resizable-img__wrap--selected" : ""}${resizing ? " doc-resizable-img__wrap--resizing" : ""}`}
        style={{ width: width ? `${width}px` : undefined, maxWidth: "100%" }}
      >
        <img
          ref={imgRef}
          src={src as string}
          alt={(alt as string) || ""}
          draggable={false}
          style={{ width: "100%", display: "block" }}
        />
        {selected && (
          <>
            <div className="doc-resizable-img__handle doc-resizable-img__handle--e" onMouseDown={onMouseDown} />
            <div
              className="doc-resizable-img__handle doc-resizable-img__handle--w"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const startX = e.clientX;
                const startWidth = imgRef.current?.offsetWidth ?? 200;

                const onMouseMove = (ev: MouseEvent) => {
                  const delta = startX - ev.clientX;
                  const newWidth = Math.max(80, startWidth + delta);
                  updateAttributes({ width: newWidth });
                };

                const onMouseUp = () => {
                  setResizing(false);
                  document.removeEventListener("mousemove", onMouseMove);
                  document.removeEventListener("mouseup", onMouseUp);
                };

                setResizing(true);
                document.addEventListener("mousemove", onMouseMove);
                document.addEventListener("mouseup", onMouseUp);
              }}
            />
          </>
        )}
      </div>
    </NodeViewWrapper>
  );
}

export const ResizableImage = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
      width: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "img[src]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const attrs: Record<string, any> = { ...HTMLAttributes };
    if (attrs.width) {
      attrs.style = `width: ${attrs.width}px`;
      delete attrs.width;
    }
    return ["img", mergeAttributes(attrs)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ResizableImageView);
  },

  addCommands(): any {
    return {
      setImage:
        (options: { src: string; alt?: string; title?: string; width?: number }) =>
        ({ commands }: { commands: any }) => {
          return commands.insertContent({
            type: this.name,
            attrs: options,
          });
        },
    };
  },
});

export default ResizableImage;
