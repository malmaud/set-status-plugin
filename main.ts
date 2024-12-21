import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import * as yaml from 'yaml'
import * as datefns from 'date-fns'

interface DocumentData {
    frontmatter: Record<string, any>;
    content: string;
	originalYaml?: yaml.Document;
}

const STATUS_CHOICES = ['complete', 'abandoned', 'backlog'] as const
type Status = typeof STATUS_CHOICES[number];

function extractFrontmatter(markdown: string): DocumentData {
    // Default return value for documents without frontmatter
    const defaultResult: DocumentData = {
        frontmatter: {},
        content: markdown
    };

    // Check if document starts with frontmatter delimiter
    if (!markdown.startsWith('---\n')) {
        return defaultResult;
    }

    // Find the closing delimiter
    const endDelimiter = markdown.indexOf('\n---\n', 4);
    if (endDelimiter === -1) {
        return defaultResult;
    }

    try {
        const yamlContent = markdown.slice(4, endDelimiter);
        
        // Parse the YAML while preserving formatting
        const yamlDocument = yaml.parseDocument(yamlContent, {keepSourceTokens: true})

        return {
            frontmatter: yamlDocument.toJSON(),
            content: markdown.slice(endDelimiter + 5).trim(),
            originalYaml: yamlDocument
        };;
    } catch (error) {
        console.error('Error parsing frontmatter:', error);
        return defaultResult;
    }
}

function convertToMarkdown(data: DocumentData): string {
    // If there's no frontmatter, just return the content
    if (!data.frontmatter || Object.keys(data.frontmatter).length === 0) {
        return data.content;
    }


	let yamlString: string;

    if (data.originalYaml) {
        // If we have the original YAML document, use it to preserve formatting
        data.originalYaml.setIn([], data.frontmatter);
        yamlString = data.originalYaml.toString();
		console.info('have original yaml')
    } else {
        // Create a new YAML document with default formatting
        const doc = new yaml.Document();
        doc.contents = doc.createNode(data.frontmatter);
        yamlString = doc.toString();
    }
    // Combine frontmatter and content
    return `---\n${yamlString}---\n\n${data.content}`;
}

export default class MyPlugin extends Plugin {

	async onload() {

		this.addCommand({id: 'modal', name: 'Open modal', callback: ()=>this.openStatusChangeModal()})
		this.addRibbonIcon('dice', 'Jon ribbon', ()=>this.openStatusChangeModal())
	}

	openStatusChangeModal() {
		new ChoiceModal(this.app, this.setStatus).open();
	}

	async setStatus(status: Status) {
		console.log('doThing running')
		const file = this.app.workspace.getActiveFile()
		const vault = this.app.vault

		if(!file) {
			new Notice("no file")
			return
		}

		const content = await vault.read(file)

		console.log(`file contains ${content}`)

		const data = extractFrontmatter(content)
		console.log(`frontmatter: ${JSON.stringify(data.frontmatter)}`)

		data.frontmatter['status'] = status

		const formattedDate = datefns.format(new Date(), 'yyyy-MM-dd')
		data.frontmatter['status date'] = formattedDate

		const markdown = convertToMarkdown(data)
		await vault.modify(file, markdown)
	}

	onunload() {

	}


}


class ChoiceModal extends Modal {
    result: Status | null = null;
	onSubmit: (choice: Status)=>Promise<void>;

    constructor(app: App, onSubmit: (choice: Status)=>Promise<void>) {
        super(app);
		this.onSubmit = onSubmit
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Set status' });

        const buttonContainer = contentEl.createDiv('button-container');
        buttonContainer.style.display = 'flex';
        buttonContainer.style.flexDirection = 'column';
        buttonContainer.style.gap = '8px';

        STATUS_CHOICES.forEach(choice => {
            const btn = buttonContainer.createEl('button', { text: choice });
            btn.addEventListener('click', async () => {
                this.result = choice;
				await this.onSubmit(this.result);
                this.close();
            });
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        
        if (this.result) {
            console.log(`Selected choice: ${this.result}`);
        }
    }
}

