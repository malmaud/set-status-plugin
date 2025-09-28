import {
	App,
	FuzzySuggestModal,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFolder,
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
	statusNames: ["complete", "abandoned", "backlog", "on radar", "in progress"],
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

		this.addCommand({
			id: "new_game",
			name: "New game",
			callback: () => this.newGameCommand(),
		});

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

	newGameCommand() {
		const statusOptions = this.settings.statusNames;
		new GameNameModal(
			this.app,
			statusOptions,
			this.createGameFile.bind(this)
		).open();
	}

	async createGameFile(gameName: string, status: string): Promise<void> {
		const vault = this.app.vault;
		const folderPath = "games";
		const sanitizedName = gameName
			.trim()
			.replace(/[\\/:<>"|?*]/g, "-");

		if (!sanitizedName) {
			new Notice("Game name cannot be empty");
			return;
		}

		const chosenStatus = status.trim();
		if (!chosenStatus) {
			new Notice("Please select a status");
			return;
		}

		const folder = vault.getAbstractFileByPath(folderPath);
		if (!folder) {
			await vault.createFolder(folderPath);
		} else if (!(folder instanceof TFolder)) {
			new Notice("'games' exists but is not a folder");
			return;
		}

		const filePath = `${folderPath}/${sanitizedName}.md`;
		if (vault.getAbstractFileByPath(filePath)) {
			new Notice(`Game '${sanitizedName}' already exists`);
			return;
		}

		const formattedDate = datefns.format(new Date(), this.settings.dateFormat);
		const content = [
			"---",
			`status: ${chosenStatus}`,
			`status date: ${formattedDate}`,
			"---",
			"",
		].join("\n");

		await vault.create(filePath, content);
		new Notice(`Created ${filePath}`);
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

class GameNameModal extends Modal {
	onSubmit: (gameName: string, status: string) => Promise<void>;
	private readonly statuses: string[];
	private gameName = "";
	private selectedStatus: string;

	constructor(
		app: App,
		statuses: string[],
		onSubmit: (gameName: string, status: string) => Promise<void>
	) {
		super(app);
		this.statuses = statuses;
		this.onSubmit = onSubmit;
		this.selectedStatus = statuses[0] ?? "";
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "New game" });

		new Setting(contentEl)
			.setName("Game name")
			.addText((text) => {
				text.setPlaceholder("Enter game name");
				text.onChange((value) => {
					this.gameName = value;
				});
				text.inputEl.focus();
				text.inputEl.addEventListener("keydown", (event) => {
					if (event.key === "Enter") {
						this.submit();
					}
				});
			});

		new Setting(contentEl)
			.setName("Status")
			.addDropdown((dropdown) => {
				if (this.statuses.length === 0) {
					dropdown.addOption("", "No statuses configured");
					dropdown.setDisabled(true);
					this.selectedStatus = "";
					return;
				}
				this.statuses.forEach((status) => {
					dropdown.addOption(status, status);
				});
				if (this.selectedStatus) {
					dropdown.setValue(this.selectedStatus);
				}
				dropdown.onChange((value) => {
					this.selectedStatus = value;
				});
			});

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText("Create")
					.setCta()
					.onClick(() => this.submit())
			);
	}

	private async submit() {
		const trimmed = this.gameName.trim();
		if (!trimmed) {
			new Notice("Game name cannot be empty");
			return;
		}
		await this.onSubmit(trimmed, this.selectedStatus ?? "");
		this.close();
	}

	onClose() {
		this.contentEl.empty();
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
		const containerEl = this.containerEl;
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
