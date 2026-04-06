import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRequestUrl } = vi.hoisted(() => ({
	mockRequestUrl: vi.fn(),
}));
vi.mock("obsidian", () => ({ requestUrl: mockRequestUrl }));

import { fetchBookMetadata } from "./openlibrary";

beforeEach(() => {
	mockRequestUrl.mockReset();
});

describe("fetchBookMetadata", () => {
	it("returns null for empty input", async () => {
		expect(await fetchBookMetadata("")).toBeNull();
		expect(await fetchBookMetadata("   ")).toBeNull();
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});

	it("returns thumbnail and canonical name for a valid result", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				docs: [
					{
						title: "Dune",
						cover_i: 8227891,
						ratings_count: 500,
						want_to_read_count: 1000,
						already_read_count: 200,
					},
				],
			},
		});

		const result = await fetchBookMetadata("dune");
		expect(result).not.toBeNull();
		expect(result!.canonicalName).toBe("Dune");
		expect(result!.thumbnail).toBe(
			"https://covers.openlibrary.org/b/id/8227891-M.jpg"
		);
	});

	it("ranks results by combined popularity", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				docs: [
					{
						title: "Obscure Book",
						cover_i: 111,
						ratings_count: 1,
						want_to_read_count: 0,
						already_read_count: 0,
					},
					{
						title: "Popular Book",
						cover_i: 222,
						ratings_count: 500,
						want_to_read_count: 1000,
						already_read_count: 200,
					},
				],
			},
		});

		const result = await fetchBookMetadata("book");
		expect(result!.canonicalName).toBe("Popular Book");
		expect(result!.thumbnail).toContain("222");
	});

	it("falls back to cover_edition_key when cover_i is missing", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				docs: [
					{
						title: "Some Book",
						cover_edition_key: "OL12345M",
						ratings_count: 10,
					},
				],
			},
		});

		const result = await fetchBookMetadata("some book");
		expect(result!.thumbnail).toBe(
			"https://covers.openlibrary.org/b/olid/OL12345M-M.jpg"
		);
	});

	it("falls back to edition_key[0] when cover_edition_key is missing", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				docs: [
					{
						title: "Another Book",
						edition_key: ["OL99999M"],
						ratings_count: 5,
					},
				],
			},
		});

		const result = await fetchBookMetadata("another book");
		expect(result!.thumbnail).toBe(
			"https://covers.openlibrary.org/b/olid/OL99999M-M.jpg"
		);
	});

	it("returns null thumbnail when no cover info exists", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				docs: [{ title: "No Cover Book", ratings_count: 5 }],
			},
		});

		const result = await fetchBookMetadata("no cover book");
		expect(result!.canonicalName).toBe("No Cover Book");
		expect(result!.thumbnail).toBeNull();
	});

	it("returns null when no docs are returned", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { docs: [] },
		});

		expect(await fetchBookMetadata("nonexistent")).toBeNull();
	});

	it("returns null on HTTP error", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 500,
			text: "Internal Server Error",
		});

		expect(await fetchBookMetadata("dune")).toBeNull();
	});

	it("retries on 429 rate limit", async () => {
		mockRequestUrl
			.mockResolvedValueOnce({ status: 429, text: "Too Many Requests" })
			.mockResolvedValueOnce({
				status: 200,
				json: {
					docs: [{ title: "Dune", cover_i: 123, ratings_count: 10 }],
				},
			});

		const result = await fetchBookMetadata("dune");
		expect(result!.canonicalName).toBe("Dune");
		expect(mockRequestUrl).toHaveBeenCalledTimes(2);
	});

	it("retries on network error", async () => {
		mockRequestUrl
			.mockRejectedValueOnce(new Error("Network error"))
			.mockResolvedValueOnce({
				status: 200,
				json: {
					docs: [{ title: "Dune", cover_i: 456, ratings_count: 10 }],
				},
			});

		const result = await fetchBookMetadata("dune");
		expect(result!.canonicalName).toBe("Dune");
		expect(mockRequestUrl).toHaveBeenCalledTimes(2);
	});

	it("gives up after max retries on persistent errors", async () => {
		mockRequestUrl.mockRejectedValue(new Error("Network error"));

		expect(await fetchBookMetadata("dune")).toBeNull();
		expect(mockRequestUrl).toHaveBeenCalledTimes(3);
	});
});
