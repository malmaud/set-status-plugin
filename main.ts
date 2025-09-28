import {
	App,
	FuzzySuggestModal,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFolder,
	TextComponent,
} from "obsidian";
import * as datefns from "date-fns";
import { extractFrontmatter, convertToMarkdown } from "./frontmatter";
import { fetchGameThumbnail, requestIgdbAccessToken } from "./igdb";

interface Status {
	name: string;
}

interface ItemType {
	label: string;
	folder: string;
}

interface Settings {
	statusNames: string[];
	dateFormat: string;
	igdbClientId: string;
	igdbClientSecret: string;
}

const DEFAULT_SETTINGS: Settings = {
	statusNames: ["complete", "abandoned", "backlog", "on radar", "in progress"],
	dateFormat: "yyyy-MM-dd",
	igdbClientId: "",
	igdbClientSecret: "",
};

const ITEM_TYPES: ItemType[] = [
	{ label: "Game", folder: "games" },
	{ label: "TV Show", folder: "tv shows" },
	{ label: "Book", folder: "books" },
];

export default class MyPlugin extends Plugin {
	settings: Settings;
	private igdbToken: { value: string; expiresAt: number } | null = null;

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
			id: "new_item",
			name: "New item",
			callback: () => this.newItemCommand(),
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

	newItemCommand() {
		const statusOptions = this.settings.statusNames;
		new ItemModal(
			this.app,
			statusOptions,
			ITEM_TYPES,
			this.createItemFile.bind(this)
		).open();
}

	async createItemFile(
		itemName: string,
		status: string,
		itemType: ItemType
	): Promise<void> {
		const vault = this.app.vault;
		const trimmedName = itemName.trim();
		const folderPath = itemType.folder;
		const sanitizedName = trimmedName.replace(/[\\/:<>"|?*]/g, "-");

		if (!trimmedName) {
			new Notice(`${itemType.label} name cannot be empty`);
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
			new Notice(`'${folderPath}' exists but is not a folder`);
			return;
		}

		const filePath = `${folderPath}/${sanitizedName}.md`;
		if (vault.getAbstractFileByPath(filePath)) {
			new Notice(`${itemType.label} '${sanitizedName}' already exists`);
			return;
		}

		let thumbnail: string | null = null;
		if (itemType.folder === "games") {
			const accessToken = await this.ensureIgdbAccessToken();
			if (accessToken) {
				thumbnail = await fetchGameThumbnail(trimmedName, {
					clientId: this.settings.igdbClientId,
					accessToken,
				});
			}
		}

		const formattedDate = datefns.format(new Date(), this.settings.dateFormat);
		const frontmatter = [
			"---",
			`status: ${chosenStatus}`,
			`status date: ${formattedDate}`,
		];
		if (thumbnail) {
			frontmatter.push(`thumbnail: ${thumbnail}`);
		}
		frontmatter.push("---");
		const bodyLines = thumbnail
			? ["", `![Cover Image](${thumbnail})`, ""]
			: ["", ""];
		const content = [...frontmatter, ...bodyLines].join("\n");

		const createdFile = await vault.create(filePath, content);
		const leaf =
			this.app.workspace.getLeaf(false) ?? this.app.workspace.getLeaf(true);
		if (leaf) {
			await leaf.openFile(createdFile);
		}
		new Notice(`Created ${filePath}`);
	}

	private async ensureIgdbAccessToken(): Promise<string | null> {
		const { igdbClientId, igdbClientSecret } = this.settings;
		if (!igdbClientId || !igdbClientSecret) {
			return null;
		}
		const now = Date.now();
		if (this.igdbToken && this.igdbToken.expiresAt > now + 60_000) {
			return this.igdbToken.value;
		}
		const token = await requestIgdbAccessToken(
			igdbClientId,
			igdbClientSecret
		);
		if (!token) {
			new Notice("Could not reach IGDB – check your client credentials.");
			return null;
		}
		const expiresAt = now + Math.max(0, token.expiresIn - 60) * 1000;
		this.igdbToken = {
			value: token.accessToken,
			expiresAt,
		};
		return this.igdbToken.value;
	}

	clearIgdbTokenCache(): void {
		this.igdbToken = null;
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


class ItemModal extends Modal {
	onSubmit: (itemName: string, status: string, itemType: ItemType) => Promise<void>;
	private readonly statuses: string[];
	private readonly itemTypes: ItemType[];
	private itemName = "";
	private selectedStatus: string;
	private statusInput: TextComponent | null = null;
	private selectedItemType: ItemType;

	constructor(
		app: App,
		statuses: string[],
		itemTypes: ItemType[],
		onSubmit: (itemName: string, status: string, itemType: ItemType) => Promise<void>
	) {
		super(app);
		this.statuses = statuses;
		this.itemTypes = itemTypes;
		this.onSubmit = onSubmit;
		const defaultStatus = statuses.find(
			(status) => status.toLowerCase() === "on radar"
		);
		this.selectedStatus = defaultStatus ?? statuses[0] ?? "on radar";
		this.selectedItemType = itemTypes[0] ?? { label: "Item", folder: "" };
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "New item" });

		new Setting(contentEl)
			.setName("Type")
			.addDropdown((dropdown) => {
				if (this.itemTypes.length === 0) {
					dropdown.addOption("", "No item types configured");
					dropdown.setDisabled(true);
					this.selectedItemType = { label: "Item", folder: "" };
					return;
				}
				this.itemTypes.forEach((type) => {
					dropdown.addOption(type.folder, type.label);
				});
				dropdown.setValue(this.selectedItemType.folder);
				dropdown.onChange((value) => {
					const match = this.itemTypes.find((type) => type.folder === value);
					if (match) {
						this.selectedItemType = match;
					}
				});
			});

		new Setting(contentEl)
			.setName("Item name")
			.addText((text) => {
				text.setPlaceholder("Enter item name");
				text.onChange((value) => {
					this.itemName = value;
				});
				text.inputEl.focus();
				text.inputEl.addEventListener("keydown", (event) => {
					if (event.key === "Enter") {
						this.submit();
					}
				});
			});

		const statusSetting = new Setting(contentEl)
			.setName("Status")
			.setDesc(
				"Type to set a status, or press Arrow Down / use the search button to pick from configured options."
			);
		statusSetting.addText((text) => {
			text.setPlaceholder("Enter status");
			if (this.selectedStatus) {
				text.setValue(this.selectedStatus);
			}
			this.statusInput = text;
			text.onChange((value) => {
				this.selectedStatus = value;
			});
			text.inputEl.addEventListener("keydown", (event) => {
				if (event.key === "ArrowDown") {
					event.preventDefault();
					this.openStatusSuggest();
				}
			});
		});
		statusSetting.addExtraButton((button) => {
			button.setIcon("search");
			button.setTooltip("Browse statuses");
			button.onClick(() => this.openStatusSuggest());
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
		const trimmed = this.itemName.trim();
		if (!trimmed) {
			new Notice("Item name cannot be empty");
			return;
		}
		if (!this.selectedItemType.folder) {
			new Notice("Please choose an item type");
			return;
		}
		await this.onSubmit(
			trimmed,
			this.selectedStatus ?? "",
			this.selectedItemType
		);
		this.close();
	}

	private openStatusSuggest(): void {
		if (this.statuses.length === 0) {
			new Notice("No statuses configured");
			return;
		}
		const modal = new StatusSuggestModal(
			this.app,
			this.statuses,
			(status) => {
				this.selectedStatus = status;
				this.statusInput?.setValue(status);
				this.statusInput?.inputEl.focus();
			},
			this.statusInput?.getValue() ?? ""
		);
		modal.open();
	}

	onClose() {
		this.contentEl.empty();
	}
}

class StatusSuggestModal extends FuzzySuggestModal<string> {
	constructor(
		app: App,
		private readonly statuses: string[],
		private readonly onSelect: (status: string) => void,
		private readonly initialQuery: string
	) {
		super(app);
	}

	getItems(): string[] {
		return this.statuses;
	}

	getItemText(status: string): string {
		return status;
	}

	onChooseItem(status: string, evt: MouseEvent | KeyboardEvent) {
		this.onSelect(status);
	}

	onOpen() {
		super.onOpen();
		if (this.initialQuery) {
			this.inputEl.value = this.initialQuery;
			this.inputEl.dispatchEvent(new Event("input"));
			this.inputEl.select();
		}
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

	getIgdbClientId(): string {
		return this.plugin.settings.igdbClientId;
	}

	async setIgdbClientId(value: string): Promise<void> {
		this.plugin.settings.igdbClientId = value.trim();
		await this.plugin.saveSettings();
		this.plugin.clearIgdbTokenCache();
	}

	getIgdbClientSecret(): string {
		return this.plugin.settings.igdbClientSecret;
	}

	async setIgdbClientSecret(value: string): Promise<void> {
		this.plugin.settings.igdbClientSecret = value.trim();
		await this.plugin.saveSettings();
		this.plugin.clearIgdbTokenCache();
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
		new Setting(containerEl)
			.setHeading()
			.setName("IGDB API");
		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("Required to look up covers via the IGDB API.")
			.addText((text) => {
				text.setPlaceholder("Enter IGDB client ID")
					.setValue(this.getIgdbClientId())
					.onChange(async (value) => {
						await this.setIgdbClientId(value);
					});
			});
		new Setting(containerEl)
			.setName("Client secret")
			.setDesc("Stored securely in your vault and used to request short-lived IGDB tokens as needed.")
			.addText((text) => {
				text.setPlaceholder("Enter IGDB client secret")
					.setValue(this.getIgdbClientSecret())
					.onChange(async (value) => {
						await this.setIgdbClientSecret(value);
					});
				text.inputEl.type = "password";
			});
	}
}
