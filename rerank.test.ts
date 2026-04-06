import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRequestUrl } = vi.hoisted(() => ({
	mockRequestUrl: vi.fn(),
}));
vi.mock("obsidian", () => ({ requestUrl: mockRequestUrl }));

import { rerankResults, testClaudeApiKey, correctTitle } from "./rerank";

beforeEach(() => {
	mockRequestUrl.mockReset();
});

const MODEL = "claude-haiku-4-5-20251001";

const items = [
	{ canonicalName: "The Bible", thumbnail: "/bible.jpg", id: null },
	{ canonicalName: "God of War", thumbnail: "/gow.jpg", id: null },
	{ canonicalName: "The God of the Woods", thumbnail: "/gotw.jpg", id: null },
];

describe("rerankResults", () => {
	it("returns results unchanged when apiKey is empty", async () => {
		const result = await rerankResults("query", items, "", MODEL);
		expect(result).toBe(items);
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});

	it("returns results unchanged when there is 0 or 1 result", async () => {
		const single = [items[0]];
		expect(await rerankResults("query", single, "sk-test", MODEL)).toBe(single);
		expect(await rerankResults("query", [], "sk-test", MODEL)).toEqual([]);
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});

	it("reorders results based on Claude response", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				content: [{ type: "text", text: "[2, 1, 0]" }],
			},
		});

		const result = await rerankResults("god of the woods", items, "sk-test", MODEL);
		expect(result[0].canonicalName).toBe("The God of the Woods");
		expect(result[1].canonicalName).toBe("God of War");
		expect(result[2].canonicalName).toBe("The Bible");
	});

	it("extracts JSON array from surrounding prose", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				content: [{ type: "text", text: "Here is the reordered list: [2, 0, 1]" }],
			},
		});

		const result = await rerankResults("query", items, "sk-test", MODEL);
		expect(result[0].canonicalName).toBe("The God of the Woods");
		expect(result[1].canonicalName).toBe("The Bible");
		expect(result[2].canonicalName).toBe("God of War");
	});

	it("falls back to original order on HTTP error", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 401,
			text: "Unauthorized",
		});

		const result = await rerankResults("query", items, "sk-bad-key", MODEL);
		expect(result).toBe(items);
	});

	it("falls back to original order on network error", async () => {
		mockRequestUrl.mockRejectedValue(new Error("Network error"));

		const result = await rerankResults("query", items, "sk-test", MODEL);
		expect(result).toBe(items);
	});

	it("falls back to original order when response is unparseable", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				content: [{ type: "text", text: "I'm not sure what you mean" }],
			},
		});

		const result = await rerankResults("query", items, "sk-test", MODEL);
		expect(result).toBe(items);
	});

	it("falls back when indices are out of bounds", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				content: [{ type: "text", text: "[0, 1, 5]" }],
			},
		});

		const result = await rerankResults("query", items, "sk-test", MODEL);
		expect(result).toBe(items);
	});

	it("falls back when indices have duplicates", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				content: [{ type: "text", text: "[0, 1, 1]" }],
			},
		});

		const result = await rerankResults("query", items, "sk-test", MODEL);
		expect(result).toBe(items);
	});

	it("falls back when indices length does not match", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				content: [{ type: "text", text: "[0, 1]" }],
			},
		});

		const result = await rerankResults("query", items, "sk-test", MODEL);
		expect(result).toBe(items);
	});

	it("sends correct request to Claude API", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				content: [{ type: "text", text: "[0, 1, 2]" }],
			},
		});

		await rerankResults("god of the woods", items, "sk-test-key", MODEL);

		const call = mockRequestUrl.mock.calls[0][0];
		expect(call.url).toBe("https://api.anthropic.com/v1/messages");
		expect(call.headers["x-api-key"]).toBe("sk-test-key");
		expect(call.headers["anthropic-version"]).toBe("2023-06-01");
		const body = JSON.parse(call.body);
		expect(body.model).toBe("claude-haiku-4-5-20251001");
		expect(body.messages[0].content).toContain("god of the woods");
		expect(body.messages[0].content).toContain("The Bible");
		expect(body.messages[0].content).toContain("The God of the Woods");
	});

	it("uses the specified model", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				content: [{ type: "text", text: "[0, 1, 2]" }],
			},
		});

		await rerankResults("query", items, "sk-test", "claude-sonnet-4-6-20250514");

		const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
		expect(body.model).toBe("claude-sonnet-4-6-20250514");
	});
});

describe("testClaudeApiKey", () => {
	it("returns not ok for empty key", async () => {
		const result = await testClaudeApiKey("", MODEL);
		expect(result.ok).toBe(false);
		expect(result.error).toBeDefined();
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});

	it("returns ok on successful response", async () => {
		mockRequestUrl.mockResolvedValue({ status: 200 });
		const result = await testClaudeApiKey("sk-valid", MODEL);
		expect(result.ok).toBe(true);
	});

	it("returns not ok with error detail on 401", async () => {
		mockRequestUrl.mockResolvedValue({ status: 401, text: "Unauthorized" });
		const result = await testClaudeApiKey("sk-bad", MODEL);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Unauthorized");
	});

	it("returns not ok with message on network error", async () => {
		mockRequestUrl.mockRejectedValue(new Error("Network error"));
		const result = await testClaudeApiKey("sk-test", MODEL);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Network error");
	});
});

describe("correctTitle", () => {
	it("returns null when apiKey is empty", async () => {
		expect(await correctTitle("Brekking Bad", "TV Show", "", MODEL)).toBeNull();
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});

	it("returns corrected title from Claude", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				content: [{ type: "text", text: "Breaking Bad" }],
			},
		});

		const result = await correctTitle("Brekking Bad", "TV Show", "sk-test", MODEL);
		expect(result).toBe("Breaking Bad");
	});

	it("returns original title when Claude echoes it back", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				content: [{ type: "text", text: "Breaking Bad" }],
			},
		});

		const result = await correctTitle("Breaking Bad", "TV Show", "sk-test", MODEL);
		expect(result).toBe("Breaking Bad");
	});

	it("returns null on API error", async () => {
		mockRequestUrl.mockResolvedValue({ status: 500, text: "Error" });
		expect(await correctTitle("test", "TV Show", "sk-test", MODEL)).toBeNull();
	});

	it("returns null on network error", async () => {
		mockRequestUrl.mockRejectedValue(new Error("Network error"));
		expect(await correctTitle("test", "TV Show", "sk-test", MODEL)).toBeNull();
	});
});
