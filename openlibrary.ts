import { requestUrl } from "obsidian";

const OPENLIBRARY_SEARCH_ENDPOINT = "https://openlibrary.org/search.json";
const OPENLIBRARY_COVER_BASE_URL = "https://covers.openlibrary.org/b/olid/";
const OPENLIBRARY_COVER_SIZE = "M";
const OPENLIBRARY_MAX_RETRIES = 3;
const OPENLIBRARY_BASE_BACKOFF_MS = 1000;

export interface BookMetadata {
	thumbnail: string | null;
	canonicalName: string | null;
}

interface OpenLibraryDoc {
	title?: string | null;
	cover_edition_key?: string | null;
	edition_key?: string[] | null;
	cover_i?: number | null;
	ratings_count?: number | null;
	want_to_read_count?: number | null;
	already_read_count?: number | null;
}

export async function fetchBookMetadata(
	bookName: string
): Promise<BookMetadata | null> {
	const trimmed = bookName.trim();
	if (!trimmed) {
		return null;
	}

	const params = new URLSearchParams({
		q: trimmed,
		fields:
			"title,cover_edition_key,edition_key,cover_i,ratings_count,want_to_read_count,already_read_count",
		limit: "5",
	});

	const url = `${OPENLIBRARY_SEARCH_ENDPOINT}?${params.toString()}`;

	for (let attempt = 1; attempt <= OPENLIBRARY_MAX_RETRIES; attempt++) {
		try {
			const response = await requestUrl({
				url,
				method: "GET",
				headers: { Accept: "application/json" },
				throw: false,
			});

			if (response.status >= 400) {
				if (response.status === 429 && attempt < OPENLIBRARY_MAX_RETRIES) {
					const delayMs = OPENLIBRARY_BASE_BACKOFF_MS * 2 ** (attempt - 1);
					console.warn(
						`Open Library rate limited (attempt ${attempt}/${OPENLIBRARY_MAX_RETRIES}). Retrying in ${delayMs}ms.`
					);
					await delay(delayMs);
					continue;
				}
				console.error(
					`Open Library request failed (${response.status}): ${response.text ?? ""}`
				);
				return null;
			}

			const data = response.json;
			const docs: OpenLibraryDoc[] = Array.isArray(data?.docs)
				? data.docs
				: [];
			const best = rankBooks(docs);
			if (!best) {
				return null;
			}

			const thumbnail = resolveCoverUrl(best);
			const canonicalName =
				typeof best.title === "string" ? best.title : null;

			return { thumbnail, canonicalName };
		} catch (error) {
			if (attempt < OPENLIBRARY_MAX_RETRIES) {
				const delayMs = OPENLIBRARY_BASE_BACKOFF_MS * 2 ** (attempt - 1);
				console.warn(
					`Open Library error (attempt ${attempt}/${OPENLIBRARY_MAX_RETRIES}). Retrying in ${delayMs}ms.`
				);
				await delay(delayMs);
				continue;
			}
			console.error("Failed to fetch Open Library metadata", error);
			return null;
		}
	}
	return null;
}

function rankBooks(docs: OpenLibraryDoc[]): OpenLibraryDoc | null {
	if (docs.length === 0) {
		return null;
	}
	const scored = docs.map((doc, index) => {
		const ratings = safeNum(doc.ratings_count);
		const wantToRead = safeNum(doc.want_to_read_count);
		const alreadyRead = safeNum(doc.already_read_count);
		const score = ratings + wantToRead + alreadyRead;
		return { doc, score, index };
	});
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.index - b.index;
	});
	return scored[0]?.doc ?? null;
}

function resolveCoverUrl(doc: OpenLibraryDoc): string | null {
	// Prefer cover_i (numeric cover ID) — most reliable
	if (typeof doc.cover_i === "number" && doc.cover_i > 0) {
		return `https://covers.openlibrary.org/b/id/${doc.cover_i}-${OPENLIBRARY_COVER_SIZE}.jpg`;
	}
	// Fall back to edition OLID
	const olid = doc.cover_edition_key ?? doc.edition_key?.[0];
	if (typeof olid === "string" && olid.length > 0) {
		return `${OPENLIBRARY_COVER_BASE_URL}${olid}-${OPENLIBRARY_COVER_SIZE}.jpg`;
	}
	return null;
}

function safeNum(value: number | null | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
