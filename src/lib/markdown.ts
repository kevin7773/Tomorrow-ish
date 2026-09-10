function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function renderInline(value: string): string {
	return escapeHtml(value)
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

export function renderStoryMarkdown(markdown: string): string {
	const lines = markdown.replace(/\\n/g, '\n').split(/\r?\n/);
	const output: string[] = [];
	let paragraph: string[] = [];
	let listType: 'ul' | 'ol' | null = null;

	const flushParagraph = () => {
		if (!paragraph.length) return;
		output.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
		paragraph = [];
	};

	const closeList = () => {
		if (!listType) return;
		output.push(`</${listType}>`);
		listType = null;
	};

	for (const rawLine of lines) {
		const line = rawLine.trim();

		if (!line) {
			flushParagraph();
			closeList();
			continue;
		}

		const heading = /^(#{2,3})\s+(.+)$/.exec(line);
		if (heading) {
			flushParagraph();
			closeList();
			const level = heading[1]?.length ?? 2;
			output.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`);
			continue;
		}

		const unorderedItem = /^[-*]\s+(.+)$/.exec(line);
		const orderedItem = /^\d+\.\s+(.+)$/.exec(line);
		if (unorderedItem || orderedItem) {
			flushParagraph();
			const nextListType = unorderedItem ? 'ul' : 'ol';
			if (listType !== nextListType) {
				closeList();
				listType = nextListType;
				output.push(`<${listType}>`);
			}
			output.push(`<li>${renderInline((unorderedItem ?? orderedItem)?.[1] ?? '')}</li>`);
			continue;
		}

		const quote = /^>\s?(.+)$/.exec(line);
		if (quote) {
			flushParagraph();
			closeList();
			output.push(`<blockquote><p>${renderInline(quote[1] ?? '')}</p></blockquote>`);
			continue;
		}

		closeList();
		paragraph.push(line);
	}

	flushParagraph();
	closeList();
	return output.join('\n');
}
