import * as yaml from "yaml";

export interface DocumentData {
	frontmatter: Record<string, any>;
	content: string;
	originalYaml?: yaml.Document;
}

export function extractFrontmatter(markdown: string): DocumentData {
	// Default return value for documents without frontmatter
	const defaultResult: DocumentData = {
		frontmatter: {},
		content: markdown,
	};

	// Check if document starts with frontmatter delimiter
	if (!markdown.startsWith("---\n")) {
		return defaultResult;
	}

	// Find the closing delimiter
	const endDelimiter = markdown.indexOf("\n---\n", 4);
	if (endDelimiter === -1) {
		return defaultResult;
	}

	try {
		const yamlContent = markdown.slice(4, endDelimiter);

		// Parse the YAML while preserving formatting
		const yamlDocument = yaml.parseDocument(yamlContent, {
			keepSourceTokens: true,
		});

		return {
			frontmatter: yamlDocument.toJSON(),
			content: markdown.slice(endDelimiter + 5).trim(),
			originalYaml: yamlDocument,
		};
	} catch (error) {
		console.error("Error parsing frontmatter:", error);
		return defaultResult;
	}
}

export function convertToMarkdown(data: DocumentData): string {
	// If there's no frontmatter, just return the content
	if (!data.frontmatter || Object.keys(data.frontmatter).length === 0) {
		return data.content;
	}

	let yamlString: string;

	if (data.originalYaml) {
		// If we have the original YAML document, use it to preserve formatting
		data.originalYaml.setIn([], data.frontmatter);
		yamlString = data.originalYaml.toString();
		console.info("have original yaml");
	} else {
		// Create a new YAML document with default formatting
		const doc = new yaml.Document();
		doc.contents = doc.createNode(data.frontmatter);
		yamlString = doc.toString();
	}
	// Combine frontmatter and content
	return `---\n${yamlString}---\n\n${data.content}`;
}
