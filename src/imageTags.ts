export interface ImageTag {
	start: number;
	end: number;
	source: string | null;
	alt: string | null;
	altStart: number | null;
	altEnd: number | null;
}

export function findImageTags(text: string): ImageTag[] {
	const tags: ImageTag[] = [];
	let cursor = 0;
	while (cursor < text.length) {
		const start = text.indexOf('<', cursor);
		if (start < 0) {
			break;
		}
		if (text.startsWith('<!--', start)) {
			const commentEnd = text.indexOf('-->', start + 4);
			cursor = commentEnd < 0 ? text.length : commentEnd + 3;
			continue;
		}

		const tagMatch = /^<([A-Za-z][\w:-]*)\b/.exec(text.slice(start));
		if (!tagMatch) {
			cursor = start + 1;
			continue;
		}
		const tagEnd = findTagEnd(text, start + tagMatch[0].length);
		if (tagEnd < 0) {
			break;
		}
		const tag = text.slice(start, tagEnd + 1);
		cursor = tagEnd + 1;
		const tagName = tagMatch[1].toLowerCase();
		if (tagName === 'script' || tagName === 'style') {
			const closingTag = new RegExp(`</${tagName}\\s*>`, 'ig');
			closingTag.lastIndex = cursor;
			const closingMatch = closingTag.exec(text);
			cursor = closingMatch ? closingTag.lastIndex : text.length;
			continue;
		}
		if (tagName !== 'img') {
			continue;
		}

		let source: string | null = null;
		let dynamicSource = false;
		let alt: string | null = null;
		let altStart: number | null = null;
		let altEnd: number | null = null;
		let index = tagMatch[0].length;
		while (index < tag.length - 1) {
			while (/\s/.test(tag[index] ?? '')) {
				index++;
			}
			if (tag[index] === '/' || tag[index] === '>') {
				break;
			}

			const nameStart = index;
			while (index < tag.length && !/[\s=/>]/.test(tag[index])) {
				index++;
			}
			if (index === nameStart) {
				index++;
				continue;
			}
			const name = tag.slice(nameStart, index).toLowerCase();
			while (/\s/.test(tag[index] ?? '')) {
				index++;
			}
			if (tag[index] !== '=') {
				continue;
			}
			index++;
			while (/\s/.test(tag[index] ?? '')) {
				index++;
			}

			let valueStart = index;
			let valueEnd = index;
			let expression = false;
			const quote = tag[index] === '"' || tag[index] === '\'' ? tag[index] : null;
			if (quote) {
				valueStart = ++index;
				while (index < tag.length && tag[index] !== quote) {
					index++;
				}
				valueEnd = index;
				index++;
			} else if (tag[index] === '{') {
				expression = true;
				const expressionEnd = findExpressionEnd(tag, index);
				valueEnd = expressionEnd < 0 ? tag.length - 1 : expressionEnd + 1;
				index = valueEnd;
			} else {
				valueStart = index;
				while (index < tag.length && !/[\s>]/.test(tag[index])) {
					index++;
				}
				valueEnd = index;
			}

			const value = tag.slice(valueStart, valueEnd);
			if (name === 'src') {
				source = value;
				dynamicSource = expression;
			} else if (name === 'alt') {
				alt = value;
				altStart = start + valueStart;
				altEnd = start + valueEnd;
			}
		}

		if (dynamicSource) {
			source = null;
		}

		tags.push({
			start,
			end: tagEnd + 1,
			source: source?.trim() || null,
			alt,
			altStart,
			altEnd,
		});
	}

	return tags;
}

function findExpressionEnd(text: string, start: number): number {
	let depth = 0;
	let quote: string | null = null;
	for (let index = start; index < text.length; index++) {
		const character = text[index];
		if (quote) {
			if (character === '\\') {
				index++;
			} else if (character === quote) {
				quote = null;
			}
			continue;
		}
		if (character === '"' || character === '\'' || character === '`') {
			quote = character;
		} else if (character === '{') {
			depth++;
		} else if (character === '}' && --depth === 0) {
			return index;
		}
	}
	return -1;
}

function findTagEnd(text: string, start: number): number {
	let quote: string | null = null;
	let expressionDepth = 0;
	for (let index = start; index < text.length; index++) {
		const character = text[index];
		if (quote) {
			if (character === quote) {
				quote = null;
			}
			continue;
		}
		if (character === '"' || character === '\'') {
			quote = character;
		} else if (character === '{') {
			expressionDepth++;
		} else if (character === '}') {
			expressionDepth = Math.max(0, expressionDepth - 1);
		} else if (character === '>' && expressionDepth === 0) {
			return index;
		}
	}
	return -1;
}

export function getUnfilledImageTags(text: string): ImageTag[] {
	return findImageTags(text).filter((tag) => tag.alt === null || tag.alt.trim() === '');
}
