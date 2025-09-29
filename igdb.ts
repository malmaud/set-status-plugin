import { requestUrl } from "obsidian";

export interface IgdbConfig {
	clientId: string;
	accessToken: string;
}

interface IgdbGame {
	cover?: {
		image_id?: string | null;
	} | null;
	name?: string | null;
	total_rating_count?: number | null;
	rating_count?: number | null;
}

const IGDB_GAMES_ENDPOINT = "https://api.igdb.com/v4/games";
const IGDB_IMAGE_BASE_URL = "https://images.igdb.com/igdb/image/upload/";
const IGDB_COVER_SIZE = "t_cover_big";
const IGDB_TOKEN_ENDPOINT = "https://id.twitch.tv/oauth2/token";
const IGDB_MAX_RETRIES = 3;
const IGDB_BASE_BACKOFF_MS = 1000;

export interface IgdbAccessToken {
	accessToken: string;
	expiresIn: number;
}

export async function requestIgdbAccessToken(
	clientId: string,
	clientSecret: string
): Promise<IgdbAccessToken | null> {
	const body = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		grant_type: "client_credentials",
	}).toString();

	try {
		const response = await requestUrl({
			url: IGDB_TOKEN_ENDPOINT,
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body,
			throw: false,
		});

		if (response.status >= 400) {
			console.error(
				`IGDB token request failed (${response.status}): ${response.text ?? ""}`
			);
			return null;
		}

		const data = normalizeTokenResponse(response.json, response.text);
		if (!data) {
			return null;
		}
		return data;
	} catch (error) {
		console.error("Failed to request IGDB access token", error);
		return null;
	}
}

export interface GameMetadata {
	thumbnail: string | null;
	canonicalName: string | null;
}

export async function fetchGameMetadata(
	gameName: string,
	config: IgdbConfig
): Promise<GameMetadata | null> {
	const trimmed = gameName.trim();
	if (!trimmed) {
		return null;
	}
	if (!config.clientId || !config.accessToken) {
		return null;
	}

	const searchTerm = sanitizeQuery(trimmed);
	if (!searchTerm) {
		return null;
	}

	const body =
		`search "${searchTerm}"; fields name,cover.image_id,total_rating_count,rating_count; limit 5;`;

	for (let attempt = 1; attempt <= IGDB_MAX_RETRIES; attempt++) {
		try {
			const response = await requestUrl({
				url: IGDB_GAMES_ENDPOINT,
				method: "POST",
				headers: {
					"Client-ID": config.clientId,
					Authorization: `Bearer ${config.accessToken}`,
					Accept: "application/json",
					"Content-Type": "text/plain",
				},
				body,
				throw: false,
			});

			if (response.status >= 400) {
				const tooManyRequests = isTooManyRequests(
					response.status,
					response.text
				);
				if (tooManyRequests && attempt < IGDB_MAX_RETRIES) {
					const delayMs = IGDB_BASE_BACKOFF_MS * 2 ** (attempt - 1);
					console.warn(
						`IGDB rate limited (attempt ${attempt}/${IGDB_MAX_RETRIES}). Retrying in ${delayMs}ms.`
					);
					await delay(delayMs);
					continue;
				}
				console.error(
					`IGDB request failed (${response.status}): ${response.text ?? ""}`
				);
				return null;
			}

			const games = normalizeResponse(response.json, response.text);
			const ranked = rankGamesByPlayedCount(games);
			if (!ranked) {
				return null;
			}

			const imageId = ranked.cover?.image_id;
			const canonicalName = typeof ranked.name === "string" ? ranked.name : null;
			const thumbnail =
				imageId && typeof imageId === "string"
					? `${IGDB_IMAGE_BASE_URL}${IGDB_COVER_SIZE}/${imageId}.jpg`
					: null;

			return {
				thumbnail,
				canonicalName,
			};
		} catch (error) {
			const tooManyRequests = isTooManyRequests(undefined, undefined, error);
			if (tooManyRequests && attempt < IGDB_MAX_RETRIES) {
				const delayMs = IGDB_BASE_BACKOFF_MS * 2 ** (attempt - 1);
				console.warn(
					`IGDB rate limited (attempt ${attempt}/${IGDB_MAX_RETRIES}). Retrying in ${delayMs}ms.`
				);
				await delay(delayMs);
				continue;
			}
			console.error("Failed to fetch IGDB metadata", error);
			return null;
		}
	}
	return null;
}

function sanitizeQuery(value: string): string {
	return value.replace(/"/g, '\\"').replace(/\s+/g, " ").trim();
}

function normalizeResponse(
	jsonValue: unknown,
	textValue: string | undefined
): IgdbGame[] {
	if (Array.isArray(jsonValue)) {
		return jsonValue as IgdbGame[];
	}
	if (textValue) {
		try {
			const parsed = JSON.parse(textValue);
			if (Array.isArray(parsed)) {
				return parsed as IgdbGame[];
			}
		} catch (error) {
			console.error("Failed to parse IGDB response", error);
		}
	}
	return [];
}

function rankGamesByPlayedCount(games: IgdbGame[]): IgdbGame | null {
	if (games.length === 0) {
		return null;
	}
	const withCount = games.map((game, index) => {
		const total = normalizeCountValue(game.total_rating_count);
		const rating = normalizeCountValue(game.rating_count);
		const playedCount = Math.max(total, rating, 0);
		return { game, playedCount, index };
	});
	withCount.sort((a, b) => {
		if (b.playedCount !== a.playedCount) {
			return b.playedCount - a.playedCount;
		}
		return a.index - b.index;
	});
	return withCount[0]?.game ?? null;
}

function normalizeCountValue(value: number | null | undefined): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	return 0;
}

function normalizeTokenResponse(
	jsonValue: unknown,
	textValue: string | undefined
): IgdbAccessToken | null {
	const data =
		typeof jsonValue === "object" && jsonValue !== null
			? (jsonValue as Record<string, unknown>)
			: parseJsonObject(textValue);
	if (!data) {
		return null;
	}
	const accessTokenValue = data["access_token"];
	const expiresInValue = data["expires_in"];
	if (typeof accessTokenValue !== "string") {
		return null;
	}
	const expiresIn = normalizeExpiresIn(expiresInValue);
	if (expiresIn === null) {
		return null;
	}
	return {
		accessToken: accessTokenValue,
		expiresIn,
	};
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | null {
	if (!value) {
		return null;
	}
	try {
		const parsed = JSON.parse(value);
		if (typeof parsed === "object" && parsed !== null) {
			return parsed as Record<string, unknown>;
		}
	} catch (error) {
		console.error("Failed to parse IGDB token response", error);
	}
	return null;
}

function normalizeExpiresIn(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return null;
}

function isTooManyRequests(
	status: number | undefined,
	text: string | undefined,
	error?: unknown
): boolean {
	if (status === 429) {
		return true;
	}
	const messageSources: string[] = [];
	if (typeof text === "string" && text.length > 0) {
		messageSources.push(text);
	}
	const errorMessage =
		error && typeof (error as { message?: unknown }).message === "string"
			? (error as { message: string }).message
			: undefined;
	if (errorMessage) {
		messageSources.push(errorMessage);
	}
	return messageSources.some((value) =>
		value.toLowerCase().includes("too many requests")
	);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
