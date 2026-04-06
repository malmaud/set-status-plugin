import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRequestUrl } = vi.hoisted(() => ({
	mockRequestUrl: vi.fn(),
}));
vi.mock("obsidian", () => ({ requestUrl: mockRequestUrl }));

import {
	fetchGameMetadata,
	searchGames,
	requestIgdbAccessToken,
	type IgdbConfig,
} from "./igdb";

beforeEach(() => {
	mockRequestUrl.mockReset();
});

const CONFIG: IgdbConfig = {
	clientId: "test-client-id",
	accessToken: "test-token",
};

describe("fetchGameMetadata", () => {
	it("returns null for empty input", async () => {
		expect(await fetchGameMetadata("", CONFIG)).toBeNull();
		expect(await fetchGameMetadata("   ", CONFIG)).toBeNull();
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});

	it("returns null when clientId is empty", async () => {
		expect(
			await fetchGameMetadata("Hades", { clientId: "", accessToken: "tok" })
		).toBeNull();
	});

	it("returns null when accessToken is empty", async () => {
		expect(
			await fetchGameMetadata("Hades", { clientId: "id", accessToken: "" })
		).toBeNull();
	});

	it("returns thumbnail and canonical name for a valid result", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: [
				{
					name: "Hades",
					url: "https://www.igdb.com/games/hades",
					cover: { image_id: "co1abc" },
					total_rating_count: 1000,
					rating_count: 500,
				},
			],
		});

		const result = await fetchGameMetadata("hades", CONFIG);
		expect(result).not.toBeNull();
		expect(result!.canonicalName).toBe("Hades");
		expect(result!.thumbnail).toBe(
			"https://images.igdb.com/igdb/image/upload/t_cover_big/co1abc.jpg"
		);
		expect(result!.id).toBe("https://www.igdb.com/games/hades");
	});

	it("ranks results by play count", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: [
				{
					name: "Obscure Game",
					cover: { image_id: "co_obs" },
					total_rating_count: 5,
					rating_count: 2,
				},
				{
					name: "Popular Game",
					cover: { image_id: "co_pop" },
					total_rating_count: 5000,
					rating_count: 3000,
				},
			],
		});

		const result = await fetchGameMetadata("game", CONFIG);
		expect(result!.canonicalName).toBe("Popular Game");
		expect(result!.thumbnail).toContain("co_pop");
	});

	it("returns null thumbnail when cover is missing", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: [
				{
					name: "No Cover Game",
					total_rating_count: 10,
				},
			],
		});

		const result = await fetchGameMetadata("no cover", CONFIG);
		expect(result!.canonicalName).toBe("No Cover Game");
		expect(result!.thumbnail).toBeNull();
	});

	it("returns null id when url is missing", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: [
				{
					name: "No URL Game",
					cover: { image_id: "co1abc" },
					total_rating_count: 10,
				},
			],
		});

		const result = await fetchGameMetadata("no url", CONFIG);
		expect(result!.id).toBeNull();
	});

	it("returns null when no results are returned", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: [],
		});

		expect(await fetchGameMetadata("nonexistent", CONFIG)).toBeNull();
	});

	it("returns null on HTTP error", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 500,
			text: "Internal Server Error",
		});

		expect(await fetchGameMetadata("hades", CONFIG)).toBeNull();
	});

	it("retries on 429 rate limit", async () => {
		mockRequestUrl
			.mockResolvedValueOnce({ status: 429, text: "Too Many Requests" })
			.mockResolvedValueOnce({
				status: 200,
				json: [
					{
						name: "Hades",
						cover: { image_id: "co1abc" },
						total_rating_count: 100,
					},
				],
			});

		const result = await fetchGameMetadata("hades", CONFIG);
		expect(result!.canonicalName).toBe("Hades");
		expect(mockRequestUrl).toHaveBeenCalledTimes(2);
	});

	it("gives up after max retries", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 429,
			text: "Too Many Requests",
		});

		expect(await fetchGameMetadata("hades", CONFIG)).toBeNull();
		expect(mockRequestUrl).toHaveBeenCalledTimes(3);
	});

	it("escapes double quotes in search term", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: [],
		});

		await fetchGameMetadata('Game "Deluxe"', CONFIG);
		const body = mockRequestUrl.mock.calls[0][0].body;
		expect(body).toContain('Game \\"Deluxe\\"');
	});

	it("sends correct headers", async () => {
		mockRequestUrl.mockResolvedValue({ status: 200, json: [] });

		await fetchGameMetadata("test", CONFIG);
		const headers = mockRequestUrl.mock.calls[0][0].headers;
		expect(headers["Client-ID"]).toBe("test-client-id");
		expect(headers["Authorization"]).toBe("Bearer test-token");
	});
});

describe("searchGames", () => {
	it("returns empty array for empty input", async () => {
		expect(await searchGames("", CONFIG)).toEqual([]);
	});

	it("returns multiple ranked results with ids", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: [
				{ name: "Game A", url: "https://www.igdb.com/games/game-a", cover: { image_id: "a1" }, total_rating_count: 10 },
				{ name: "Game B", url: "https://www.igdb.com/games/game-b", cover: { image_id: "b1" }, total_rating_count: 500 },
				{ name: "Game C", url: "https://www.igdb.com/games/game-c", cover: { image_id: "c1" }, total_rating_count: 100 },
			],
		});

		const results = await searchGames("game", CONFIG);
		expect(results).toHaveLength(3);
		expect(results[0].canonicalName).toBe("Game B");
		expect(results[1].canonicalName).toBe("Game C");
		expect(results[2].canonicalName).toBe("Game A");
		expect(results[0].thumbnail).toContain("b1");
		expect(results[0].id).toBe("https://www.igdb.com/games/game-b");
	});

	it("returns empty array on error", async () => {
		mockRequestUrl.mockResolvedValue({ status: 500, text: "Error" });
		expect(await searchGames("game", CONFIG)).toEqual([]);
	});
});

describe("requestIgdbAccessToken", () => {
	it("returns access token on success", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				access_token: "new-token",
				expires_in: 3600,
			},
		});

		const result = await requestIgdbAccessToken("client-id", "client-secret");
		expect(result).not.toBeNull();
		expect(result!.accessToken).toBe("new-token");
		expect(result!.expiresIn).toBe(3600);
	});

	it("returns null on HTTP error", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 401,
			text: "Unauthorized",
		});

		expect(
			await requestIgdbAccessToken("client-id", "bad-secret")
		).toBeNull();
	});

	it("returns null on network error", async () => {
		mockRequestUrl.mockRejectedValue(new Error("Network error"));

		expect(
			await requestIgdbAccessToken("client-id", "client-secret")
		).toBeNull();
	});

	it("returns null when response is missing access_token", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { expires_in: 3600 },
		});

		expect(
			await requestIgdbAccessToken("client-id", "client-secret")
		).toBeNull();
	});

	it("returns null when response is missing expires_in", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { access_token: "tok" },
		});

		expect(
			await requestIgdbAccessToken("client-id", "client-secret")
		).toBeNull();
	});

	it("falls back to text parsing when json is not an object", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: null,
			text: JSON.stringify({
				access_token: "fallback-token",
				expires_in: 7200,
			}),
		});

		const result = await requestIgdbAccessToken("id", "secret");
		expect(result!.accessToken).toBe("fallback-token");
		expect(result!.expiresIn).toBe(7200);
	});
});
