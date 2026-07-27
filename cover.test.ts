import { describe, it, expect } from "vitest";
import { upsertCoverImage } from "./cover";

const COVER = "https://example.com/new.jpg";

describe("upsertCoverImage", () => {
	it("inserts a cover into an empty body", () => {
		const { text, changed } = upsertCoverImage("", COVER);
		expect(text).toBe(`![Cover Image](${COVER})\n`);
		expect(changed).toBe(true);
	});

	it("replaces an existing cover line in place", () => {
		const { text } = upsertCoverImage(
			"![Cover Image](https://example.com/old.jpg)\n\nSome notes.",
			COVER
		);
		expect(text).toBe(`![Cover Image](${COVER})\n\nSome notes.\n`);
	});

	it("preserves other images in the body", () => {
		const body = [
			"![Cover Image](https://example.com/old.jpg)",
			"",
			"Some notes.",
			"",
			"![screenshot](attachments/shot.png)",
			"![another](attachments/two.png)",
		].join("\n");

		const { text } = upsertCoverImage(body, COVER);
		expect(text).toContain("![screenshot](attachments/shot.png)");
		expect(text).toContain("![another](attachments/two.png)");
		expect(text).toContain(`![Cover Image](${COVER})`);
		expect(text).not.toContain("old.jpg");
	});

	it("prepends the cover when the body has no cover image", () => {
		const { text } = upsertCoverImage(
			"Some notes.\n\n![screenshot](attachments/shot.png)",
			COVER
		);
		expect(text).toBe(
			`![Cover Image](${COVER})\n\nSome notes.\n\n![screenshot](attachments/shot.png)\n`
		);
	});

	it("treats a lone leading image as the cover even with different alt text", () => {
		const { text } = upsertCoverImage(
			"![](https://example.com/old.jpg)\n\nSome notes.",
			COVER
		);
		expect(text).toBe(`![Cover Image](${COVER})\n\nSome notes.\n`);
	});

	it("does not treat a body image as the cover when text comes first", () => {
		const { text } = upsertCoverImage(
			"Intro paragraph.\n\n![diagram](d.png)",
			COVER
		);
		expect(text).toBe(
			`![Cover Image](${COVER})\n\nIntro paragraph.\n\n![diagram](d.png)\n`
		);
	});

	it("reports no change when the cover already matches", () => {
		const body = `![Cover Image](${COVER})\n\nSome notes.`;
		const { text, changed } = upsertCoverImage(body, COVER);
		expect(changed).toBe(false);
		expect(text.trimEnd()).toBe(body);
	});

	it("normalizes CRLF line endings", () => {
		const { text } = upsertCoverImage(
			"![Cover Image](https://example.com/old.jpg)\r\n\r\nSome notes.",
			COVER
		);
		expect(text).toBe(`![Cover Image](${COVER})\n\nSome notes.\n`);
	});

	it("leaves an inline image inside a paragraph alone", () => {
		const body = "See ![inline](x.png) here.";
		const { text } = upsertCoverImage(body, COVER);
		expect(text).toBe(`![Cover Image](${COVER})\n\nSee ![inline](x.png) here.\n`);
	});
});
