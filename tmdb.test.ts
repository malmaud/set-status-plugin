import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRequestUrl } = vi.hoisted(() => ({
	mockRequestUrl: vi.fn(),
}));
vi.mock("obsidian", () => ({ requestUrl: mockRequestUrl }));

import { fetchTvShowMetadata, stripSeasonSuffix } from "./tmdb";

beforeEach(() => {
	mockRequestUrl.mockReset();
});

describe("fetchTvShowMetadata", () => {
	const API_KEY = "test-api-key";

	it("returns null for empty input", async () => {
		expect(await fetchTvShowMetadata("", API_KEY)).toBeNull();
		expect(await fetchTvShowMetadata("   ", API_KEY)).toBeNull();
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});

	it("returns null when API key is empty", async () => {
		expect(await fetchTvShowMetadata("Breaking Bad", "")).toBeNull();
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});

	it("returns thumbnail and canonical name for a valid result", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				results: [
					{
						name: "Breaking Bad",
						poster_path: "/ggFHVNu6YYI5L9pCfOacjizRGt.jpg",
						popularity: 200,
						vote_count: 5000,
					},
				],
			},
		});

		const result = await fetchTvShowMetadata("breaking bad", API_KEY);
		expect(result).not.toBeNull();
		expect(result!.canonicalName).toBe("Breaking Bad");
		expect(result!.thumbnail).toBe(
			"https://image.tmdb.org/t/p/w500/ggFHVNu6YYI5L9pCfOacjizRGt.jpg"
		);
	});

	it("ranks results by popularity + vote count", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				results: [
					{
						name: "Obscure Show",
						poster_path: "/obscure.jpg",
						popularity: 1,
						vote_count: 2,
					},
					{
						name: "Popular Show",
						poster_path: "/popular.jpg",
						popularity: 500,
						vote_count: 10000,
					},
				],
			},
		});

		const result = await fetchTvShowMetadata("show", API_KEY);
		expect(result!.canonicalName).toBe("Popular Show");
		expect(result!.thumbnail).toContain("/popular.jpg");
	});

	it("returns null thumbnail when poster_path is missing", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				results: [
					{
						name: "No Poster Show",
						popularity: 10,
						vote_count: 5,
					},
				],
			},
		});

		const result = await fetchTvShowMetadata("no poster", API_KEY);
		expect(result!.canonicalName).toBe("No Poster Show");
		expect(result!.thumbnail).toBeNull();
	});

	it("returns null when no results are returned", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { results: [] },
		});

		expect(await fetchTvShowMetadata("nonexistent", API_KEY)).toBeNull();
	});

	it("returns null on HTTP error", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 401,
			text: "Unauthorized",
		});

		expect(await fetchTvShowMetadata("test", API_KEY)).toBeNull();
	});

	it("retries on 429 rate limit", async () => {
		mockRequestUrl
			.mockResolvedValueOnce({ status: 429, text: "Too Many Requests" })
			.mockResolvedValueOnce({
				status: 200,
				json: {
					results: [
						{
							name: "The Wire",
							poster_path: "/wire.jpg",
							popularity: 100,
							vote_count: 500,
						},
					],
				},
			});

		const result = await fetchTvShowMetadata("the wire", API_KEY);
		expect(result!.canonicalName).toBe("The Wire");
		expect(mockRequestUrl).toHaveBeenCalledTimes(2);
	});

	it("retries on network error", async () => {
		mockRequestUrl
			.mockRejectedValueOnce(new Error("Network error"))
			.mockResolvedValueOnce({
				status: 200,
				json: {
					results: [
						{
							name: "Seinfeld",
							poster_path: "/seinfeld.jpg",
							popularity: 80,
							vote_count: 300,
						},
					],
				},
			});

		const result = await fetchTvShowMetadata("seinfeld", API_KEY);
		expect(result!.canonicalName).toBe("Seinfeld");
		expect(mockRequestUrl).toHaveBeenCalledTimes(2);
	});

	it("gives up after max retries on persistent errors", async () => {
		mockRequestUrl.mockRejectedValue(new Error("Network error"));

		expect(await fetchTvShowMetadata("test", API_KEY)).toBeNull();
		expect(mockRequestUrl).toHaveBeenCalledTimes(3);
	});

	it("passes API key as query parameter", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { results: [] },
		});

		await fetchTvShowMetadata("test show", API_KEY);
		const calledUrl = mockRequestUrl.mock.calls[0][0].url;
		expect(calledUrl).toContain("api_key=test-api-key");
		expect(calledUrl).toContain("query=test+show");
	});

	it("strips season suffix before searching", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { results: [] },
		});

		await fetchTvShowMetadata("Breaking Bad Season 2", API_KEY);
		const calledUrl = mockRequestUrl.mock.calls[0][0].url;
		expect(calledUrl).toContain("query=Breaking+Bad");
		expect(calledUrl).not.toContain("Season");
	});

	it("strips s1-style suffix before searching", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { results: [] },
		});

		await fetchTvShowMetadata("Severance s1", API_KEY);
		const calledUrl = mockRequestUrl.mock.calls[0][0].url;
		expect(calledUrl).toContain("query=Severance");
		expect(calledUrl).not.toContain("s1");
	});
});

describe("stripSeasonSuffix", () => {
	it("strips 'season N'", () => {
		expect(stripSeasonSuffix("Breaking Bad season 2")).toBe("Breaking Bad");
		expect(stripSeasonSuffix("Breaking Bad Season 1")).toBe("Breaking Bad");
	});

	it("strips 'series N'", () => {
		expect(stripSeasonSuffix("Taskmaster series 14")).toBe("Taskmaster");
	});

	it("strips 'sN' shorthand", () => {
		expect(stripSeasonSuffix("Severance s1")).toBe("Severance");
		expect(stripSeasonSuffix("The Bear S3")).toBe("The Bear");
	});

	it("strips suffix with dash separator", () => {
		expect(stripSeasonSuffix("The Wire - Season 3")).toBe("The Wire");
		expect(stripSeasonSuffix("Fargo – Season 2")).toBe("Fargo");
	});

	it("leaves titles without season suffix unchanged", () => {
		expect(stripSeasonSuffix("Breaking Bad")).toBe("Breaking Bad");
		expect(stripSeasonSuffix("S.W.A.T.")).toBe("S.W.A.T.");
	});

	it("does not strip season from the middle of a title", () => {
		expect(stripSeasonSuffix("Season of the Witch")).toBe("Season of the Witch");
	});
});
