import { describe, it, expect } from "vitest";
import { extractFrontmatter, convertToMarkdown } from "./frontmatter";

describe("extractFrontmatter", () => {
	it("extracts frontmatter and content from a valid document", () => {
		const md = `---\nstatus: complete\nthumbnail: https://example.com/img.jpg\n---\n\nSome content here.`;
		const result = extractFrontmatter(md);
		expect(result.frontmatter["status"]).toBe("complete");
		expect(result.frontmatter["thumbnail"]).toBe(
			"https://example.com/img.jpg"
		);
		expect(result.content).toBe("Some content here.");
	});

	it("returns empty frontmatter when document has no frontmatter", () => {
		const md = "Just some content.";
		const result = extractFrontmatter(md);
		expect(result.frontmatter).toEqual({});
		expect(result.content).toBe("Just some content.");
	});

	it("returns empty frontmatter when closing delimiter is missing", () => {
		const md = "---\nstatus: complete\nNo closing delimiter";
		const result = extractFrontmatter(md);
		expect(result.frontmatter).toEqual({});
	});

	it("handles empty content after frontmatter", () => {
		const md = "---\nstatus: active\n---\n";
		const result = extractFrontmatter(md);
		expect(result.frontmatter["status"]).toBe("active");
		expect(result.content).toBe("");
	});
});

describe("convertToMarkdown", () => {
	it("produces valid markdown with frontmatter", () => {
		const data = {
			frontmatter: { status: "complete", thumbnail: "https://img.jpg" },
			content: "Body text",
		};
		const md = convertToMarkdown(data);
		expect(md).toContain("---\n");
		expect(md).toContain("status: complete");
		expect(md).toContain("thumbnail: https://img.jpg");
		expect(md).toContain("Body text");
	});

	it("returns just content when frontmatter is empty", () => {
		const data = { frontmatter: {}, content: "Just content" };
		const md = convertToMarkdown(data);
		expect(md).toBe("Just content");
	});

	it("round-trips through extract and convert", () => {
		const original = `---\nstatus: backlog\nstatus date: 2024-01-15\n---\n\n![Cover Image](https://example.com/cover.jpg)\n`;
		const data = extractFrontmatter(original);
		data.frontmatter["thumbnail"] = "https://example.com/cover.jpg";
		const md = convertToMarkdown(data);
		expect(md).toContain("status: backlog");
		expect(md).toContain("status date: 2024-01-15");
		expect(md).toContain("thumbnail: https://example.com/cover.jpg");
		expect(md).toContain("![Cover Image](https://example.com/cover.jpg)");
	});
});
