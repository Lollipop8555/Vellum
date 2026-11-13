import { Attention, AttentionInfo, Handle, State } from "mdast-util-to-markdown";
//#region src/phrasing.d.ts
type AttentionHandle = Handle & {
  peek?: Handle;
  attention?: (node: Parameters<Attention>[0], state: State) => AttentionInfo & {
    cjkFriendly?: boolean;
  };
};
/** Mark an attention handler for CJK-aware encoding and pairing. */
declare function cjkFriendlyAttention(handle: Handle): AttentionHandle;
/** Install the container before serializing a document or a phrasing block. */
declare const cjkFriendlyPhrasingHandlers: {
  root: Handle;
  paragraph: Handle;
  heading: Handle;
};
//#endregion
export { cjkFriendlyAttention, cjkFriendlyPhrasingHandlers };