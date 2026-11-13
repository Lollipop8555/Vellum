import { n as cjkFriendlyPhrasingHandlers, t as cjkFriendlyAttention } from "./phrasing-D74LUlZv.mjs";
import { defaultHandlers } from "mdast-util-to-markdown";
//#region src/index.ts
/** Add CJK-friendly `toMarkdown` handlers for emphasis and strong. */
function cjkFriendlyToMarkdown() {
	return { handlers: {
		...cjkFriendlyPhrasingHandlers,
		emphasis: cjkFriendlyAttention(defaultHandlers.emphasis),
		strong: cjkFriendlyAttention(defaultHandlers.strong)
	} };
}
//#endregion
export { cjkFriendlyToMarkdown };
