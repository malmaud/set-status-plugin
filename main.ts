import {
	App,
	Editor,
	FuzzySuggestModal,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";
import * as datefns from "date-fns";
import { extractFrontmatter, convertToMarkdown } from "./frontmatter";

interface Status {
	name: string;
}

interface Settings {
	statusNames: string[];
	dateFormat: string;
}

const DEFAULT_SETTINGS: Settings = {
	statusNames: ["complete", "abandoned", "backlog", "in progress"],
	dateFormat: "yyyy-MM-dd",
};

export default class MyPlugin extends Plugin {
	settings: Settings;

	async onload() {
		console.log("loaded status updates");

		await this.loadSettings();
		console.log("Settings:", this.settings);
		this.addCommand({
			id: "modal",
			name: "Set status",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) {
					return false;
				}
				if (!checking) {
					this.openStatusChangeModal();
				}
				return true;
			},
		});
		this.addRibbonIcon("circle-check", "Set status", () =>
			this.openStatusChangeModal()
		);

		this.addSettingTab(new SettingsTab(this.app, this));
	}

	async loadSettings(): Promise<Settings> {
		const settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
		this.settings = settings;
		return settings;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	openStatusChangeModal() {
		const statusChoices = this.settings.statusNames.map((name) => {
			return { name };
		});
		new ChoiceModal(
			this.app,
			this.setStatus.bind(this),
			statusChoices
		).open();
	}

	async setStatus(status: Status) {
		console.log("doThing running");
		const file = this.app.workspace.getActiveFile();
		const vault = this.app.vault;

		if (!file) {
			new Notice("no file");
			return;
		}

		const content = await vault.read(file);

		console.log(`file contains ${content}`);

		const data = extractFrontmatter(content);
		console.log(`frontmatter: ${JSON.stringify(data.frontmatter)}`);

		data.frontmatter["status"] = status.name;

		const formattedDate = datefns.format(
			new Date(),
			this.settings.dateFormat
		);
		data.frontmatter["status date"] = formattedDate;

		const markdown = convertToMarkdown(data);
		await vault.modify(file, markdown);
	}

	onunload() {}
}

class ChoiceModal extends FuzzySuggestModal<Status> {
	onSubmit: (choice: Status) => Promise<void>;
	statusChoices: Status[];
	constructor(
		app: App,
		onSubmit: (choice: Status) => Promise<void>,
		statusChoices: Status[]
	) {
		super(app);
		this.onSubmit = onSubmit;
		this.statusChoices = statusChoices;
	}

	getItems(): Status[] {
		return this.statusChoices;
	}

	getItemText(status: Status): string {
		return status.name;
	}

	onChooseItem(status: Status, evt: MouseEvent | KeyboardEvent) {
		this.onSubmit(status);
	}
}

class SettingsTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getStatuses(): string {
		return this.plugin.settings.statusNames.join("\n");
	}

	async setStatuses(text: string): Promise<void> {
		const statuses = text
			.split("\n")
			.map((s) => {
				return s.trim();
			})
			.filter((s) => s.length > 0);
		this.plugin.settings.statusNames = statuses;
		await this.plugin.saveSettings();
	}

	getDateFormat(): string {
		return this.plugin.settings.dateFormat;
	}

	async setDateFormat(value: string): Promise<void> {
		this.plugin.settings.dateFormat = value;
		await this.plugin.saveSettings();
	}

	display(): void {
		let containerEl = this.containerEl;
		containerEl.empty();
		new Setting(containerEl)
			.setName("Status options")
			.addTextArea((text) => {
				text.setPlaceholder("Status options")
					.setValue(this.getStatuses())
					.onChange(async (value) => {
						await this.setStatuses(value);
					})
					.then((text) => {
						text.inputEl.style.width = "100%";
						text.inputEl.rows = 10;
					});
			});
		new Setting(containerEl).setName("Date format").addText((text) => {
			text.setPlaceholder("yyyy-MM-dd")
				.setValue(this.getDateFormat())
				.onChange(async (value) => await this.setDateFormat(value));
		});
	}
}
