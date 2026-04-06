import { requestUrl } from "obsidian";

const TMDB_SEARCH_ENDPOINT = "https://api.themoviedb.org/3/search/tv";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p/";
const TMDB_POSTER_SIZE = "w500";
const TMDB_MAX_RETRIES = 3;
const TMDB_BASE_BACKOFF_MS = 1000;

export interface TvShowMetadata {
	thumbnail: string | null;
	canonicalName: string | null;
}

interface TmdbTvResult {
	name?: string | null;
	poster_path?: string | null;
	popularity?: number | null;
	vote_count?: number | null;
}

export async function fetchTvShowMetadata(
	showName: string,
	apiKey: string
): Promise<TvShowMetadata | null> {
	const trimmed = showName.trim();
	if (!trimmed || !apiKey) {
		return null;
	}

	const query = stripSeasonSuffix(trimmed);

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
			const best = rankTvShows(results);
			if (!best) {
				return null;
			}

			const thumbnail =
				typeof best.poster_path === "string" && best.poster_path.length > 0
					? `${TMDB_IMAGE_BASE_URL}${TMDB_POSTER_SIZE}${best.poster_path}`
					: null;
			const canonicalName =
				typeof best.name === "string" ? best.name : null;

			return { thumbnail, canonicalName };
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

function rankTvShows(results: TmdbTvResult[]): TmdbTvResult | null {
	if (results.length === 0) {
		return null;
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
	return scored[0]?.show ?? null;
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
