const COVER_LINE = /^!\[cover image]\([^)]*\)$/i;
const IMAGE_LINE = /^!\[[^\]]*]\([^)]*\)$/;

/**
 * Put `thumbnail` at the top of a note body as the cover image, leaving every
 * other image in the body alone.
 *
 * The cover is identified as either the note's existing `![Cover Image](...)`
 * line, or — for notes whose alt text was edited — a lone image on the first
 * non-empty line. If neither is present the cover is inserted above the
 * existing body rather than replacing anything.
 */
export function upsertCoverImage(
	content: string,
	thumbnail: string
): { text: string; changed: boolean } {
	const coverLine = `![Cover Image](${thumbnail})`;
	const original = content.replace(/\r\n/g, "\n");
	const lines = original.split("\n");

	let index = lines.findIndex((line) => COVER_LINE.test(line.trim()));
	if (index === -1) {
		const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
		if (firstContentLine !== -1 && IMAGE_LINE.test(lines[firstContentLine].trim())) {
			index = firstContentLine;
		}
	}

	let text: string;
	if (index !== -1) {
		const next = [...lines];
		next[index] = coverLine;
		text = next.join("\n");
	} else {
		const body = original.replace(/^\n+/, "");
		text = body.length > 0 ? `${coverLine}\n\n${body}` : coverLine;
	}

	if (!text.endsWith("\n")) {
		text += "\n";
	}
	// Compare trimmed: callers hand us content that has already had trailing
	// whitespace stripped, so the newline we add is not a real change.
	return { text, changed: text.trimEnd() !== original.trimEnd() };
}
