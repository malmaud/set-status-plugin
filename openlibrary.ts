import { requestUrl } from "obsidian";

const LOG_PREFIX = "[Set Status Plugin] [Open Library]";
const OPENLIBRARY_SEARCH_ENDPOINT = "https://openlibrary.org/search.json";
const OPENLIBRARY_USER_AGENT = "ObsidianStatusUpdatePlugin/0.1.0 (https://github.com/malmaud/set-status-plugin)";
const OPENLIBRARY_COVER_SIZE = "M";
const OPENLIBRARY_MAX_RETRIES = 5;
const OPENLIBRARY_BASE_BACKOFF_MS = 2000;

const SEARCH_FIELDS = [
	"key", "title", "author_name", "cover_i",
	"ratings_count", "want_to_read_count", "already_read_count",
	"editions", "editions.key", "editions.cover_i", "editions.language",
].join(",");

export interface BookMetadata {
	id: string | null;
	thumbnail: string | null;
	canonicalName: string | null;
	author: string | null;
}

interface OpenLibraryEditionDoc {
	key?: string | null;
	cover_i?: number | null;
	language?: string[] | null;
}

interface OpenLibraryDoc {
	key?: string | null;
	title?: string | null;
	author_name?: string[] | null;
	cover_i?: number | null;
	ratings_count?: number | null;
	want_to_read_count?: number | null;
	already_read_count?: number | null;
	editions?: {
		docs?: OpenLibraryEditionDoc[] | null;
	} | null;
}

export async function searchBooks(
	bookName: string,
	language?: string
): Promise<BookMetadata[]> {
	const trimmed = bookName.trim();
	if (!trimmed) {
		return [];
	}

	console.info(`${LOG_PREFIX} searchBooks: query="${trimmed}", language=${language ?? "any"}`);

	const params = new URLSearchParams({
		q: trimmed,
		fields: SEARCH_FIELDS,
		limit: "10",
	});
	if (language) {
		params.set("language", language);
	}

	const docs = await searchRequest(params);
	console.info(`${LOG_PREFIX} searchBooks: got ${docs.length} docs from search`);
	const ranked = rankAllBooks(docs);

	const results: BookMetadata[] = ranked.map((doc) => ({
		id: typeof doc.key === "string" ? `https://openlibrary.org${doc.key}` : null,
		thumbnail: resolveCover(doc, language),
		canonicalName: typeof doc.title === "string" ? doc.title : null,
		author: resolveAuthor(doc),
	}));
	console.info(`${LOG_PREFIX} searchBooks: returning ${results.length} results (${results.filter(r => r.thumbnail).length} with covers)`);
	return results;
}

export async function fetchBookMetadata(
	bookName: string,
	language?: string
): Promise<BookMetadata | null> {
	const trimmed = bookName.trim();
	if (!trimmed) {
		return null;
	}

	console.info(`${LOG_PREFIX} fetchBookMetadata: query="${trimmed}", language=${language ?? "any"}`);

	const params = new URLSearchParams({
		q: trimmed,
		fields: SEARCH_FIELDS,
		limit: "5",
	});
	if (language) {
		params.set("language", language);
	}

	const docs = await searchRequest(params);
	const ranked = rankAllBooks(docs);
	if (ranked.length === 0) {
		console.info(`${LOG_PREFIX} fetchBookMetadata: no results for "${trimmed}"`);
		return null;
	}

	const doc = ranked[0];
	const id = typeof doc.key === "string" ? `https://openlibrary.org${doc.key}` : null;
	const thumbnail = resolveCover(doc, language);
	const canonicalName = typeof doc.title === "string" ? doc.title : null;
	const author = resolveAuthor(doc);
	console.info(`${LOG_PREFIX} fetchBookMetadata: best match "${canonicalName}", thumbnail=${thumbnail ?? "none"}`);
	return { id, thumbnail, canonicalName, author };
}

async function searchRequest(params: URLSearchParams): Promise<OpenLibraryDoc[]> {
	const url = `${OPENLIBRARY_SEARCH_ENDPOINT}?${params.toString()}`;
	console.info(`${LOG_PREFIX} searchRequest: ${url}`);

	for (let attempt = 1; attempt <= OPENLIBRARY_MAX_RETRIES; attempt++) {
		try {
			const response = await requestUrl({
				url,
				method: "GET",
				headers: { Accept: "application/json", "User-Agent": OPENLIBRARY_USER_AGENT },
				throw: false,
			});

			console.info(`${LOG_PREFIX} searchRequest: status=${response.status} (attempt ${attempt})`);

			if (response.status >= 400) {
				if (response.status === 429 && attempt < OPENLIBRARY_MAX_RETRIES) {
					const delayMs = OPENLIBRARY_BASE_BACKOFF_MS * 2 ** (attempt - 1);
					console.warn(`${LOG_PREFIX} searchRequest: rate limited, retrying in ${delayMs}ms`);
					await delay(delayMs);
					continue;
				}
				console.error(`${LOG_PREFIX} searchRequest: failed with status ${response.status}`);
				return [];
			}

			const data = response.json;
			const docs = Array.isArray(data?.docs) ? data.docs : [];
			console.info(`${LOG_PREFIX} searchRequest: got ${docs.length} docs`);
			return docs;
		} catch (error) {
			console.error(`${LOG_PREFIX} searchRequest: error (attempt ${attempt}):`, error);
			if (attempt < OPENLIBRARY_MAX_RETRIES) {
				const delayMs = OPENLIBRARY_BASE_BACKOFF_MS * 2 ** (attempt - 1);
				console.warn(`${LOG_PREFIX} searchRequest: retrying in ${delayMs}ms`);
				await delay(delayMs);
				continue;
			}
			return [];
		}
	}
	return [];
}

function resolveCover(doc: OpenLibraryDoc, language?: string): string | null {
	const title = doc.title ?? "unknown";

	// Try the inline edition — Open Library boosts editions matching the
	// requested language and having a cover, so the first edition doc is
	// typically the best match.
	const editionDoc = doc.editions?.docs?.[0];
	if (editionDoc) {
		const edCover = editionDoc.cover_i;
		if (typeof edCover === "number" && edCover > 0) {
			const matchesLang = !language || editionDoc.language?.includes(language);
			if (matchesLang) {
				console.info(`${LOG_PREFIX} resolveCover: "${title}" — using edition cover ${edCover} (lang=${editionDoc.language})`);
				return coverUrl(edCover);
			}
		}
	}

	// Fall back to work-level cover
	if (typeof doc.cover_i === "number" && doc.cover_i > 0) {
		console.info(`${LOG_PREFIX} resolveCover: "${title}" — falling back to work-level cover_i ${doc.cover_i}`);
		return coverUrl(doc.cover_i);
	}

	console.info(`${LOG_PREFIX} resolveCover: "${title}" — no cover available`);
	return null;
}

function resolveAuthor(doc: OpenLibraryDoc): string | null {
	const names = doc.author_name;
	if (Array.isArray(names) && names.length > 0 && typeof names[0] === "string") {
		return toLastFirst(names[0]);
	}
	return null;
}

function toLastFirst(name: string): string {
	const parts = name.trim().split(/\s+/);
	if (parts.length < 2) {
		return name.trim();
	}
	const last = parts[parts.length - 1];
	const rest = parts.slice(0, -1).join(" ");
	return `${last}, ${rest}`;
}

function coverUrl(coverId: number): string {
	return `https://covers.openlibrary.org/b/id/${coverId}-${OPENLIBRARY_COVER_SIZE}.jpg`;
}

function rankAllBooks(docs: OpenLibraryDoc[]): OpenLibraryDoc[] {
	if (docs.length === 0) {
		return [];
	}

	// Build a popularity rank (0 = most popular)
	const byPopularity = docs.map((doc, index) => {
		const ratings = safeNum(doc.ratings_count);
		const wantToRead = safeNum(doc.want_to_read_count);
		const alreadyRead = safeNum(doc.already_read_count);
		return { index, popularity: ratings + wantToRead + alreadyRead };
	});
	byPopularity.sort((a, b) => b.popularity - a.popularity);
	const popularityRank = new Map<number, number>();
	byPopularity.forEach((entry, rank) => popularityRank.set(entry.index, rank));

	// Reciprocal rank fusion: combine API relevance rank with popularity rank.
	// Relevance is weighted 2× because the API's search ordering already
	// reflects query match quality, while popularity alone can surface
	// unrelated classics (e.g. the Bible for "god of the woods").
	const k = 2;
	const relevanceWeight = 2;
	const scored = docs.map((doc, index) => {
		const relevanceScore = relevanceWeight / (k + index);
		const popScore = 1 / (k + popularityRank.get(index)!);
		const score = relevanceScore + popScore;
		return { doc, score, index };
	});
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.index - b.index;
	});
	return scored.map((entry) => entry.doc);
}

function safeNum(value: number | null | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
