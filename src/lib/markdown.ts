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
	return renderStoryMarkdownBlocks(markdown).map((block) => block.html).join('\n');
}

export interface RenderedStoryBlock {
	kind: 'paragraph' | 'heading' | 'list' | 'blockquote';
	html: string;
}

export function renderStoryMarkdownBlocks(markdown: string): RenderedStoryBlock[] {
	const lines = markdown.replace(/\\n/g, '\n').split(/\r?\n/);
	const output: RenderedStoryBlock[] = [];
	let paragraph: string[] = [];
	let listType: 'ul' | 'ol' | null = null;
	let listItems: string[] = [];

	const flushParagraph = () => {
		if (!paragraph.length) return;
		output.push({ kind: 'paragraph', html: `<p>${renderInline(paragraph.join(' '))}</p>` });
		paragraph = [];
	};

	const closeList = () => {
		if (!listType) return;
		output.push({
			kind: 'list',
			html: `<${listType}>\n${listItems.join('\n')}\n</${listType}>`,
		});
		listType = null;
		listItems = [];
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
			output.push({ kind: 'heading', html: `<h${level}>${renderInline(heading[2] ?? '')}</h${level}>` });
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
			}
			listItems.push(`<li>${renderInline((unorderedItem ?? orderedItem)?.[1] ?? '')}</li>`);
			continue;
		}

		const quote = /^>\s?(.+)$/.exec(line);
		if (quote) {
			flushParagraph();
			closeList();
			output.push({ kind: 'blockquote', html: `<blockquote><p>${renderInline(quote[1] ?? '')}</p></blockquote>` });
			continue;
		}

		closeList();
		paragraph.push(line);
	}

	flushParagraph();
	closeList();
	return output;
}
