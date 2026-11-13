import { defaultHandlers } from "mdast-util-to-markdown";
import { asciiAlpha, asciiAlphanumeric, asciiPunctuation } from "micromark-util-character";
import { htmlBlockNames, htmlRawNames } from "micromark-util-html-tag-name";
import { classifyCharacter, classifyPrecedingCharacter, isCjk, isCjkOrIvs, isNonCjkPunctuation, isNonEmojiGeneralUseVS, isSpaceOrPunctuation, isUnicodeWhitespace } from "micromark-extension-cjk-friendly-util";
import { classifyCharacter as classifyCharacter$1 } from "micromark-util-classify-character";
//#region src/encode-info.ts
function firstCharacter(value) {
	return value[Symbol.iterator]().next().value ?? "";
}
function lastCharacter(value, end = value.length) {
	if (end === 0) return "";
	const lastCodeUnit = value.charCodeAt(end - 1);
	if (lastCodeUnit < 56320 || lastCodeUnit >= 57344 || end === 1 || (value.codePointAt(end - 2) ?? 0) < 65536) return value[end - 1];
	return value.slice(end - 2, end);
}
function classifyBefore(value) {
	const character = lastCharacter(value);
	const current = character.codePointAt(0) ?? null;
	const kind = classifyCharacter(current);
	return current !== null && isNonEmojiGeneralUseVS(kind) ? classifyPrecedingCharacter(kind, () => lastCharacter(value, value.length - character.length).codePointAt(0) ?? null, current) : kind;
}
function sides(before, after, marker) {
	const beforePunctuation = isNonCjkPunctuation(before);
	const afterPunctuation = isNonCjkPunctuation(after);
	const beforeSpaceOrPunctuation = beforePunctuation || isUnicodeWhitespace(before);
	const afterSpaceOrPunctuation = afterPunctuation || isUnicodeWhitespace(after);
	const open = !afterSpaceOrPunctuation || afterPunctuation && (beforeSpaceOrPunctuation || isCjkOrIvs(before));
	const close = !beforeSpaceOrPunctuation || beforePunctuation && (afterSpaceOrPunctuation || isCjk(after));
	return {
		open: marker === "_" ? open && (isSpaceOrPunctuation(before) || !close) : open,
		close: marker === "_" ? close && (isSpaceOrPunctuation(after) || !open) : close
	};
}
function attentionSides(before, after, marker, cjk) {
	if (cjk) return sides(classifyBefore(before), classifyCharacter(after.codePointAt(0) ?? null), marker);
	const previous = classifyCharacter$1(lastCharacter(before).codePointAt(0) ?? null);
	const next = classifyCharacter$1(after.codePointAt(0) ?? null);
	const open = !next || next === 2 && Boolean(previous);
	const close = !previous || previous === 2 && Boolean(next);
	return {
		open: marker === "_" ? open && (Boolean(previous) || !close) : open,
		close: marker === "_" ? close && (Boolean(next) || !open) : close
	};
}
function fallback(outside, inside, marker) {
	if (outside === void 0) return inside === void 0 ? {
		inside: marker === "_",
		outside: marker === "_"
	} : inside === 1 ? {
		inside: true,
		outside: true
	} : {
		inside: false,
		outside: true
	};
	if (outside === 1) return {
		inside: inside === 1,
		outside: inside === 1
	};
	return {
		inside: inside === 1,
		outside: false
	};
}
/** Choose boundary encodings without changing punctuation used by constructs. */
function encodeInfo(before, after, marker, opening, cjk) {
	const beforeKind = classifyBefore(before);
	const afterKind = classifyCharacter(after.codePointAt(0) ?? null);
	if (!cjk || !isCjkOrIvs(beforeKind) && !isCjkOrIvs(afterKind)) {
		const previous = cjk ? commonMarkKind(beforeKind) : classifyCharacter$1(lastCharacter(before).codePointAt(0) ?? null);
		const next = cjk ? commonMarkKind(afterKind) : classifyCharacter$1(after.codePointAt(0) ?? null);
		return opening ? fallback(previous, next, marker) : fallback(next, previous, marker);
	}
	for (const candidate of [
		{
			inside: false,
			outside: false
		},
		{
			inside: true,
			outside: false
		},
		{
			inside: false,
			outside: true
		},
		{
			inside: true,
			outside: true
		}
	]) {
		const encodedBefore = opening ? candidate.outside : candidate.inside;
		const encodedAfter = opening ? candidate.inside : candidate.outside;
		const forms = sides(encodedBefore ? classifyCharacter(";".codePointAt(0) ?? null) : beforeKind, encodedAfter ? classifyCharacter("&".codePointAt(0) ?? null) : afterKind, marker);
		if (opening ? forms.open : forms.close) return candidate;
	}
	return {
		inside: true,
		outside: true
	};
}
function commonMarkKind(kind) {
	return isUnicodeWhitespace(kind) ? 1 : isNonCjkPunctuation(kind) ? 2 : void 0;
}
//#endregion
//#region src/phrasing.ts
/*!
* Phrasing algorithm adapted from mdast-util-to-markdown (commit 388140e).
* Copyright (c) Titus Wormer <tituswormer@gmail.com>
*
* Permission is hereby granted, free of charge, to any person obtaining a copy
* of this software and associated documentation files (the "Software"), to deal
* in the Software without restriction, including without limitation the rights
* to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
* copies of the Software, and to permit persons to whom the Software is
* furnished to do so, subject to the following conditions:
*
* The above copyright notice and this permission notice shall be included in
* all copies or substantial portions of the Software.
*
* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
* IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
* FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
* AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
* LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
* OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
* SOFTWARE.
*/
/** Mark an attention handler for CJK-aware encoding and pairing. */
function cjkFriendlyAttention(handle) {
	const attention = handle.attention;
	if (!attention) throw new Error("Expected a handler with the attention API");
	const result = (node, parent, state, info) => {
		install(state);
		return handle(node, parent, state, info);
	};
	result.peek = handle.peek;
	result.attention = (node, state) => ({
		...attention(node, state),
		cjkFriendly: true
	});
	return result;
}
function install(state) {
	state.containerPhrasing = (parent, info) => containerPhrasing(parent, state, info);
}
function withCjkPhrasing(handle) {
	return (node, parent, state, info) => {
		install(state);
		return handle(node, parent, state, info);
	};
}
/** Install the container before serializing a document or a phrasing block. */
const cjkFriendlyPhrasingHandlers = {
	root: withCjkPhrasing(defaultHandlers.root),
	paragraph: withCjkPhrasing(defaultHandlers.paragraph),
	heading: withCjkPhrasing(defaultHandlers.heading)
};
function candidates(tokens, involved, runOf) {
	const related = /* @__PURE__ */ new Set();
	for (const token of tokens) {
		const siblings = runOf.get(token);
		if (siblings && token.attention && involved.some((d) => d.attention === token.attention)) for (const sibling of siblings.tokens) related.add(sibling.attention);
	}
	const ordered = [];
	for (const token of tokens) if (token.attention && related.delete(token.attention)) ordered.push(token.attention);
	return ordered.reverse();
}
function check(tokens, before, after) {
	const runs = [];
	const wrong = /* @__PURE__ */ new Map();
	const runOf = /* @__PURE__ */ new Map();
	let index = 0;
	while (index < tokens.length) {
		if (!tokens[index].attention) {
			index++;
			continue;
		}
		const marker = tokens[index].value.charAt(0);
		let end = index + 1;
		while (end < tokens.length && tokens[end].attention && tokens[end].value.charAt(0) === marker) end++;
		const group = tokens.slice(index, end);
		const { open, close } = attentionSides(index ? tokens[index - 1].value : before, end < tokens.length ? tokens[end].value : after, marker, group.some((token) => token.attention?.cjk));
		const run = {
			tokens: group,
			markers: [],
			start: 0,
			end: 0,
			open,
			close,
			split: marker === "*" || marker === "_"
		};
		for (const token of group) {
			wrong.set(token, [...group]);
			runOf.set(token, run);
			for (let size = token.value.length; size > 0; size--) run.markers.push(token);
		}
		run.end = run.markers.length;
		runs.push(run);
		index = end;
	}
	pair(runs, wrong);
	for (let index = 0; index < tokens.length; index++) {
		const involved = wrong.get(tokens[index]);
		if (involved) return {
			attention: candidates(tokens, involved, runOf),
			index
		};
	}
}
function pair(runs, wrong) {
	let index = 0;
	while (index < runs.length) {
		const closer = runs[index];
		const marker = closer.tokens[0].value.charAt(0);
		const closerSize = closer.end - closer.start;
		let open = closer.close && closerSize ? index : 0;
		while (open--) {
			const opener = runs[open];
			const openerSize = opener.end - opener.start;
			if (opener.tokens[0].value.charAt(0) === marker && opener.open && openerSize && (closer.split ? !((opener.close || closer.open) && closerSize % 3) || (openerSize + closerSize) % 3 : openerSize === opener.markers.length && openerSize === closerSize)) {
				const size = closer.split ? openerSize > 1 && closerSize > 1 ? 2 : 1 : closerSize;
				const opening = opener.markers.slice(opener.end - size, opener.end);
				const closing = closer.markers.slice(closer.start, closer.start + size);
				const openToken = opening[0];
				const closeToken = closing[0];
				if (openToken === opening[size - 1] && openToken.value.length === size && closeToken === closing[size - 1] && closeToken.value.length === size && openToken.attention === closeToken.attention) {
					wrong.delete(openToken);
					wrong.delete(closeToken);
				} else {
					const involved = [.../* @__PURE__ */ new Set([...opening, ...closing])];
					for (const token of involved) wrong.get(token)?.push(...involved);
				}
				opener.end -= size;
				closer.start += size;
				break;
			}
		}
		if (open === -1 || closer.start === closer.end) index++;
	}
}
function encode(tokens, start) {
	const token = tokens[start ? 0 : tokens.length - 1];
	if (!token || token.attention || !token.value) return;
	const character = start ? firstCharacter(token.value) : lastCharacter(token.value);
	const reference = `&#x${character.codePointAt(0)?.toString(16).toUpperCase()};`;
	if (start) token.value = reference + token.value.slice(character.length);
	else {
		let value = token.value.slice(0, -character.length);
		let escapes = 0;
		while (value.charCodeAt(value.length - 1 - escapes) === 92) escapes++;
		if (escapes % 2) value += "\\";
		token.value = value + reference;
	}
}
function attentionSequences(type, markers, sizes) {
	if (!markers.length || !sizes.length) throw new Error(`Cannot serialize ${type} as attention without markers and sizes`);
	for (const size of sizes) if (!Number.isSafeInteger(size) || size < 1) throw new Error(`Invalid attention size for ${type}: ${size}`);
	const sequences = [];
	for (const marker of markers) {
		if (marker.length !== 1 || !asciiPunctuation(marker.charCodeAt(0))) throw new Error(`Invalid attention marker for ${type}: ${marker}`);
		for (const size of sizes) sequences.push(marker.repeat(size));
	}
	return sequences;
}
function htmlKind(value) {
	if (value.charCodeAt(0) !== 60) return;
	const next = value.charCodeAt(1);
	if (next === 33) {
		const code = value.charCodeAt(2);
		if (code === 45) return 2;
		if (code === 91) return 5;
		if (asciiAlpha(code)) return 4;
		return;
	}
	if (next === 63) return 3;
	const closing = next === 47;
	const start = closing ? 2 : 1;
	let end = start;
	let code = value.charCodeAt(end);
	if (!asciiAlpha(code)) return;
	while (code === 45 || asciiAlphanumeric(code)) code = value.charCodeAt(++end);
	const name = value.slice(start, end).toLowerCase();
	if (!closing && code !== 47 && htmlRawNames.includes(name)) return 1;
	return htmlBlockNames.includes(name) ? 6 : 7;
}
function phrasing(parent, state, info) {
	const children = parent.children;
	const results = [];
	let before = info.before;
	state.indexStack.push(-1);
	let tracker = state.createTracker(info);
	try {
		for (let index = 0; index < children.length; index++) {
			const child = children[index];
			state.indexStack[state.indexStack.length - 1] = index;
			const next = children[index + 1];
			let after = info.after;
			if (next) {
				const handle = state.handlers[next.type];
				const peek = handle?.peek ?? handle;
				after = peek ? firstCharacter(peek(next, parent, state, {
					before: "",
					after: "",
					...tracker.current()
				})) : "";
			}
			const previous = results[results.length - 1];
			if (typeof previous === "string" && (before === "\r" || before === "\n") && child.type === "html" && htmlKind(child.value) !== 7) {
				results[results.length - 1] = previous.replace(/(\r?\n|\r)$/, " ");
				before = " ";
				tracker = state.createTracker(info);
				tracker.move(serialize(results, info.before, info.after));
			}
			const handle = state.handlers[child.type];
			if (handle?.attention) {
				const { construct, markers, sizes, cjkFriendly } = handle.attention(child, state);
				const sequences = attentionSequences(child.type, markers, sizes);
				const sequence = sequences[0];
				const exit = state.enter(construct);
				tracker.move(sequence);
				let inside;
				try {
					inside = phrasing(child, state, {
						...tracker.current(),
						before: sequence,
						after: sequence
					});
					tracker.move(serialize(inside, sequence, sequence));
					tracker.move(sequence);
				} finally {
					exit();
				}
				results.push({
					children: inside,
					sequences,
					cjk: Boolean(cjkFriendly)
				});
				before = lastCharacter(sequence);
			} else {
				const value = state.handle(child, parent, state, {
					...tracker.current(),
					after,
					before
				});
				if (!value) continue;
				tracker.move(value);
				results.push(value);
				before = value;
			}
		}
		return results;
	} finally {
		state.indexStack.pop();
	}
}
function render(items, chosen, before, after) {
	const tokens = [];
	let encodeAfter;
	let previous = before;
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (typeof item === "string") {
			const token = {
				value: item,
				attention: void 0
			};
			if (encodeAfter && encodeAfter === firstCharacter(item)) encode([token], true);
			encodeAfter = void 0;
			tokens.push(token);
			if (token.value) previous = token.value;
			continue;
		}
		const sequence = chosen.get(item) || item.sequences[0];
		const marker = sequence.charAt(0);
		const next = items[index + 1];
		const outsideAfter = next === void 0 ? after : typeof next === "string" ? next : chosen.get(next) || next.sequences[0];
		const inside = render(item.children, chosen, sequence, sequence);
		const head = inside[0]?.value ?? "";
		const open = encodeInfo(previous, head, marker, true, item.cjk);
		if (open.inside) encode(inside, true);
		const close = encodeInfo(inside[inside.length - 1]?.value ?? "", outsideAfter, marker, false, item.cjk);
		if (close.inside) encode(inside, false);
		if (open.outside && lastCharacter(previous) !== "\n" && lastCharacter(previous) !== "\r") encode(tokens, false);
		if (close.outside) encodeAfter = firstCharacter(outsideAfter);
		tokens.push({
			value: sequence,
			attention: item
		}, ...inside, {
			value: sequence,
			attention: item
		});
		previous = sequence;
	}
	return tokens;
}
function serialize(items, before, after) {
	let chosen = /* @__PURE__ */ new Map();
	const initial = render(items, chosen, before, after);
	let tokens = initial;
	let mistake = check(tokens, before, after);
	while (mistake) {
		let improvement;
		for (const attention of mistake.attention) {
			const current = chosen.get(attention) || attention.sequences[0];
			for (const sequence of attention.sequences) {
				if (sequence === current) continue;
				const trial = new Map(chosen);
				trial.set(attention, sequence);
				const rendered = render(items, trial, before, after);
				const next = check(rendered, before, after);
				if (!next || next.index > mistake.index) {
					improvement = {
						chosen: trial,
						tokens: rendered,
						mistake: next
					};
					break;
				}
			}
			if (improvement) break;
		}
		if (!improvement) {
			tokens = initial;
			break;
		}
		chosen = improvement.chosen;
		tokens = improvement.tokens;
		mistake = improvement.mistake;
	}
	return tokens.map((token) => token.value).join("");
}
function containerPhrasing(parent, state, info) {
	return serialize(phrasing(parent, state, info), info.before, info.after);
}
//#endregion
export { cjkFriendlyPhrasingHandlers as n, cjkFriendlyAttention as t };
