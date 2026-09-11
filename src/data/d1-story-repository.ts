import type { PublicationStatus } from '../domain/publication-status';
import type { Story, StorySource } from '../domain/story';
import type { StoryRepository, PublishedStoryQuery } from './story-repository';

interface StoryRow {
	id: string;
	slug: string;
	headline: string;
	deck: string;
	body_markdown: string;
	edition_date: string;
	published_at: string;
	category_id: string;
	category_slug: string;
	category_name: string;
	status: PublicationStatus;
	social_excerpt: string;
	og_image_key: string | null;
	image_alt_text: string | null;
	tags_json: string;
}

interface SourceRow {
	id: string;
	title: string;
	url: string;
	publisher: string | null;
	published_at: string | null;
}

const STORY_SELECT = `
	SELECT
		s.id,
		s.slug,
		s.headline,
		s.deck,
		s.body_markdown,
		s.edition_date,
		s.published_at,
		s.category_id,
		c.slug AS category_slug,
		c.name AS category_name,
		s.status,
		s.social_excerpt,
		s.og_image_key,
		image.alt_text AS image_alt_text,
		s.tags_json
	FROM stories AS s
	JOIN categories AS c ON c.id = s.category_id
	LEFT JOIN article_images AS image
		ON image.asset_key = s.og_image_key AND image.status = 'APPROVED'
`;

function parseTags(value: string): string[] {
	const parsed: unknown = JSON.parse(value);
	return Array.isArray(parsed) && parsed.every((tag) => typeof tag === 'string') ? parsed : [];
}

function mapStory(row: StoryRow, sources: StorySource[] = []): Story {
	return {
		id: row.id,
		slug: row.slug,
		headline: row.headline,
		deck: row.deck,
		bodyMarkdown: row.body_markdown,
		editionDate: row.edition_date,
		publishedAt: row.published_at,
		category: {
			id: row.category_id,
			slug: row.category_slug,
			name: row.category_name,
		},
		status: row.status,
		socialExcerpt: row.social_excerpt,
		ogImageKey: row.og_image_key,
		imageAltText: row.image_alt_text,
		tags: parseTags(row.tags_json),
		sources,
	};
}

export class D1StoryRepository implements StoryRepository {
	constructor(private readonly db: D1Database) {}

	async findPublishedBySlug(slug: string): Promise<Story | null> {
		const row = await this.db
			.prepare(`${STORY_SELECT} WHERE s.status = 'PUBLISHED' AND s.slug = ? LIMIT 1`)
			.bind(slug)
			.first<StoryRow>();

		if (!row) return null;

		const result = await this.db
			.prepare(`
				SELECT id, title, url, publisher, published_at
				FROM sources
				WHERE story_id = ?
				ORDER BY created_at ASC
			`)
			.bind(row.id)
			.all<SourceRow>();

		const sources = result.results.map((source) => ({
			id: source.id,
			title: source.title,
			url: source.url,
			publisher: source.publisher,
			publishedAt: source.published_at,
		}));

		return mapStory(row, sources);
	}

	async getLeadStory(): Promise<Story | null> {
		const row = await this.db
			.prepare(`${STORY_SELECT}
				WHERE s.status = 'PUBLISHED'
				ORDER BY s.edition_date DESC, s.published_at DESC
				LIMIT 1`)
			.first<StoryRow>();

		return row ? mapStory(row) : null;
	}

	async listCategories(): Promise<Story['category'][]> {
		const result = await this.db
			.prepare('SELECT id, slug, name FROM categories ORDER BY name ASC')
			.all<Story['category']>();
		return result.results;
	}

	async findCategoryBySlug(slug: string): Promise<Story['category'] | null> {
		return this.db
			.prepare('SELECT id, slug, name FROM categories WHERE slug = ? LIMIT 1')
			.bind(slug)
			.first<Story['category']>();
	}

	async listPublished(options: PublishedStoryQuery = {}): Promise<Story[]> {
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
		const conditions = ["s.status = 'PUBLISHED'"];
		const bindings: Array<string | number> = [];
		if (options.excludeId) {
			conditions.push('s.id <> ?');
			bindings.push(options.excludeId);
		}
		if (options.categorySlug) {
			conditions.push('c.slug = ?');
			bindings.push(options.categorySlug);
		}
		bindings.push(limit);
		const result = await this.db.prepare(`${STORY_SELECT}
			WHERE ${conditions.join(' AND ')}
			ORDER BY s.edition_date DESC, s.published_at DESC
			LIMIT ?`)
			.bind(...bindings)
			.all<StoryRow>();

		return result.results.map((row) => mapStory(row));
	}
}

export function createStoryRepository(db: D1Database): StoryRepository {
	return new D1StoryRepository(db);
}
