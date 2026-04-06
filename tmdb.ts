import { requestUrl } from "obsidian";

const LOG_PREFIX = "[Set Status Plugin] [TMDB]";
const TMDB_SEARCH_ENDPOINT = "https://api.themoviedb.org/3/search/multi";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p/";
const TMDB_POSTER_SIZE = "w500";
const TMDB_MAX_RETRIES = 3;
const TMDB_BASE_BACKOFF_MS = 1000;

export interface TvShowMetadata {
	id: string | null;
	thumbnail: string | null;
	canonicalName: string | null;
}

interface TmdbResult {
	id?: number | null;
	media_type?: string | null;
	name?: string | null;
	title?: string | null;
	poster_path?: string | null;
	popularity?: number | null;
	vote_count?: number | null;
}

export async function searchTvShows(
	showName: string,
	apiKey: string
): Promise<TvShowMetadata[]> {
	const trimmed = showName.trim();
	if (!trimmed || !apiKey) {
		console.info(`${LOG_PREFIX} searchTvShows: skipped (empty input or missing key)`);
		return [];
	}

	const query = stripSeasonSuffix(trimmed);
	const results = await tmdbSearch(query, apiKey);
	if (results.length > 0) {
		return results;
	}

	const loose = loosen(query);
	if (loose !== query) {
		console.info(`${LOG_PREFIX} searchTvShows: retrying with loosened query="${loose}"`);
		return tmdbSearch(loose, apiKey);
	}
	return [];
}

async function tmdbSearch(query: string, apiKey: string): Promise<TvShowMetadata[]> {
	console.info(`${LOG_PREFIX} tmdbSearch: query="${query}"`);

	const params = new URLSearchParams({
		api_key: apiKey,
		query,
	});

	const url = `${TMDB_SEARCH_ENDPOINT}?${params.toString()}`;

	for (let attempt = 1; attempt <= TMDB_MAX_RETRIES; attempt++) {
		try {
			const response = await requestUrl({
				url,
				method: "GET",
				headers: { Accept: "application/json" },
				throw: false,
			});

			console.info(`${LOG_PREFIX} tmdbSearch: status=${response.status} (attempt ${attempt})`);

			if (response.status >= 400) {
				if (response.status === 429 && attempt < TMDB_MAX_RETRIES) {
					await delay(TMDB_BASE_BACKOFF_MS * 2 ** (attempt - 1));
					continue;
				}
				return [];
			}

			const data = response.json;
			const results: TmdbResult[] = Array.isArray(data?.results)
				? data.results
				: [];
			const mapped = rankAllResults(results).map(resultToMetadata);
			console.info(`${LOG_PREFIX} tmdbSearch: returning ${mapped.length} results`);
			return mapped;
		} catch (error) {
			console.error(`${LOG_PREFIX} tmdbSearch: error (attempt ${attempt}):`, error);
			if (attempt < TMDB_MAX_RETRIES) {
				await delay(TMDB_BASE_BACKOFF_MS * 2 ** (attempt - 1));
				continue;
			}
			return [];
		}
	}
	return [];
}

export async function fetchTvShowMetadata(
	showName: string,
	apiKey: string
): Promise<TvShowMetadata | null> {
	const trimmed = showName.trim();
	if (!trimmed || !apiKey) {
		console.info(`${LOG_PREFIX} fetchTvShowMetadata: skipped (empty input or missing key)`);
		return null;
	}

	const query = stripSeasonSuffix(trimmed);
	const results = await tmdbSearch(query, apiKey);
	if (results.length > 0) {
		return results[0];
	}

	const loose = loosen(query);
	if (loose !== query) {
		console.info(`${LOG_PREFIX} fetchTvShowMetadata: retrying with loosened query="${loose}"`);
		const looseResults = await tmdbSearch(loose, apiKey);
		return looseResults.length > 0 ? looseResults[0] : null;
	}
	return null;
}

function rankAllResults(results: TmdbResult[]): TmdbResult[] {
	if (results.length === 0) {
		return [];
	}
	// Filter to only movies and TV shows (multi search also returns people)
	const mediaOnly = results.filter(
		(r) => r.media_type === "movie" || r.media_type === "tv"
	);
	const scored = mediaOnly.map((show, index) => {
		const popularity = safeNum(show.popularity);
		const voteCount = safeNum(show.vote_count);
		const score = popularity + voteCount;
		return { show, score, index };
	});
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.index - b.index;
	});
	return scored.map((entry) => entry.show);
}

function resultToMetadata(result: TmdbResult): TvShowMetadata {
	const thumbnail =
		typeof result.poster_path === "string" && result.poster_path.length > 0
			? `${TMDB_IMAGE_BASE_URL}${TMDB_POSTER_SIZE}${result.poster_path}`
			: null;
	const canonicalName =
		typeof result.title === "string" ? result.title
		: typeof result.name === "string" ? result.name
		: null;
	const mediaPath = result.media_type === "movie" ? "movie" : "tv";
	const id = typeof result.id === "number" ? `https://www.themoviedb.org/${mediaPath}/${result.id}` : null;
	return { id, thumbnail, canonicalName };
}

function safeNum(value: number | null | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function loosen(query: string): string {
	return query
		.replace(/[^\w\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function stripSeasonSuffix(name: string): string {
	return name
		.replace(/\s+[-–—]?\s*(?:season|series)\s+\d+\s*$/i, "")
		.replace(/\s+[-–—]?\s*s\d+\s*$/i, "")
		.trim();
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
