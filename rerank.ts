import { requestUrl } from "obsidian";

const LOG_PREFIX = "[Set Status Plugin] [Rerank]";
const CLAUDE_API_ENDPOINT = "https://api.anthropic.com/v1/messages";

export async function testClaudeApiKey(apiKey: string, model: string): Promise<{ ok: boolean; error?: string }> {
	if (!apiKey) {
		return { ok: false, error: "No API key provided." };
	}
	try {
		const response = await requestUrl({
			url: CLAUDE_API_ENDPOINT,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model,
				max_tokens: 10,
				messages: [{ role: "user", content: "Say hi" }],
			}),
			throw: false,
		});
		if (response.status >= 200 && response.status < 400) {
			return { ok: true };
		}
		const detail = response.text ?? `HTTP ${response.status}`;
		console.warn(`${LOG_PREFIX} API key test failed (${response.status}): ${detail}`);
		return { ok: false, error: detail };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`${LOG_PREFIX} API key test error:`, error);
		return { ok: false, error: message };
	}
}

export async function correctTitle(
	title: string,
	mediaType: string,
	apiKey: string,
	model: string
): Promise<string | null> {
	if (!apiKey) {
		return null;
	}
	try {
		const response = await requestUrl({
			url: CLAUDE_API_ENDPOINT,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model,
				max_tokens: 1024,
				tools: [
					{
						type: "web_search_20250305",
						name: "web_search",
						max_uses: 3,
					},
				],
				messages: [
					{
						role: "user",
						content: `The user typed "${title}" as the title of a ${mediaType} they want to look up. This might contain typos, misspellings, abbreviations, or shorthand. Search the web to identify the most likely real ${mediaType} title this refers to. Respond with ONLY the corrected/expanded title. If you can't confidently identify it, respond with ONLY the original title. Do not add quotes or explanation.`,
					},
				],
			}),
			throw: false,
		});

		if (response.status >= 400) {
			console.warn(`${LOG_PREFIX} correctTitle API error (${response.status})`);
			return null;
		}

		const content = response.json?.content;
		if (!Array.isArray(content)) {
			return null;
		}
		// Find the last text block (after any web search tool use blocks)
		let corrected: string | null = null;
		for (let i = content.length - 1; i >= 0; i--) {
			if (content[i].type === "text" && typeof content[i].text === "string") {
				corrected = content[i].text.trim();
				break;
			}
		}
		if (!corrected) {
			return null;
		}

		if (corrected.toLowerCase() !== title.toLowerCase()) {
			console.info(`${LOG_PREFIX} Corrected title: "${title}" -> "${corrected}"`);
		}
		return corrected;
	} catch (error) {
		console.warn(`${LOG_PREFIX} correctTitle failed`, error);
		return null;
	}
}

export async function rerankResults<T extends { canonicalName: string | null }>(
	query: string,
	results: T[],
	apiKey: string,
	model: string
): Promise<T[]> {
	if (!apiKey || results.length <= 1) {
		return results;
	}

	try {
		const numbered = results
			.map((r, i) => `${i}. ${r.canonicalName ?? "Unknown"}`)
			.join("\n");

		const response = await requestUrl({
			url: CLAUDE_API_ENDPOINT,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model,
				max_tokens: 1024,
				tools: [
					{
						type: "web_search_20250305",
						name: "web_search",
						max_uses: 3,
					},
				],
				messages: [
					{
						role: "user",
						content: `I searched for "${query}" and got these results:\n${numbered}\n\nIf you're not sure which result best matches my query, search the web to find out. Return ONLY a JSON array of the 0-based indices reordered by best match to my query. Example: [2,0,1,3]`,
					},
				],
			}),
			throw: false,
		});

		if (response.status >= 400) {
			console.warn(`${LOG_PREFIX} API error (${response.status}): ${response.text ?? ""}`);
			return results;
		}

		const content = response.json?.content;
		let text = "";
		if (Array.isArray(content)) {
			for (let i = content.length - 1; i >= 0; i--) {
				if (content[i].type === "text" && typeof content[i].text === "string") {
					text = content[i].text;
					break;
				}
			}
		}
		const match = text.match(/\[[\d,\s]+\]/);
		if (!match) {
			console.warn(`${LOG_PREFIX} Could not parse indices from response: ${text}`);
			return results;
		}

		const indices: unknown = JSON.parse(match[0]);
		if (!Array.isArray(indices)) {
			return results;
		}

		const valid =
			indices.length === results.length &&
			indices.every(
				(v: unknown) =>
					typeof v === "number" &&
					Number.isInteger(v) &&
					v >= 0 &&
					v < results.length
			) &&
			new Set(indices).size === results.length;

		if (!valid) {
			console.warn(`${LOG_PREFIX} Invalid indices: ${JSON.stringify(indices)}`);
			return results;
		}

		console.info(`${LOG_PREFIX} Reranked "${query}": ${JSON.stringify(indices)}`);
		return (indices as number[]).map((i) => results[i]);
	} catch (error) {
		console.warn(`${LOG_PREFIX} Reranking failed, using original order`, error);
		return results;
	}
}
