# Add a Tiptap node

## When you need this

The Documents editor needs a new custom block — an embed, a callout, a chart, whatever markdown doesn't model natively.

Existing custom node: `WhiteboardEmbedNode` (`web/src/components/tiptap/WhiteboardEmbedNode.tsx`). That's the reference pattern.

## Steps

1. **Decide the markdown representation.** Every custom node must round-trip through markdown. Use a fenced block with a unique lang tag so `tiptap-markdown` sees it as a known format:
   ```markdown
   ```my-node
   {"id": 42, "mode": "live"}
   ```
   ```
   The lang tag (`my-node`) is the node's identifier. JSON body is flexible.

2. **Write the React node view.** `web/src/components/tiptap/MyNode.tsx`:
   ```tsx
   import { NodeViewWrapper, NodeViewProps } from "@tiptap/react";

   export default function MyNodeView({ node }: NodeViewProps) {
     const data = node.attrs.data;
     return (
       <NodeViewWrapper className="my-node">
         {/* render the node */}
       </NodeViewWrapper>
     );
   }
   ```

3. **Define the Tiptap `Node` extension.** Same file or adjacent:
   ```ts
   import { Node, mergeAttributes } from "@tiptap/core";
   import { ReactNodeViewRenderer } from "@tiptap/react";
   import MyNodeView from "./MyNodeView";

   export const MyNode = Node.create({
     name: "myNode",
     group: "block",
     atom: true,
     draggable: true,

     addAttributes() {
       return { data: { default: null } };
     },

     parseHTML() {
       return [{ tag: "div[data-my-node]" }];
     },

     renderHTML({ HTMLAttributes }) {
       return ["div", mergeAttributes(HTMLAttributes, { "data-my-node": "" })];
     },

     addNodeView() {
       return ReactNodeViewRenderer(MyNodeView);
     },
   });
   ```

4. **Register it in `DocumentEditor.tsx`.** Add to the extensions list:
   ```ts
   extensions: [
     StarterKit.configure({…}),
     Markdown.configure({…}),
     MyNode,
   ]
   ```

5. **Wire markdown serialisation.** If `tiptap-markdown` doesn't know your node, add a custom serializer/parser:
   ```ts
   Markdown.configure({
     tightLists: true,
     linkify: false,
     html: false,
     parseOptions: {
       nodeMatchers: {
         "my-node": (token) => ({
           type: "myNode",
           attrs: { data: JSON.parse(token.content) },
         }),
       },
     },
     serializeOptions: {
       nodes: {
         myNode: (state, node) => {
           state.write("```my-node\n");
           state.write(JSON.stringify(node.attrs.data));
           state.write("\n```\n");
         },
       },
     },
   });
   ```

6. **Add a ribbon button.** In `DocumentRibbon.tsx`:
   ```tsx
   <button
     onClick={() => editor.chain().focus().insertContent({
       type: "myNode",
       attrs: { data: defaultData },
     }).run()}
   >
     Insert my node
   </button>
   ```

7. **Test round-trip.** Type in the editor → save → reload → content matches. Test with the markdown visible (WYSIWYG/code mode toggle in the ribbon).

## Rules

- **Markdown is canonical.** A node that can't round-trip loses its content on save+reload.
- **One node type = one lang tag.** Don't overload.
- **`atom: true` if the node has no editable text inside.** Otherwise users can type inside a block they shouldn't.
- **`draggable: true` lets users reorder blocks.** Almost always wanted.
- **Respect the theme.** Use tokens, not hard-coded colours.

## Validation

1. Insert the node via the ribbon button. Looks right.
2. Save the document. Reopen. Still renders correctly.
3. Toggle code mode. The markdown representation is what you expect.
4. Edit the markdown in code mode. Toggle back to WYSIWYG. Node re-parses.
5. DOCX export (`POST /api/documents/:id/export/docx`) — the node is either preserved or falls back gracefully. Note: custom nodes don't survive DOCX natively; they render as thumbnails or fall back to a placeholder.

## Related

- [`../ui/tiptap-extensions.md`](../ui/tiptap-extensions.md)
- [`../entities/documents.md`](../entities/documents.md)
- `web/src/components/tiptap/WhiteboardEmbedNode.tsx` — reference example.
