import { App, Editor, FuzzySuggestModal, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import * as datefns from 'date-fns'
import { extractFrontmatter, convertToMarkdown } from './frontmatter';

interface Status {
    name: string;
}

const STATUS_NAMES = ['complete', 'abandoned', 'backlog', 'in progress'] as const
const STATUS_CHOICES = STATUS_NAMES.map(name=>{return {name: name}}) as Status[]


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
