import { requestUrl } from "obsidian";

export interface IgdbConfig {
	clientId: string;
	accessToken: string;
}

interface IgdbGame {
	cover?: {
		image_id?: string | null;
	} | null;
}

const IGDB_GAMES_ENDPOINT = "https://api.igdb.com/v4/games";
const IGDB_IMAGE_BASE_URL = "https://images.igdb.com/igdb/image/upload/";
const IGDB_COVER_SIZE = "t_cover_big";
const IGDB_TOKEN_ENDPOINT = "https://id.twitch.tv/oauth2/token";

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

export async function fetchGameThumbnail(
	gameName: string,
	config: IgdbConfig
): Promise<string | null> {
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

	const body = `search "${searchTerm}"; fields cover.image_id; limit 1;`;

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
			console.error(
				`IGDB request failed (${response.status}): ${response.text ?? ""}`
			);
			return null;
		}

		const games = normalizeResponse(response.json, response.text);
		if (games.length === 0) {
			return null;
		}

		const imageId = games[0]?.cover?.image_id;
		if (!imageId || typeof imageId !== "string") {
			return null;
		}

		return `${IGDB_IMAGE_BASE_URL}${IGDB_COVER_SIZE}/${imageId}.jpg`;
	} catch (error) {
		console.error("Failed to fetch IGDB thumbnail", error);
		return null;
	}
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
