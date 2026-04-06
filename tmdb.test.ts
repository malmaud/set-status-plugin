import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRequestUrl } = vi.hoisted(() => ({
	mockRequestUrl: vi.fn(),
}));
vi.mock("obsidian", () => ({ requestUrl: mockRequestUrl }));

import { fetchTvShowMetadata, searchTvShows, stripSeasonSuffix, loosen } from "./tmdb";

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

	it("returns thumbnail, canonical name, and id for a tv result", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				results: [
					{
						id: 1396,
						media_type: "tv",
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
		expect(result!.id).toBe("https://www.themoviedb.org/tv/1396");
	});

	it("returns movie results with correct url", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				results: [
					{
						id: 546554,
						media_type: "movie",
						title: "Wake Up Dead Man",
						poster_path: "/wudm.jpg",
						popularity: 300,
						vote_count: 1000,
					},
				],
			},
		});

		const result = await fetchTvShowMetadata("wake up dead man", API_KEY);
		expect(result).not.toBeNull();
		expect(result!.canonicalName).toBe("Wake Up Dead Man");
		expect(result!.id).toBe("https://www.themoviedb.org/movie/546554");
	});

	it("uses title field for movies and name field for tv", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				results: [
					{
						id: 1,
						media_type: "movie",
						title: "Movie Title",
						poster_path: "/movie.jpg",
						popularity: 100,
						vote_count: 50,
					},
				],
			},
		});

		const result = await fetchTvShowMetadata("movie title", API_KEY);
		expect(result!.canonicalName).toBe("Movie Title");
	});

	it("filters out person results", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				results: [
					{
						id: 999,
						media_type: "person",
						name: "Some Actor",
						popularity: 9999,
						vote_count: 0,
					},
					{
						id: 1,
						media_type: "tv",
						name: "Actual Show",
						poster_path: "/show.jpg",
						popularity: 10,
						vote_count: 5,
					},
				],
			},
		});

		const result = await fetchTvShowMetadata("some actor", API_KEY);
		expect(result!.canonicalName).toBe("Actual Show");
	});

	it("ranks results by popularity + vote count", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				results: [
					{
						media_type: "tv",
						name: "Obscure Show",
						poster_path: "/obscure.jpg",
						popularity: 1,
						vote_count: 2,
					},
					{
						media_type: "tv",
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
						media_type: "tv",
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

	it("returns null id when id is missing from response", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				results: [
					{
						media_type: "tv",
						name: "No ID Show",
						poster_path: "/test.jpg",
						popularity: 10,
						vote_count: 5,
					},
				],
			},
		});

		const result = await fetchTvShowMetadata("no id", API_KEY);
		expect(result!.id).toBeNull();
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
							media_type: "tv",
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
							media_type: "tv",
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

describe("searchTvShows", () => {
	const API_KEY = "test-api-key";

	it("returns empty array for empty input", async () => {
		expect(await searchTvShows("", API_KEY)).toEqual([]);
	});

	it("returns multiple ranked results", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				results: [
					{ media_type: "tv", name: "Show A", poster_path: "/a.jpg", popularity: 1, vote_count: 2 },
					{ media_type: "tv", name: "Show B", poster_path: "/b.jpg", popularity: 500, vote_count: 1000 },
					{ media_type: "tv", name: "Show C", poster_path: "/c.jpg", popularity: 50, vote_count: 100 },
				],
			},
		});

		const results = await searchTvShows("show", API_KEY);
		expect(results).toHaveLength(3);
		expect(results[0].canonicalName).toBe("Show B");
		expect(results[1].canonicalName).toBe("Show C");
		expect(results[2].canonicalName).toBe("Show A");
	});

	it("returns empty array on error", async () => {
		mockRequestUrl.mockResolvedValue({ status: 500, text: "Error" });
		expect(await searchTvShows("show", API_KEY)).toEqual([]);
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

describe("loosen", () => {
	it("strips punctuation", () => {
		expect(loosen("S.W.A.T.")).toBe("S W A T");
	});

	it("strips apostrophes and special chars", () => {
		expect(loosen("Abbott's Elementary")).toBe("Abbott s Elementary");
	});

	it("collapses extra spaces", () => {
		expect(loosen("The   Bear")).toBe("The Bear");
	});

	it("leaves clean titles unchanged", () => {
		expect(loosen("Breaking Bad")).toBe("Breaking Bad");
	});
});

describe("loosened search fallback", () => {
	const API_KEY = "test-api-key";

	it("retries with loosened query when exact search returns no results", async () => {
		mockRequestUrl
			.mockResolvedValueOnce({
				status: 200,
				json: { results: [] },
			})
			.mockResolvedValueOnce({
				status: 200,
				json: {
					results: [
						{
							id: 123,
							media_type: "tv",
							name: "S.W.A.T.",
							poster_path: "/swat.jpg",
							popularity: 100,
							vote_count: 50,
						},
					],
				},
			});

		const result = await fetchTvShowMetadata("S.W.A.T.", API_KEY);
		expect(result).not.toBeNull();
		expect(result!.canonicalName).toBe("S.W.A.T.");
		expect(mockRequestUrl).toHaveBeenCalledTimes(2);
	});

	it("does not retry when loosened query is the same", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { results: [] },
		});

		const result = await fetchTvShowMetadata("Breaking Bad", API_KEY);
		expect(result).toBeNull();
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
	});

	it("returns first result without retrying when exact search succeeds", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				results: [
					{
						id: 1,
						media_type: "tv",
						name: "The Bear",
						poster_path: "/bear.jpg",
						popularity: 200,
						vote_count: 100,
					},
				],
			},
		});

		const result = await fetchTvShowMetadata("The Bear", API_KEY);
		expect(result!.canonicalName).toBe("The Bear");
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
	});
});
