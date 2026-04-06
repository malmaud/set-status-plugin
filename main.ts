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
import { extractFrontmatter, convertToMarkdown } from "./frontmatter";
import { fetchGameMetadata, searchGames, requestIgdbAccessToken } from "./igdb";
import { fetchBookMetadata, searchBooks } from "./openlibrary";
import { fetchTvShowMetadata, searchTvShows } from "./tmdb";
import { rerankResults, testClaudeApiKey, correctTitle } from "./rerank";

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
	tmdbApiKey: string;
	bookLanguage: string;
	claudeApiKey: string;
	claudeModel: string;
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
	tmdbApiKey: "",
	bookLanguage: "eng",
	claudeApiKey: "",
	claudeModel: "claude-haiku-4-5-20251001",
};

const ITEM_TYPES: ItemType[] = [
	{ label: "Game", folder: "games" },
	{ label: "TV Show", folder: "tv shows" },
	{ label: "Book", folder: "books" },
];

const GAMES_FOLDER = ITEM_TYPES.find(
	(item) => item.label.toLowerCase() === "game"
)	?.folder ?? "games";

const BOOKS_FOLDER = ITEM_TYPES.find(
	(item) => item.label.toLowerCase() === "book"
)	?.folder ?? "books";

const TV_SHOWS_FOLDER = ITEM_TYPES.find(
	(item) => item.label.toLowerCase() === "tv show"
)	?.folder ?? "tv shows";

const GAME_STATUSES_WITHOUT_DATE = new Set(["complete", "abandoned"]);

export default class MyPlugin extends Plugin {
	settings!: Settings;
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

		this.registerStatusCommands();

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
			id: "refresh-current-thumbnail",
			name: "Refresh current thumbnail",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				const folder = this.detectItemFolder(file);
				if (!folder) return false;
				if (!checking) {
					this.refreshCurrentThumbnailCommand();
				}
				return true;
			},
		});

		this.addCommand({
			id: "pick-thumbnail",
			name: "Pick thumbnail",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				const folder = this.detectItemFolder(file);
				if (!folder) return false;
				if (!checking) {
					this.pickThumbnailCommand();
				}
				return true;
			},
		});

		this.addCommand({
			id: "add-missing-thumbnails",
			name: "Add missing thumbnails",
			callback: () => this.addMissingThumbnailsCommand(),
		});

		this.addSettingTab(new SettingsTab(this.app, this));
	}

	private registerStatusCommands() {
		for (const statusName of this.settings.statusNames) {
			const id = `set-status-${statusName.toLowerCase().replace(/\s+/g, "-")}`;
			this.addCommand({
				id,
				name: statusName,
				checkCallback: (checking: boolean) => {
					const file = this.app.workspace.getActiveFile();
					if (!file) {
						return false;
					}
					if (!checking) {
						this.setStatus({ name: statusName });
					}
					return true;
				},
			});
		}
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
		const itemMetadata = await this.fetchMetadataForFolder(trimmedName, itemType.folder);
		if (itemMetadata) {
			if (itemMetadata.canonicalName) {
				const canonical = itemMetadata.canonicalName.trim();
				if (canonical.length > 0) {
					displayName = canonical;
				}
			}
			thumbnail = itemMetadata.thumbnail ?? null;
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

		const frontmatter = ["---", `status: ${chosenStatus}`];
		const isGame = itemType.folder === GAMES_FOLDER;
		const shouldOmitStatusDate =
			isGame && GAME_STATUSES_WITHOUT_DATE.has(chosenStatus.toLowerCase());
		if (!shouldOmitStatusDate) {
			const formattedDate = datefns.format(
				new Date(),
				this.settings.dateFormat
			);
			frontmatter.push(`status date: ${formattedDate}`);
		}
		if (thumbnail) {
			frontmatter.push(`thumbnail: ${thumbnail}`);
		}
		if (itemMetadata?.id) {
			frontmatter.push(`url: ${itemMetadata.id}`);
		}
		if (itemMetadata?.author) {
			frontmatter.push(`author: ${itemMetadata.author}`);
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

	private detectItemFolder(file: TFile): string | null {
		const normalizedPath = file.path.replace(/\\/g, "/").toLowerCase();
		for (const itemType of ITEM_TYPES) {
			if (normalizedPath.startsWith(`${itemType.folder.toLowerCase()}/`)) {
				return itemType.folder;
			}
		}
		return null;
	}

	private async searchForFolder(
		itemName: string,
		folder: string,
		author?: string,
		isRetry = false
	): Promise<{ id: string | null; thumbnail: string | null; canonicalName: string | null; author?: string | null }[]> {
		console.info(`[Set Status Plugin] searchForFolder: "${itemName}" in "${folder}"${author ? ` (author="${author}")` : ""}`);
		let results: { id: string | null; thumbnail: string | null; canonicalName: string | null; author?: string | null }[];
		if (folder === GAMES_FOLDER) {
			const accessToken = await this.ensureIgdbAccessToken();
			if (!accessToken) {
				console.warn("[Set Status Plugin] searchForFolder: no IGDB access token");
				return [];
			}
			results = await searchGames(itemName, {
				clientId: this.settings.igdbClientId,
				accessToken,
			});
		} else if (folder === BOOKS_FOLDER) {
			const lang = this.settings.bookLanguage || undefined;
			const bookQuery = author ? `${itemName} ${author}` : itemName;
			console.info(`[Set Status Plugin] searchForFolder: using book language="${lang ?? "any"}"`);
			results = await searchBooks(bookQuery, lang);
		} else if (folder === TV_SHOWS_FOLDER) {
			if (!this.settings.tmdbApiKey) {
				console.warn("[Set Status Plugin] searchForFolder: no TMDB API key");
				return [];
			}
			results = await searchTvShows(itemName, this.settings.tmdbApiKey);
		} else {
			console.warn(`[Set Status Plugin] searchForFolder: unknown folder "${folder}"`);
			return [];
		}

		if (this.settings.claudeApiKey) {
			if (results.length === 0 && !isRetry) {
				new Notice("No results — asking Claude to identify the title...");
				const mediaType = ITEM_TYPES.find((t) => t.folder === folder)?.label ?? "media";
				const corrected = await correctTitle(itemName, mediaType, this.settings.claudeApiKey, this.settings.claudeModel);
				if (corrected && corrected.toLowerCase() !== itemName.toLowerCase()) {
					new Notice(`Searching for "${corrected}"...`);
					console.info(`[Set Status Plugin] searchForFolder: retrying with corrected title "${corrected}"`);
					return this.searchForFolder(corrected, folder, author, true);
				}
			} else if (results.length > 1) {
				new Notice("Ranking results with Claude...");
				results = await rerankResults(itemName, results, this.settings.claudeApiKey, this.settings.claudeModel);
			}
		}

		return results;
	}

	private applyThumbnail(
		file: TFile,
		choice: { id: string | null; thumbnail: string | null; canonicalName: string | null; author?: string | null }
	): void {
		if (!choice.thumbnail) {
			new Notice("Selected result has no cover image.");
			return;
		}
		const vault = this.app.vault;
		vault.read(file).then((raw) => {
			const data = extractFrontmatter(raw);
			data.frontmatter["thumbnail"] = choice.thumbnail;
			if (choice.id) {
				data.frontmatter["url"] = choice.id;
			}
			if (choice.author) {
				data.frontmatter["author"] = choice.author;
			}
			const { text: updatedContent } = this.upsertCoverImage(
				data.content,
				choice.thumbnail!
			);
			data.content = updatedContent;
			const markdown = convertToMarkdown(data);
			vault.modify(file, markdown).then(() => {
				new Notice("Thumbnail updated.");
			});
		});
	}

	async pickThumbnailCommand(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || !(file instanceof TFile) || file.extension !== "md") {
			new Notice("Open a markdown note first.");
			return;
		}

		const folder = this.detectItemFolder(file);
		if (!folder) {
			new Notice("Active file is not inside a known media folder.");
			return;
		}

		const itemName = file.basename.trim();
		if (!itemName) {
			new Notice("Could not determine item name from filename.");
			return;
		}

		let author: string | undefined;
		if (folder === BOOKS_FOLDER) {
			const raw = await this.app.vault.read(file);
			const data = extractFrontmatter(raw);
			const val = data.frontmatter?.["author"];
			if (typeof val === "string" && val.trim()) {
				author = val.trim();
			}
		}

		console.info(`[Set Status Plugin] pickThumbnail: "${itemName}" in "${folder}"`);
		const searchNotice = new Notice(`Searching for "${itemName}"...`, 0);
		try {
			const results = await this.searchForFolder(itemName, folder, author);
			searchNotice.hide();
			console.info(`[Set Status Plugin] pickThumbnail: got ${results.length} results`);
			if (results.length === 0) {
				new Notice(`No results found for "${itemName}".`);
				return;
			}

			const withCovers = results.filter((r) => r.thumbnail);
			console.info(`[Set Status Plugin] pickThumbnail: ${withCovers.length} results have covers`);
			if (withCovers.length === 0) {
				new Notice("Results found but none have cover images.");
				return;
			}

			new ThumbnailPickerModal(
				this.app,
				withCovers,
				(choice) => this.applyThumbnail(file, choice)
			).open();
		} catch (error) {
			searchNotice.hide();
			console.error("[Set Status Plugin] pickThumbnail failed:", error);
			new Notice("Failed to search for thumbnails. Check the console for details.");
		}
	}

	async refreshCurrentThumbnailCommand(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || !(file instanceof TFile) || file.extension !== "md") {
			new Notice("Open a markdown note before refreshing its thumbnail.");
			return;
		}

		const folder = this.detectItemFolder(file);
		if (!folder) {
			new Notice("Active file is not inside a known media folder.");
			return;
		}

		const result = await this.updateNoteThumbnail(file, folder);
		switch (result.status) {
			case "updated":
				new Notice("Thumbnail updated.");
				break;
			case "unchanged":
				new Notice("Thumbnail already matches the latest cover.");
				break;
			default:
				new Notice("Could not update the thumbnail for this note.");
				if (result.reason) {
					console.warn(`[Set Status Plugin] Thumbnail refresh skipped for '${file.path}': ${result.reason}`);
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

	private upsertCoverImage(
		content: string,
		thumbnail: string
	): { text: string; changed: boolean } {
		const coverLine = `![Cover Image](${thumbnail})`;
		const normalizedOriginal = content.replace(/\r\n/g, "\n");
		const imageRegex = /!\[[^\]]*]\([^)]+\)/g;
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

	private async fetchMetadataForFolder(
		itemName: string,
		folder: string,
		author?: string
	): Promise<{ id: string | null; thumbnail: string | null; canonicalName: string | null; author?: string | null } | null> {
		if (folder === GAMES_FOLDER) {
			const accessToken = await this.ensureIgdbAccessToken();
			if (!accessToken) return null;
			return fetchGameMetadata(itemName, {
				clientId: this.settings.igdbClientId,
				accessToken,
			});
		}
		if (folder === BOOKS_FOLDER) {
			const bookQuery = author ? `${itemName} ${author}` : itemName;
			return fetchBookMetadata(bookQuery, this.settings.bookLanguage || undefined);
		}
		if (folder === TV_SHOWS_FOLDER) {
			if (!this.settings.tmdbApiKey) return null;
			const result = await fetchTvShowMetadata(itemName, this.settings.tmdbApiKey);
			if (result) return result;

			if (this.settings.claudeApiKey) {
				const corrected = await correctTitle(itemName, "TV Show", this.settings.claudeApiKey, this.settings.claudeModel);
				if (corrected && corrected.toLowerCase() !== itemName.toLowerCase()) {
					console.info(`[Set Status Plugin] fetchMetadataForFolder: retrying with corrected title "${corrected}"`);
					return fetchTvShowMetadata(corrected, this.settings.tmdbApiKey);
				}
			}
			return null;
		}
		return null;
	}

	private async updateNoteThumbnail(
		file: TFile,
		folder: string
	): Promise<ThumbnailUpdateResult> {
		const vault = this.app.vault;
		const raw = await vault.read(file);
		const data = extractFrontmatter(raw);
		const itemName = file.basename.trim();
		if (!itemName) {
			return { status: "skipped", reason: "Could not determine item name from filename." };
		}

		let existingAuthor: string | undefined;
		if (folder === BOOKS_FOLDER) {
			const val = data.frontmatter?.["author"];
			if (typeof val === "string" && val.trim()) {
				existingAuthor = val.trim();
			}
		}

		const metadata = await this.fetchMetadataForFolder(itemName, folder, existingAuthor);
		if (!metadata) {
			return { status: "skipped", reason: `No result found for '${itemName}'.` };
		}
		if (!metadata.thumbnail) {
			return { status: "skipped", reason: `Result for '${itemName}' lacks a cover image.` };
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
			return { status: "unchanged", reason: "Note already references the current thumbnail." };
		}
		data.frontmatter["thumbnail"] = nextThumbnail;
		if (metadata.id) {
			data.frontmatter["url"] = metadata.id;
		}
		if (metadata.author) {
			data.frontmatter["author"] = metadata.author;
		}
		data.content = updatedContent;
		const markdown = convertToMarkdown(data);
		await vault.modify(file, markdown);
		return { status: "updated" };
	}

	private async fileHasThumbnail(file: TFile): Promise<boolean> {
		const raw = await this.app.vault.read(file);
		const data = extractFrontmatter(raw);
		return typeof data.frontmatter?.["thumbnail"] === "string" &&
			data.frontmatter["thumbnail"].trim().length > 0;
	}

	async addMissingThumbnailsCommand(): Promise<void> {
		const folders: { folder: string; label: string }[] = [
			{ folder: GAMES_FOLDER, label: "game" },
			{ folder: BOOKS_FOLDER, label: "book" },
			{ folder: TV_SHOWS_FOLDER, label: "tv show" },
		];

		let totalUpdated = 0;
		let totalSkipped = 0;
		let totalAlreadyHad = 0;

		for (const { folder, label } of folders) {
			// Check credentials before processing
			if (folder === GAMES_FOLDER && (!this.settings.igdbClientId || !this.settings.igdbClientSecret)) {
				console.info(`[Set Status Plugin] Skipping ${label}s — IGDB credentials not configured.`);
				continue;
			}
			if (folder === TV_SHOWS_FOLDER && !this.settings.tmdbApiKey) {
				console.info(`[Set Status Plugin] Skipping ${label}s — TMDB API key not configured.`);
				continue;
			}

			const folderObj = this.app.vault.getAbstractFileByPath(folder);
			if (!folderObj || !(folderObj instanceof TFolder)) {
				continue;
			}

			const files = this.collectMarkdownFiles(folderObj);
			for (const file of files) {
				try {
					if (await this.fileHasThumbnail(file)) {
						totalAlreadyHad++;
						continue;
					}

					const result = await this.updateNoteThumbnail(file, folder);

					switch (result.status) {
						case "updated": totalUpdated++; break;
						case "unchanged": totalAlreadyHad++; break;
						default:
							totalSkipped++;
							if (result.reason) {
								console.warn(`[Set Status Plugin] Skipped '${file.path}': ${result.reason}`);
							}
							break;
					}
				} catch (error) {
					console.error(`Failed to add thumbnail for ${file.path}`, error);
					totalSkipped++;
				}
			}
		}

		const parts = [`${totalUpdated} added`];
		if (totalAlreadyHad > 0) parts.push(`${totalAlreadyHad} already had one`);
		if (totalSkipped > 0) parts.push(`${totalSkipped} skipped`);
		new Notice(`Missing thumbnails: ${parts.join(", ")}`);
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

interface ThumbnailChoice {
	id: string | null;
	thumbnail: string | null;
	canonicalName: string | null;
	author?: string | null;
}

class ThumbnailPickerModal extends Modal {
	private results: ThumbnailChoice[];
	private onPick: (choice: ThumbnailChoice) => void;

	constructor(
		app: App,
		results: ThumbnailChoice[],
		onPick: (choice: ThumbnailChoice) => void
	) {
		super(app);
		this.results = results;
		this.onPick = onPick;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Pick a thumbnail" });

		const grid = contentEl.createDiv({ cls: "thumbnail-picker-grid" });
		grid.style.display = "grid";
		grid.style.gridTemplateColumns = "repeat(auto-fill, minmax(140px, 1fr))";
		grid.style.gap = "12px";
		grid.style.marginTop = "12px";

		for (const result of this.results) {
			const card = grid.createDiv({ cls: "thumbnail-picker-card" });
			card.style.cursor = "pointer";
			card.style.textAlign = "center";
			card.style.padding = "8px";
			card.style.borderRadius = "6px";
			card.style.border = "1px solid var(--background-modifier-border)";

			if (result.thumbnail) {
				const img = card.createEl("img", { attr: { src: result.thumbnail } });
				img.style.width = "100%";
				img.style.height = "auto";
				img.style.borderRadius = "4px";
				img.style.marginBottom = "6px";
			}

			if (result.canonicalName) {
				const label = card.createEl("div", { text: result.canonicalName });
				label.style.fontSize = "0.85em";
				label.style.color = "var(--text-muted)";
				label.style.overflow = "hidden";
				label.style.textOverflow = "ellipsis";
				label.style.whiteSpace = "nowrap";
			}

			card.addEventListener("mouseenter", () => {
				card.style.border = "1px solid var(--interactive-accent)";
			});
			card.addEventListener("mouseleave", () => {
				card.style.border = "1px solid var(--background-modifier-border)";
			});
			card.addEventListener("click", () => {
				this.onPick(result);
				this.close();
			});
		}
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

	getTmdbApiKey(): string {
		return this.plugin.settings.tmdbApiKey;
	}

	async setTmdbApiKey(value: string): Promise<void> {
		this.plugin.settings.tmdbApiKey = value.trim();
		await this.plugin.saveSettings();
	}

	private createStatusIndicator(containerEl: HTMLElement): HTMLElement {
		const indicator = containerEl.createSpan({ cls: "setting-status-indicator" });
		indicator.style.marginLeft = "8px";
		indicator.style.fontSize = "0.85em";
		return indicator;
	}

	private setIndicator(el: HTMLElement, state: "configured" | "not-configured" | "valid" | "invalid" | "checking") {
		switch (state) {
			case "configured":
				el.setText("Configured");
				el.style.color = "var(--text-muted)";
				break;
			case "not-configured":
				el.setText("Not configured");
				el.style.color = "var(--text-faint)";
				break;
			case "valid":
				el.setText("Valid");
				el.style.color = "var(--color-green)";
				break;
			case "invalid":
				el.setText("Invalid");
				el.style.color = "var(--color-red)";
				break;
			case "checking":
				el.setText("Checking...");
				el.style.color = "var(--text-muted)";
				break;
		}
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

		// --- IGDB ---
		const igdbHeading = new Setting(containerEl)
			.setHeading()
			.setName("IGDB API (Games)");
		const igdbIndicator = this.createStatusIndicator(igdbHeading.nameEl);
		this.setIndicator(igdbIndicator,
			this.getIgdbClientId() && this.getIgdbClientSecret() ? "configured" : "not-configured"
		);

		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("Required to look up covers via the IGDB API.")
			.addText((text) => {
				text.setPlaceholder("Enter IGDB client ID")
					.setValue(this.getIgdbClientId())
					.onChange(async (value) => {
						await this.setIgdbClientId(value);
						this.setIndicator(igdbIndicator,
							value.trim() && this.getIgdbClientSecret() ? "configured" : "not-configured"
						);
					});
			});
		new Setting(containerEl)
			.setName("Client secret")
			.setDesc("Used to request short-lived IGDB tokens as needed.")
			.addText((text) => {
				text.setPlaceholder("Enter IGDB client secret")
					.setValue(this.getIgdbClientSecret())
					.onChange(async (value) => {
						await this.setIgdbClientSecret(value);
						this.setIndicator(igdbIndicator,
							this.getIgdbClientId() && value.trim() ? "configured" : "not-configured"
						);
					});
				text.inputEl.type = "password";
			});
		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verify your IGDB credentials by requesting an access token.")
			.addButton((button) => {
				button.setButtonText("Test").onClick(async () => {
					const clientId = this.getIgdbClientId();
					const clientSecret = this.getIgdbClientSecret();
					if (!clientId || !clientSecret) {
						this.setIndicator(igdbIndicator, "not-configured");
						new Notice("Enter both Client ID and Client secret first.");
						return;
					}
					this.setIndicator(igdbIndicator, "checking");
					const token = await requestIgdbAccessToken(clientId, clientSecret);
					if (token) {
						this.setIndicator(igdbIndicator, "valid");
						new Notice("IGDB credentials are valid.");
					} else {
						this.setIndicator(igdbIndicator, "invalid");
						new Notice("IGDB credentials are invalid. Check your Client ID and secret.");
					}
				});
			});

		// --- TMDB ---
		const tmdbHeading = new Setting(containerEl)
			.setHeading()
			.setName("TMDB API (TV Shows)");
		const tmdbIndicator = this.createStatusIndicator(tmdbHeading.nameEl);
		this.setIndicator(tmdbIndicator,
			this.getTmdbApiKey() ? "configured" : "not-configured"
		);

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Required to look up TV show posters via TMDB. Get a free key at themoviedb.org.")
			.addText((text) => {
				text.setPlaceholder("Enter TMDB API key")
					.setValue(this.getTmdbApiKey())
					.onChange(async (value) => {
						await this.setTmdbApiKey(value);
						this.setIndicator(tmdbIndicator,
							value.trim() ? "configured" : "not-configured"
						);
					});
				text.inputEl.type = "password";
			});
		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verify your TMDB API key with a test query.")
			.addButton((button) => {
				button.setButtonText("Test").onClick(async () => {
					const apiKey = this.getTmdbApiKey();
					if (!apiKey) {
						this.setIndicator(tmdbIndicator, "not-configured");
						new Notice("Enter a TMDB API key first.");
						return;
					}
					this.setIndicator(tmdbIndicator, "checking");
					const result = await fetchTvShowMetadata("Breaking Bad", apiKey);
					if (result) {
						this.setIndicator(tmdbIndicator, "valid");
						new Notice("TMDB API key is valid.");
					} else {
						this.setIndicator(tmdbIndicator, "invalid");
						new Notice("TMDB API key appears invalid. Check it and try again.");
					}
				});
			});

		// --- Open Library ---
		const olHeading = new Setting(containerEl)
			.setHeading()
			.setName("Open Library (Books)");
		const olIndicator = this.createStatusIndicator(olHeading.nameEl);
		this.setIndicator(olIndicator, "valid");

		new Setting(containerEl)
			.setDesc("Open Library requires no API key. Book cover lookups are always available.");

		new Setting(containerEl)
			.setName("Language")
			.setDesc("3-letter ISO 639-2 code (e.g. eng, fra, deu, spa, jpn). Leave empty for all languages.")
			.addText((text) => {
				text.setPlaceholder("eng")
					.setValue(this.plugin.settings.bookLanguage)
					.onChange(async (value) => {
						this.plugin.settings.bookLanguage = value.trim().toLowerCase();
						await this.plugin.saveSettings();
					});
			});

		// --- Claude AI (Optional) ---
		const claudeHeading = new Setting(containerEl)
			.setHeading()
			.setName("Claude AI (Optional)");
		const claudeIndicator = this.createStatusIndicator(claudeHeading.nameEl);
		this.setIndicator(claudeIndicator,
			this.plugin.settings.claudeApiKey ? "configured" : "not-configured"
		);

		new Setting(containerEl)
			.setDesc("Provide a Claude API key to use AI-powered reranking of search results when picking thumbnails.");

		new Setting(containerEl)
			.setName("API Key")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder("sk-ant-...")
					.setValue(this.plugin.settings.claudeApiKey)
					.onChange(async (value) => {
						this.plugin.settings.claudeApiKey = value.trim();
						await this.plugin.saveSettings();
						this.setIndicator(claudeIndicator,
							value.trim() ? "configured" : "not-configured"
						);
					});
			});

		new Setting(containerEl)
			.setName("Model")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("claude-haiku-4-5-20251001", "Haiku 4.5 (fastest, cheapest)")
					.addOption("claude-sonnet-4-6", "Sonnet 4.6")
					.addOption("claude-opus-4-6", "Opus 4.6 (smartest)")
					.setValue(this.plugin.settings.claudeModel)
					.onChange(async (value) => {
						this.plugin.settings.claudeModel = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verify your Claude API key by sending a test request.")
			.addButton((button) => {
				button.setButtonText("Test").onClick(async () => {
					const key = this.plugin.settings.claudeApiKey;
					if (!key) {
						this.setIndicator(claudeIndicator, "not-configured");
						new Notice("Enter a Claude API key first.");
						return;
					}
					this.setIndicator(claudeIndicator, "checking");
					const result = await testClaudeApiKey(key, this.plugin.settings.claudeModel);
					if (result.ok) {
						this.setIndicator(claudeIndicator, "valid");
						new Notice("Claude API key is valid.");
					} else {
						this.setIndicator(claudeIndicator, "invalid");
						new Notice(`Claude API key test failed: ${result.error ?? "Unknown error"}`);
					}
				});
			});
	}
}
