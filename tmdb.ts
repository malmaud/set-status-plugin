import { requestUrl } from "obsidian";

const LOG_PREFIX = "[Set Status Plugin] [TMDB]";
const TMDB_SEARCH_ENDPOINT = "https://api.themoviedb.org/3/search/tv";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p/";
const TMDB_POSTER_SIZE = "w500";
const TMDB_MAX_RETRIES = 3;
const TMDB_BASE_BACKOFF_MS = 1000;

export interface TvShowMetadata {
	id: string | null;
	thumbnail: string | null;
	canonicalName: string | null;
}

interface TmdbTvResult {
	id?: number | null;
	name?: string | null;
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
	console.info(`${LOG_PREFIX} searchTvShows: query="${query}" (original="${trimmed}")`);

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

			console.info(`${LOG_PREFIX} searchTvShows: status=${response.status} (attempt ${attempt})`);

			if (response.status >= 400) {
				if (response.status === 429 && attempt < TMDB_MAX_RETRIES) {
					await delay(TMDB_BASE_BACKOFF_MS * 2 ** (attempt - 1));
					continue;
				}
				return [];
			}

			const data = response.json;
			const results: TmdbTvResult[] = Array.isArray(data?.results)
				? data.results
				: [];
			const mapped = rankAllTvShows(results).map(showToMetadata);
			console.info(`${LOG_PREFIX} searchTvShows: returning ${mapped.length} results`);
			return mapped;
		} catch (error) {
			console.error(`${LOG_PREFIX} searchTvShows: error (attempt ${attempt}):`, error);
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
	console.info(`${LOG_PREFIX} fetchTvShowMetadata: query="${query}" (original="${trimmed}")`);

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

			if (response.status >= 400) {
				if (response.status === 429 && attempt < TMDB_MAX_RETRIES) {
					const delayMs = TMDB_BASE_BACKOFF_MS * 2 ** (attempt - 1);
					console.warn(
						`TMDB rate limited (attempt ${attempt}/${TMDB_MAX_RETRIES}). Retrying in ${delayMs}ms.`
					);
					await delay(delayMs);
					continue;
				}
				console.error(
					`TMDB request failed (${response.status}): ${response.text ?? ""}`
				);
				return null;
			}

			const data = response.json;
			const results: TmdbTvResult[] = Array.isArray(data?.results)
				? data.results
				: [];
			const ranked = rankAllTvShows(results);
			if (ranked.length === 0) {
				return null;
			}

			return showToMetadata(ranked[0]);
		} catch (error) {
			if (attempt < TMDB_MAX_RETRIES) {
				const delayMs = TMDB_BASE_BACKOFF_MS * 2 ** (attempt - 1);
				console.warn(
					`TMDB error (attempt ${attempt}/${TMDB_MAX_RETRIES}). Retrying in ${delayMs}ms.`
				);
				await delay(delayMs);
				continue;
			}
			console.error("Failed to fetch TMDB metadata", error);
			return null;
		}
	}
	return null;
}

function rankAllTvShows(results: TmdbTvResult[]): TmdbTvResult[] {
	if (results.length === 0) {
		return [];
	}
	const scored = results.map((show, index) => {
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

function showToMetadata(show: TmdbTvResult): TvShowMetadata {
	const thumbnail =
		typeof show.poster_path === "string" && show.poster_path.length > 0
			? `${TMDB_IMAGE_BASE_URL}${TMDB_POSTER_SIZE}${show.poster_path}`
			: null;
	const canonicalName = typeof show.name === "string" ? show.name : null;
	const id = typeof show.id === "number" ? `https://www.themoviedb.org/tv/${show.id}` : null;
	return { id, thumbnail, canonicalName };
}

function safeNum(value: number | null | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
