import { App, Editor, FuzzySuggestModal, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import * as yaml from 'yaml'
import * as datefns from 'date-fns'

interface DocumentData {
    frontmatter: Record<string, any>;
    content: string;
	originalYaml?: yaml.Document;
}

interface Status {
    name: string;
}

const STATUS_NAMES = ['complete', 'abandoned', 'backlog', 'in progress'] as const
const STATUS_CHOICES = STATUS_NAMES.map(name=>{return {name: name}}) as Status[]

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

		this.addCommand({id: 'modal', name: 'Set status', callback: ()=>this.openStatusChangeModal()})
		this.addRibbonIcon('circle-check', 'Set status', ()=>this.openStatusChangeModal())
	}

	openStatusChangeModal() {
		new ChoiceModal(this.app, this.setStatus.bind(this)).open();
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

		data.frontmatter['status'] = status.name

		const formattedDate = datefns.format(new Date(), 'yyyy-MM-dd')
		data.frontmatter['status date'] = formattedDate

		const markdown = convertToMarkdown(data)
		await vault.modify(file, markdown)
	}

	onunload() {

	}

}

class ChoiceModal extends FuzzySuggestModal<Status> {
    onSubmit: (choice: Status)=>Promise<void>;
    constructor(app: App, onSubmit: (choice: Status)=>Promise<void>) {
        super(app);
		this.onSubmit = onSubmit
    }

    getItems(): Status[] {
        return STATUS_CHOICES;
    }

    getItemText(status: Status): string {
        return status.name
    }

    onChooseItem(status: Status, evt: MouseEvent | KeyboardEvent) {
        this.onSubmit(status)
    }
}
