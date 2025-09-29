import {
	App,
	FuzzySuggestModal,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	TextComponent,
} from "obsidian";
import * as datefns from "date-fns";
import { extractFrontmatter, convertToMarkdown, DocumentData } from "./frontmatter";
import { fetchGameMetadata, requestIgdbAccessToken } from "./igdb";

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

type ThumbnailUpdateStatus = "updated" | "unchanged" | "skipped";

interface ThumbnailUpdateResult {
	status: ThumbnailUpdateStatus;
	reason?: string;
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

const GAMES_FOLDER = ITEM_TYPES.find(
	(item) => item.label.toLowerCase() === "game"
)	?.folder ?? "games";

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
		this.addRibbonIcon("plus-square", "Create item", () =>
			this.newItemCommand()
		);

		this.addCommand({
			id: "new_item",
			name: "New item",
			callback: () => this.newItemCommand(),
		});

		this.addCommand({
			id: "refresh-game-thumbnails",
			name: "Refresh game thumbnails",
			callback: () => this.refreshGameThumbnailsCommand(),
		});

		this.addCommand({
			id: "refresh-current-game-thumbnail",
			name: "Refresh current game thumbnail",
			callback: () => this.refreshCurrentGameThumbnailCommand(),
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

		let displayName = trimmedName;
		let thumbnail: string | null = null;
		if (itemType.folder === "games") {
			const accessToken = await this.ensureIgdbAccessToken();
			if (accessToken) {
				const metadata = await fetchGameMetadata(trimmedName, {
					clientId: this.settings.igdbClientId,
					accessToken,
				});
				if (metadata) {
					if (metadata.canonicalName) {
						const canonical = metadata.canonicalName.trim();
						if (canonical.length > 0) {
							displayName = canonical;
						}
					}
					thumbnail = metadata.thumbnail ?? null;
				}
			}
		}

		const sanitizeName = (value: string) =>
			value.trim().replace(/[\\/:<>"|?*]/g, "-");
		let sanitizedName = sanitizeName(displayName);
		if (!sanitizedName) {
			sanitizedName = sanitizeName(trimmedName);
		}

		const filePath = `${folderPath}/${sanitizedName}.md`;
		if (vault.getAbstractFileByPath(filePath)) {
			new Notice(`${itemType.label} '${displayName}' already exists`);
			return;
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
		const bodyLines = [""];
		if (thumbnail) {
			bodyLines.push(`![Cover Image](${thumbnail})`);
		}
		bodyLines.push("");
		const content = [...frontmatter, ...bodyLines].join("\n");

		const createdFile = await vault.create(filePath, content);
		const leaf =
			this.app.workspace.getLeaf(false) ?? this.app.workspace.getLeaf(true);
		if (leaf) {
			await leaf.openFile(createdFile);
		}
		new Notice(`Created ${filePath}`);
	}

	async refreshGameThumbnailsCommand(): Promise<void> {
		if (!this.settings.igdbClientId || !this.settings.igdbClientSecret) {
			new Notice(
				"Set your IGDB client credentials in the plugin settings before refreshing thumbnails."
			);
			return;
		}

		const folder = this.app.vault.getAbstractFileByPath(GAMES_FOLDER);
		if (!folder) {
			new Notice(`Folder '${GAMES_FOLDER}' does not exist.`);
			return;
		}
		if (!(folder instanceof TFolder)) {
			new Notice(`'${GAMES_FOLDER}' exists but is not a folder.`);
			return;
		}

		const files = this.collectMarkdownFiles(folder);
		if (files.length === 0) {
			new Notice(`No game notes found in '${GAMES_FOLDER}'.`);
			return;
		}

		const accessToken = await this.ensureIgdbAccessToken();
		if (!accessToken) {
			return;
		}

		let updated = 0;
		let unchanged = 0;
		let skipped = 0;

		for (const file of files) {
			try {
				const result = await this.updateGameNoteThumbnail(file, accessToken);
				switch (result.status) {
					case "updated":
						updated++;
						break;
					case "unchanged":
						unchanged++;
						break;
					case "skipped":
					default:
						skipped++;
						if (result.reason) {
							console.warn(
								`[Set Status Plugin] Thumbnail refresh skipped for '${file.path}': ${result.reason}`
							);
						}
						break;
				}
				if (result.status === "unchanged" && result.reason) {
					console.info(
						`[Set Status Plugin] Thumbnail already current for '${file.path}': ${result.reason}`
					);
				}
			} catch (error) {
				console.error(`Failed to update thumbnail for ${file.path}`, error);
				skipped++;
			}
		}

		const summaryParts = [`${updated} updated`];
		if (unchanged > 0) {
			summaryParts.push(`${unchanged} already current`);
		}
		if (skipped > 0) {
			summaryParts.push(`${skipped} skipped`);
		}

		new Notice(`Game thumbnails: ${summaryParts.join(", ")}`);
	}

	async refreshCurrentGameThumbnailCommand(): Promise<void> {
		if (!this.settings.igdbClientId || !this.settings.igdbClientSecret) {
			new Notice(
				"Set your IGDB client credentials in the plugin settings before refreshing thumbnails."
			);
			return;
		}

		const file = this.app.workspace.getActiveFile();
		if (!file || !(file instanceof TFile) || file.extension !== "md") {
			new Notice("Open a markdown game note before refreshing its thumbnail.");
			return;
		}

		const normalizedPath = file.path.replace(/\\/g, "/");
		const folderPrefix = `${GAMES_FOLDER.toLowerCase()}/`;
		if (!normalizedPath.toLowerCase().startsWith(folderPrefix)) {
			new Notice(`Active file is not inside '${GAMES_FOLDER}'.`);
			return;
		}

		const accessToken = await this.ensureIgdbAccessToken();
		if (!accessToken) {
			return;
		}

		const result = await this.updateGameNoteThumbnail(file, accessToken);
		switch (result.status) {
			case "updated":
				new Notice("Thumbnail updated from IGDB.");
				break;
			case "unchanged":
				new Notice("Thumbnail already matches the latest IGDB cover.");
				if (result.reason) {
					console.info(
						`[Set Status Plugin] Thumbnail already current for '${file.path}': ${result.reason}`
					);
				}
				break;
			default:
				new Notice("Could not update the thumbnail for this note.");
				if (result.reason) {
					console.warn(
						`[Set Status Plugin] Thumbnail refresh skipped for '${file.path}': ${result.reason}`
					);
				}
				break;
		}
	}

	private collectMarkdownFiles(folder: TFolder): TFile[] {
		const files: TFile[] = [];
		const stack: TFolder[] = [folder];
		while (stack.length > 0) {
			const current = stack.pop();
			if (!current) {
				continue;
			}
			for (const child of current.children) {
				if (child instanceof TFolder) {
					stack.push(child);
				} else if (child instanceof TFile && child.extension === "md") {
					files.push(child);
				}
			}
		}
		return files;
	}

	private resolveGameName(file: TFile): string {
		return file.basename.trim();
	}

	private upsertCoverImage(
		content: string,
		thumbnail: string
	): { text: string; changed: boolean } {
		const coverLine = `![Cover Image](${thumbnail})`;
		const normalizedOriginal = content.replace(/\r\n/g, "\n");
		const imageRegex = /!\[[^\]]*]\([^\)]+\)/g;
		const withoutImages = normalizedOriginal.replace(imageRegex, "");
		const trimmedLeading = withoutImages.replace(/^\n+/, "");
		const trimmedTrailing = trimmedLeading.replace(/\s+$/, "");
		let finalContent = coverLine;
		if (trimmedTrailing.length > 0) {
			finalContent += `\n\n${trimmedTrailing}`;
		}
		finalContent = finalContent.replace(/\n{3,}/g, "\n\n");
		if (!finalContent.endsWith("\n")) {
			finalContent += "\n";
		}
		const changed = finalContent !== normalizedOriginal;
		return { text: finalContent, changed };
	}

	private async updateGameNoteThumbnail(
		file: TFile,
		accessToken: string
	): Promise<ThumbnailUpdateResult> {
		const vault = this.app.vault;
		const raw = await vault.read(file);
		const data = extractFrontmatter(raw);
		const gameName = this.resolveGameName(file).trim();
		if (!gameName) {
			return {
				status: "skipped",
				reason: "Could not determine a game name from frontmatter, heading, or filename.",
			};
		}
		const metadata = await fetchGameMetadata(gameName, {
			clientId: this.settings.igdbClientId,
			accessToken,
		});
		if (!metadata) {
			return {
				status: "skipped",
				reason: `No IGDB result found for '${gameName}'.`,
			};
		}
		if (!metadata.thumbnail) {
			return {
				status: "skipped",
				reason: `IGDB result for '${gameName}' lacks a cover image.`,
			};
		}

		const nextThumbnail = metadata.thumbnail;
		const currentThumbnail =
			typeof data.frontmatter?.["thumbnail"] === "string"
				? data.frontmatter["thumbnail"].trim()
				: null;
		const { text: updatedContent, changed: contentChanged } =
			this.upsertCoverImage(data.content, nextThumbnail);
		const frontmatterChanged = currentThumbnail !== nextThumbnail;
		if (!frontmatterChanged && !contentChanged) {
			return {
				status: "unchanged",
				reason: "Note already references the current IGDB thumbnail.",
			};
		}
		data.frontmatter["thumbnail"] = nextThumbnail;
		data.content = updatedContent;
		const markdown = convertToMarkdown(data);
		await vault.modify(file, markdown);
		return { status: "updated" };
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
