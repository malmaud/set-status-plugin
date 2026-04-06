import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRequestUrl } = vi.hoisted(() => ({
	mockRequestUrl: vi.fn(),
}));
vi.mock("obsidian", () => ({ requestUrl: mockRequestUrl }));

import { fetchBookMetadata, searchBooks } from "./openlibrary";

beforeEach(() => {
	mockRequestUrl.mockReset();
});

function mockSearchResponse(docs: Record<string, unknown>[]) {
	return { status: 200, json: { docs } };
}

describe("fetchBookMetadata", () => {
	it("returns null for empty input", async () => {
		expect(await fetchBookMetadata("")).toBeNull();
		expect(await fetchBookMetadata("   ")).toBeNull();
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});

	it("returns thumbnail from cover_i when no language set", async () => {
		mockRequestUrl.mockResolvedValue(
			mockSearchResponse([
				{ title: "Dune", cover_i: 8227891, ratings_count: 500 },
			])
		);

		const result = await fetchBookMetadata("dune");
		expect(result!.canonicalName).toBe("Dune");
		expect(result!.thumbnail).toBe(
			"https://covers.openlibrary.org/b/id/8227891-M.jpg"
		);
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
	});

	it("uses edition cover when language matches", async () => {
		mockRequestUrl.mockResolvedValue(
			mockSearchResponse([
				{
					title: "Abaddon's Gate",
					cover_i: 9999,
					ratings_count: 100,
					editions: {
						docs: [
							{ key: "/books/OL25644253M", cover_i: 7314236, language: ["eng"] },
						],
					},
				},
			])
		);

		const result = await fetchBookMetadata("abaddon's gate", "eng");
		expect(result!.thumbnail).toBe(
			"https://covers.openlibrary.org/b/id/7314236-M.jpg"
		);
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
	});

	it("falls back to cover_i when edition language does not match", async () => {
		mockRequestUrl.mockResolvedValue(
			mockSearchResponse([
				{
					title: "Some Book",
					cover_i: 5555,
					ratings_count: 10,
					editions: {
						docs: [
							{ key: "/books/OL1M", cover_i: 1111, language: ["fra"] },
						],
					},
				},
			])
		);

		const result = await fetchBookMetadata("some book", "eng");
		expect(result!.thumbnail).toBe(
			"https://covers.openlibrary.org/b/id/5555-M.jpg"
		);
	});

	it("falls back to cover_i when edition has no cover", async () => {
		mockRequestUrl.mockResolvedValue(
			mockSearchResponse([
				{
					title: "Some Book",
					cover_i: 5555,
					ratings_count: 10,
					editions: {
						docs: [{ key: "/books/OL1M", language: ["eng"] }],
					},
				},
			])
		);

		const result = await fetchBookMetadata("some book", "eng");
		expect(result!.thumbnail).toBe(
			"https://covers.openlibrary.org/b/id/5555-M.jpg"
		);
	});

	it("uses edition cover when no language preference set", async () => {
		mockRequestUrl.mockResolvedValue(
			mockSearchResponse([
				{
					title: "Book",
					cover_i: 9999,
					ratings_count: 10,
					editions: {
						docs: [
							{ key: "/books/OL1M", cover_i: 4444, language: ["fra"] },
						],
					},
				},
			])
		);

		const result = await fetchBookMetadata("book");
		// No language preference, so edition cover is used regardless
		expect(result!.thumbnail).toContain("4444");
	});

	it("ranks results by combined popularity", async () => {
		mockRequestUrl.mockResolvedValue(
			mockSearchResponse([
				{ title: "Obscure Book", cover_i: 111, ratings_count: 1 },
				{ title: "Popular Book", cover_i: 222, ratings_count: 500, want_to_read_count: 1000 },
			])
		);

		const result = await fetchBookMetadata("book");
		expect(result!.canonicalName).toBe("Popular Book");
		expect(result!.thumbnail).toContain("222");
	});

	it("returns null thumbnail when no cover info exists", async () => {
		mockRequestUrl.mockResolvedValue(
			mockSearchResponse([{ title: "No Cover Book", ratings_count: 5 }])
		);

		const result = await fetchBookMetadata("no cover book");
		expect(result!.canonicalName).toBe("No Cover Book");
		expect(result!.thumbnail).toBeNull();
	});

	it("returns null when no docs are returned", async () => {
		mockRequestUrl.mockResolvedValue(mockSearchResponse([]));
		expect(await fetchBookMetadata("nonexistent")).toBeNull();
	});

	it("returns null on HTTP error", async () => {
		mockRequestUrl.mockResolvedValue({ status: 500, text: "Internal Server Error" });
		expect(await fetchBookMetadata("dune")).toBeNull();
	});

	it("retries on 429 rate limit", async () => {
		vi.useFakeTimers();
		mockRequestUrl
			.mockResolvedValueOnce({ status: 429, text: "Too Many Requests" })
			.mockResolvedValueOnce(
				mockSearchResponse([{ title: "Dune", cover_i: 123, ratings_count: 10 }])
			);

		const promise = fetchBookMetadata("dune");
		await vi.runAllTimersAsync();
		const result = await promise;
		expect(result!.canonicalName).toBe("Dune");
		expect(mockRequestUrl).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});

	it("retries on network error", async () => {
		vi.useFakeTimers();
		mockRequestUrl
			.mockRejectedValueOnce(new Error("Network error"))
			.mockResolvedValueOnce(
				mockSearchResponse([{ title: "Dune", cover_i: 456, ratings_count: 10 }])
			);

		const promise = fetchBookMetadata("dune");
		await vi.runAllTimersAsync();
		const result = await promise;
		expect(result!.canonicalName).toBe("Dune");
		expect(mockRequestUrl).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});

	it("gives up after max retries on persistent errors", async () => {
		vi.useFakeTimers();
		mockRequestUrl.mockRejectedValue(new Error("Network error"));

		const promise = fetchBookMetadata("dune");
		for (let i = 0; i < 5; i++) {
			await vi.runAllTimersAsync();
		}
		expect(await promise).toBeNull();
		expect(mockRequestUrl).toHaveBeenCalledTimes(5);
		vi.useRealTimers();
	});
});

describe("searchBooks", () => {
	it("returns empty array for empty input", async () => {
		expect(await searchBooks("")).toEqual([]);
	});

	it("returns multiple ranked results", async () => {
		mockRequestUrl.mockResolvedValue(
			mockSearchResponse([
				{ title: "Obscure Book", cover_i: 111, ratings_count: 1 },
				{ title: "Popular Book", cover_i: 222, ratings_count: 500 },
				{ title: "Mid Book", cover_i: 333, ratings_count: 50 },
			])
		);

		const results = await searchBooks("book");
		expect(results).toHaveLength(3);
		expect(results[0].canonicalName).toBe("Popular Book");
		expect(results[1].canonicalName).toBe("Mid Book");
		expect(results[2].canonicalName).toBe("Obscure Book");
	});

	it("uses edition covers when available and language matches", async () => {
		mockRequestUrl.mockResolvedValue(
			mockSearchResponse([
				{
					title: "Book A",
					cover_i: 100,
					ratings_count: 10,
					editions: {
						docs: [{ cover_i: 7777, language: ["eng"] }],
					},
				},
				{
					title: "Book B",
					cover_i: 200,
					ratings_count: 5,
					editions: {
						docs: [{ cover_i: 8888, language: ["eng"] }],
					},
				},
			])
		);

		const results = await searchBooks("book", "eng");
		expect(results[0].thumbnail).toContain("7777");
		expect(results[1].thumbnail).toContain("8888");
		// Only 1 API call — no separate editions requests
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
	});

	it("returns empty array on error", async () => {
		mockRequestUrl.mockResolvedValue({ status: 500, text: "Error" });
		expect(await searchBooks("book")).toEqual([]);
	});
});
