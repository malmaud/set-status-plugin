import {
	App,
	FuzzySuggestModal,
	MarkdownView,
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
import { upsertCoverImage } from "./cover";
import { searchGames, fetchGameById, requestIgdbAccessToken } from "./igdb";
import { searchBooks, fetchBookByKey } from "./openlibrary";
import { searchTvShows, fetchTvShowById } from "./tmdb";
import { rerankResults, testClaudeApiKey, correctTitle } from "./rerank";

interface Status {
	name: string;
}

type MediaSource = "igdb" | "openlibrary" | "tmdb";

interface ItemType {
	label: string;
	folder: string;
	source: MediaSource;
}

interface ItemMetadata {
	/** Human-facing URL for the entity. */
	id: string | null;
	/** Provider-native id, used to re-fetch this exact entity later. */
	sourceId: string | null;
	source: MediaSource | null;
	thumbnail: string | null;
	canonicalName: string | null;
	author?: string | null;
}

interface ItemMatch {
	itemType: ItemType;
	metadata: ItemMetadata;
	score: number;
	/** Title-only similarity in 0..1, used for the auto-accept gate. */
	confidence: number;
}

type MatchResolution =
	| { type: "match"; match: ItemMatch }
	| { type: "plain"; itemType: ItemType }
	| { type: "cancel" };

interface SearchOptions {
	/** Ask Claude to reorder this provider's results. */
	rerank?: boolean;
	/** Ask Claude for a corrected title when the provider returns nothing. */
	correctOnEmpty?: boolean;
	isRetry?: boolean;
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
	claudeWebSearch: boolean;
	alwaysConfirmMatch: boolean;
}

type ThumbnailUpdateStatus = "updated" | "unchanged" | "skipped";

interface ThumbnailUpdateResult {
	status: ThumbnailUpdateStatus;
	reason?: string;
}

const DEFAULT_SETTINGS: Settings = {
	statusNames: ["active", "on radar", "backlog", "complete", "abandoned", "endless"],
	dateFormat: "yyyy-MM-dd",
	igdbClientId: "",
	igdbClientSecret: "",
	tmdbApiKey: "",
	bookLanguage: "eng",
	claudeApiKey: "",
	claudeModel: "claude-haiku-4-5-20251001",
	claudeWebSearch: false,
	alwaysConfirmMatch: false,
};

const PREFERRED_STATUS_ORDER = ["active", "on radar", "backlog"];

const ITEM_TYPES: ItemType[] = [
	{ label: "Game", folder: "games", source: "igdb" },
	{ label: "Movie / TV Show", folder: "tv shows", source: "tmdb" },
	{ label: "Book", folder: "books", source: "openlibrary" },
];

/** Candidates kept per provider before the cross-type rerank. */
const CANDIDATES_PER_SOURCE = 5;
/** Below this title similarity, always ask the user to confirm. */
const AUTO_ACCEPT_CONFIDENCE = 0.95;
/** The runner-up must be at least this far behind to auto-accept. */
const AUTO_ACCEPT_MARGIN = 0.15;

const FM_SOURCE = "source";
const FM_SOURCE_ID = "source id";

const GAMES_FOLDER = ITEM_TYPES.find(
	(item) => item.label.toLowerCase() === "game"
)	?.folder ?? "games";

const BOOKS_FOLDER = ITEM_TYPES.find(
	(item) => item.label.toLowerCase() === "book"
)	?.folder ?? "books";

const TV_SHOWS_FOLDER = ITEM_TYPES.find(
	(item) => item.folder.toLowerCase() === "tv shows"
)	?.folder ?? "tv shows";

const GAME_STATUSES_WITHOUT_DATE = new Set(["complete", "abandoned"]);

function readStringField(
	frontmatter: Record<string, unknown> | undefined,
	key: string
): string | null {
	const value = frontmatter?.[key];
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function orderStatusesForPicking(statuses: string[]): string[] {
	return [...statuses].sort((a, b) => {
		const aIndex = PREFERRED_STATUS_ORDER.indexOf(a.toLowerCase());
		const bIndex = PREFERRED_STATUS_ORDER.indexOf(b.toLowerCase());
		const aRank = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex;
		const bRank = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex;
		if (aRank !== bRank) {
			return aRank - bRank;
		}
		return statuses.indexOf(a) - statuses.indexOf(b);
	});
}

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
		const statusChoices = orderStatusesForPicking(this.settings.statusNames).map((name) => {
			return { name };
		});
		new ChoiceModal(
			this.app,
			this.setStatus.bind(this),
			statusChoices
		).open();
	}

	newItemCommand() {
		const statusOptions = orderStatusesForPicking(this.settings.statusNames);
		new ItemModal(
			this.app,
			statusOptions,
			this.createItemFile.bind(this)
		).open();
}

	async createItemFile(
		itemName: string,
		status: string
	): Promise<void> {
		const trimmedName = itemName.trim();
		if (!trimmedName) {
			new Notice("Item name cannot be empty");
			return;
		}

		const chosenStatus = status.trim();
		if (!chosenStatus) {
			new Notice("Please select a status");
			return;
		}

		const searchNotice = new Notice(`Finding best match for "${trimmedName}"...`, 0);
		let candidates: ItemMatch[] = [];
		try {
			candidates = await this.gatherCandidates(trimmedName);
		} catch (error) {
			console.error(`[Set Status Plugin] Match search failed for "${trimmedName}":`, error);
			new Notice("Search failed. You can still pick manually or create without metadata.");
		} finally {
			searchNotice.hide();
		}

		const best = candidates[0];
		if (
			best &&
			!this.settings.alwaysConfirmMatch &&
			this.isConfidentMatch(candidates)
		) {
			console.info(
				`[Set Status Plugin] Auto-accepted ${best.itemType.label} match for "${trimmedName}": ` +
				`"${best.metadata.canonicalName ?? "Unknown"}" (confidence ${best.confidence.toFixed(2)})`
			);
			await this.writeItemFile(trimmedName, chosenStatus, best.itemType, best.metadata);
			return;
		}

		const resolution = await this.confirmMatch(trimmedName, candidates);
		if (resolution.type === "cancel") {
			return;
		}
		if (resolution.type === "plain") {
			await this.writeItemFile(trimmedName, chosenStatus, resolution.itemType, null);
			return;
		}
		await this.writeItemFile(
			trimmedName,
			chosenStatus,
			resolution.match.itemType,
			resolution.match.metadata
		);
	}

	private confirmMatch(
		query: string,
		candidates: ItemMatch[]
	): Promise<MatchResolution> {
		return new Promise((resolve) => {
			new MatchPickerModal(
				this.app,
				query,
				candidates,
				(nextQuery) => this.gatherCandidates(nextQuery),
				resolve
			).open();
		});
	}

	private async writeItemFile(
		fallbackName: string,
		chosenStatus: string,
		itemType: ItemType,
		metadata: ItemMetadata | null
	): Promise<void> {
		const vault = this.app.vault;
		const folderPath = itemType.folder;
		const folder = vault.getAbstractFileByPath(folderPath);
		if (!folder) {
			await vault.createFolder(folderPath);
		} else if (!(folder instanceof TFolder)) {
			new Notice(`'${folderPath}' exists but is not a folder`);
			return;
		}

		const canonical = metadata?.canonicalName?.trim();
		const displayName = canonical && canonical.length > 0 ? canonical : fallbackName;
		const thumbnail = metadata?.thumbnail ?? null;

		const sanitizeName = (value: string) =>
			value.trim().replace(/[\\/:<>"|?*]/g, "-");
		let sanitizedName = sanitizeName(displayName);
		if (!sanitizedName) {
			sanitizedName = sanitizeName(fallbackName);
		}

		const filePath = `${folderPath}/${sanitizedName}.md`;
		if (vault.getAbstractFileByPath(filePath)) {
			new Notice(`${itemType.label} '${displayName}' already exists`);
			return;
		}

		const frontmatter: Record<string, unknown> = { status: chosenStatus };
		const isGame = itemType.folder === GAMES_FOLDER;
		const shouldOmitStatusDate =
			isGame && GAME_STATUSES_WITHOUT_DATE.has(chosenStatus.toLowerCase());
		if (!shouldOmitStatusDate) {
			frontmatter["status date"] = datefns.format(
				new Date(),
				this.settings.dateFormat
			);
		}
		if (thumbnail) {
			frontmatter["thumbnail"] = thumbnail;
		}
		if (metadata?.id) {
			frontmatter["url"] = metadata.id;
		}
		if (metadata?.source) {
			frontmatter[FM_SOURCE] = metadata.source;
		}
		if (metadata?.sourceId) {
			frontmatter[FM_SOURCE_ID] = metadata.sourceId;
		}
		if (metadata?.author) {
			frontmatter["author"] = metadata.author;
		}

		// Build through the YAML serializer so titles containing ':', '[' or '#'
		// can't produce broken frontmatter.
		const content = convertToMarkdown({
			frontmatter,
			content: thumbnail ? `![Cover Image](${thumbnail})\n` : "",
		});

		const createdFile = await vault.create(filePath, content);
		const leaf =
			this.app.workspace.getLeaf(false) ?? this.app.workspace.getLeaf(true);
		if (leaf) {
			await leaf.openFile(createdFile);
			const view = leaf.view;
			if (view instanceof MarkdownView) {
				const lines = content.split("\n");
				const closingDelimiter = lines.indexOf("---", 1);
				const cursorLine =
					closingDelimiter === -1
						? lines.length - 1
						: closingDelimiter + (thumbnail ? 3 : 1);
				view.editor.setCursor({ line: cursorLine, ch: 0 });
				view.editor.focus();
			}
		}
		new Notice(`Created ${filePath}`);
	}

	/**
	 * Search every provider, keep the best few from each, and rank the merged
	 * pool once. This is the same pipeline the thumbnail picker uses, so a bad
	 * top-1 from any single provider no longer decides the match on its own.
	 */
	private async gatherCandidates(itemName: string): Promise<ItemMatch[]> {
		let query = itemName;
		let matches = await this.searchAllSources(query);

		// Nothing anywhere: ask Claude once for a corrected title, rather than
		// once per provider for the same question, then retry across all three.
		if (matches.length === 0 && this.settings.claudeApiKey) {
			new Notice("No results — asking Claude to identify the title...");
			const corrected = await correctTitle(
				itemName,
				"movie, TV show, book or video game",
				this.settings.claudeApiKey,
				this.settings.claudeModel,
				this.settings.claudeWebSearch
			);
			if (corrected && corrected.toLowerCase() !== itemName.toLowerCase()) {
				new Notice(`Searching for "${corrected}"...`);
				console.info(`[Set Status Plugin] gatherCandidates: retrying with corrected title "${corrected}"`);
				query = corrected;
				matches = await this.searchAllSources(query);
			}
		}

		if (matches.length === 0) {
			return [];
		}

		matches.sort((a, b) => {
			if (b.score !== a.score) {
				return b.score - a.score;
			}
			return ITEM_TYPES.indexOf(a.itemType) - ITEM_TYPES.indexOf(b.itemType);
		});

		if (this.settings.claudeApiKey && matches.length > 1) {
			new Notice("Ranking results with Claude...");
			const ranked = await rerankResults(
				query,
				matches.map((match) => ({
					...match,
					canonicalName: this.describeItemMatch(match),
				})),
				this.settings.claudeApiKey,
				this.settings.claudeModel,
				this.settings.claudeWebSearch
			);
			matches = ranked.map(({ itemType, metadata, score, confidence }) => ({
				itemType,
				metadata,
				score,
				confidence,
			}));
		}

		const best = matches[0];
		console.info(
			`[Set Status Plugin] ${matches.length} candidates for "${query}"; best is ` +
			`${best.itemType.label}: "${best.metadata.canonicalName ?? "Unknown"}" ` +
			`(score ${best.score.toFixed(2)}, confidence ${best.confidence.toFixed(2)})`
		);
		return matches;
	}

	/** Query every provider in parallel and keep the top few from each. */
	private async searchAllSources(itemName: string): Promise<ItemMatch[]> {
		const perType = await Promise.all(
			ITEM_TYPES.map(async (itemType): Promise<ItemMatch[]> => {
				try {
					// No per-provider rerank or title correction here — the merged
					// pool is ranked once, and correction is handled by the caller.
					const results = await this.searchForFolder(
						itemName,
						itemType.folder,
						undefined,
						{ rerank: false, correctOnEmpty: false }
					);
					return results.slice(0, CANDIDATES_PER_SOURCE).map((metadata) => ({
						itemType,
						metadata,
						score: this.scoreItemMatch(itemName, metadata),
						confidence: this.matchConfidence(itemName, metadata),
					}));
				} catch (error) {
					console.warn(
						`[Set Status Plugin] Failed to search ${itemType.label} for "${itemName}"`,
						error
					);
					return [];
				}
			})
		);
		return perType.flat();
	}

	/**
	 * Accept without asking only when the top candidate is a near-exact title
	 * match *and* clearly ahead of the runner-up. Two providers both matching
	 * exactly (a book and its film adaptation, say) is precisely the case where
	 * the user should choose.
	 */
	private isConfidentMatch(matches: ItemMatch[]): boolean {
		const best = matches[0];
		if (!best || best.confidence < AUTO_ACCEPT_CONFIDENCE) {
			return false;
		}
		const runnerUp = matches[1];
		if (!runnerUp) {
			return true;
		}
		return best.confidence - runnerUp.confidence >= AUTO_ACCEPT_MARGIN;
	}

	/** Title-only similarity in 0..1, free of the metadata-completeness bonuses in scoreItemMatch. */
	private matchConfidence(itemName: string, metadata: ItemMetadata): number {
		const query = this.normalizeMatchText(itemName);
		const candidate = this.normalizeMatchText(metadata.canonicalName ?? "");
		if (!query || !candidate) {
			return 0;
		}
		if (query === candidate) {
			return 1;
		}
		const queryTokens = new Set(query.split(" ").filter(Boolean));
		const candidateTokens = new Set(candidate.split(" ").filter(Boolean));
		const shared = [...queryTokens].filter((token) => candidateTokens.has(token)).length;
		const union = new Set([...queryTokens, ...candidateTokens]).size;
		return union > 0 ? shared / union : 0;
	}

	private scoreItemMatch(itemName: string, metadata: ItemMetadata): number {
		const query = this.normalizeMatchText(itemName);
		const candidate = this.normalizeMatchText(metadata.canonicalName ?? "");
		let score = 10;
		if (query && candidate) {
			if (query === candidate) {
				score = 100;
			} else if (candidate.includes(query) || query.includes(candidate)) {
				const lengthRatio =
					Math.min(query.length, candidate.length) /
					Math.max(query.length, candidate.length);
				score = 70 + lengthRatio * 20;
			} else {
				const queryTokens = new Set(query.split(" ").filter(Boolean));
				const candidateTokens = new Set(candidate.split(" ").filter(Boolean));
				const shared = [...queryTokens].filter((token) => candidateTokens.has(token)).length;
				const total = new Set([...queryTokens, ...candidateTokens]).size;
				score = total > 0 ? 20 + (shared / total) * 50 : score;
			}
		}
		if (metadata.thumbnail) {
			score += 5;
		}
		if (metadata.id) {
			score += 2;
		}
		if (metadata.author) {
			score += 1;
		}
		return score;
	}

	private normalizeMatchText(value: string): string {
		return value
			.toLowerCase()
			.replace(/^(the|a|an)\s+/, "")
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	private describeItemMatch(match: ItemMatch): string {
		const title = match.metadata.canonicalName ?? "Unknown title";
		const author = match.metadata.author ? ` by ${match.metadata.author}` : "";
		return `${title}${author} (${match.itemType.label})`;
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
		options: SearchOptions = {}
	): Promise<ItemMetadata[]> {
		const { rerank = true, correctOnEmpty = true, isRetry = false } = options;
		const itemType = ITEM_TYPES.find((type) => type.folder === folder);
		if (!itemType) {
			console.warn(`[Set Status Plugin] searchForFolder: unknown folder "${folder}"`);
			return [];
		}

		console.info(`[Set Status Plugin] searchForFolder: "${itemName}" in "${folder}"${author ? ` (author="${author}")` : ""}`);
		let raw: Omit<ItemMetadata, "source">[];
		if (folder === GAMES_FOLDER) {
			const accessToken = await this.ensureIgdbAccessToken();
			if (!accessToken) {
				console.warn("[Set Status Plugin] searchForFolder: no IGDB access token");
				return [];
			}
			raw = await searchGames(itemName, {
				clientId: this.settings.igdbClientId,
				accessToken,
			});
		} else if (folder === BOOKS_FOLDER) {
			const lang = this.settings.bookLanguage || undefined;
			const bookQuery = author ? `${itemName} ${author}` : itemName;
			console.info(`[Set Status Plugin] searchForFolder: using book language="${lang ?? "any"}"`);
			raw = await searchBooks(bookQuery, lang);
		} else if (folder === TV_SHOWS_FOLDER) {
			if (!this.settings.tmdbApiKey) {
				console.warn("[Set Status Plugin] searchForFolder: no TMDB API key");
				return [];
			}
			raw = await searchTvShows(itemName, this.settings.tmdbApiKey);
		} else {
			console.warn(`[Set Status Plugin] searchForFolder: unknown folder "${folder}"`);
			return [];
		}

		let results: ItemMetadata[] = raw.map((entry) => ({
			...entry,
			source: itemType.source,
		}));

		if (this.settings.claudeApiKey) {
			if (results.length === 0 && correctOnEmpty && !isRetry) {
				new Notice("No results — asking Claude to identify the title...");
				const corrected = await correctTitle(
					itemName,
					itemType.label,
					this.settings.claudeApiKey,
					this.settings.claudeModel,
					this.settings.claudeWebSearch
				);
				if (corrected && corrected.toLowerCase() !== itemName.toLowerCase()) {
					new Notice(`Searching for "${corrected}"...`);
					console.info(`[Set Status Plugin] searchForFolder: retrying with corrected title "${corrected}"`);
					return this.searchForFolder(corrected, folder, author, {
						...options,
						isRetry: true,
					});
				}
			} else if (rerank && results.length > 1) {
				new Notice("Ranking results with Claude...");
				results = await rerankResults(
					itemName,
					results,
					this.settings.claudeApiKey,
					this.settings.claudeModel,
					this.settings.claudeWebSearch
				);
			}
		}

		return results;
	}

	/**
	 * Re-fetch the exact entity a note is already pinned to. Returns null when
	 * the note has no pin, so the caller can fall back to a title search.
	 */
	private async fetchPinnedMetadata(
		frontmatter: Record<string, unknown> | undefined
	): Promise<ItemMetadata | null> {
		const source = readStringField(frontmatter, FM_SOURCE);
		const sourceId = readStringField(frontmatter, FM_SOURCE_ID);
		if (!source || !sourceId) {
			return null;
		}

		const itemType = ITEM_TYPES.find((type) => type.source === source);
		if (!itemType) {
			console.warn(`[Set Status Plugin] fetchPinnedMetadata: unknown source "${source}"`);
			return null;
		}

		let raw: Omit<ItemMetadata, "source"> | null = null;
		if (source === "igdb") {
			const accessToken = await this.ensureIgdbAccessToken();
			if (!accessToken) {
				return null;
			}
			raw = await fetchGameById(sourceId, {
				clientId: this.settings.igdbClientId,
				accessToken,
			});
		} else if (source === "openlibrary") {
			raw = await fetchBookByKey(sourceId, this.settings.bookLanguage || undefined);
		} else if (source === "tmdb") {
			if (!this.settings.tmdbApiKey) {
				return null;
			}
			raw = await fetchTvShowById(sourceId, this.settings.tmdbApiKey);
		}

		if (!raw) {
			console.warn(`[Set Status Plugin] fetchPinnedMetadata: ${source} lookup failed for "${sourceId}"`);
			return null;
		}
		return { ...raw, source: itemType.source };
	}

	private async applyThumbnail(
		file: TFile,
		choice: ItemMetadata
	): Promise<void> {
		if (!choice.thumbnail) {
			new Notice("Selected result has no cover image.");
			return;
		}
		try {
			const raw = await this.app.vault.read(file);
			const data = extractFrontmatter(raw);
			this.stampMetadata(data.frontmatter, choice);
			const { text: updatedContent } = upsertCoverImage(
				data.content,
				choice.thumbnail
			);
			data.content = updatedContent;
			await this.app.vault.modify(file, convertToMarkdown(data));
			new Notice("Thumbnail updated.");
		} catch (error) {
			console.error("[Set Status Plugin] applyThumbnail failed:", error);
			new Notice("Could not write the thumbnail. Check the console for details.");
		}
	}

	/**
	 * Record which provider entity a note is bound to, so later refreshes fetch
	 * by id instead of re-guessing from the filename.
	 */
	private stampMetadata(
		frontmatter: Record<string, unknown>,
		metadata: ItemMetadata
	): void {
		if (metadata.thumbnail) {
			frontmatter["thumbnail"] = metadata.thumbnail;
		}
		if (metadata.id) {
			frontmatter["url"] = metadata.id;
		}
		if (metadata.source) {
			frontmatter[FM_SOURCE] = metadata.source;
		}
		if (metadata.sourceId) {
			frontmatter[FM_SOURCE_ID] = metadata.sourceId;
		}
		if (metadata.author) {
			frontmatter["author"] = metadata.author;
		}
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
			author = readStringField(data.frontmatter, "author") ?? undefined;
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
				(choice) => void this.applyThumbnail(file, choice)
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

	private async updateNoteThumbnail(
		file: TFile,
		folder: string,
		options: SearchOptions = {}
	): Promise<ThumbnailUpdateResult> {
		const vault = this.app.vault;
		const raw = await vault.read(file);
		const data = extractFrontmatter(raw);
		const itemName = file.basename.trim();

		// A note that already recorded its provider entity is refreshed by id —
		// never re-searched by title, which is what used to let a refresh drift
		// onto a different item. If the pinned lookup fails we stop rather than
		// falling back to a title search, so a transient error can't re-point
		// the note at something else.
		const isPinned =
			readStringField(data.frontmatter, FM_SOURCE) !== null &&
			readStringField(data.frontmatter, FM_SOURCE_ID) !== null;

		let metadata = isPinned ? await this.fetchPinnedMetadata(data.frontmatter) : null;
		if (isPinned && !metadata) {
			return {
				status: "skipped",
				reason: `Could not re-fetch the pinned entity for '${itemName}'; leaving the existing match alone.`,
			};
		}
		if (!metadata) {
			if (!itemName) {
				return { status: "skipped", reason: "Could not determine item name from filename." };
			}
			const existingAuthor =
				folder === BOOKS_FOLDER
					? readStringField(data.frontmatter, "author") ?? undefined
					: undefined;
			const results = await this.searchForFolder(itemName, folder, existingAuthor, options);
			metadata = results[0] ?? null;
		}

		if (!metadata) {
			return { status: "skipped", reason: `No result found for '${itemName}'.` };
		}
		if (!metadata.thumbnail) {
			return { status: "skipped", reason: `Result for '${itemName}' lacks a cover image.` };
		}

		const nextThumbnail = metadata.thumbnail;
		const currentThumbnail = readStringField(data.frontmatter, "thumbnail");
		const pinChanged =
			readStringField(data.frontmatter, FM_SOURCE_ID) !== (metadata.sourceId ?? null);
		const { text: updatedContent, changed: contentChanged } =
			upsertCoverImage(data.content, nextThumbnail);
		const frontmatterChanged = currentThumbnail !== nextThumbnail;
		if (!frontmatterChanged && !contentChanged && !pinChanged) {
			return { status: "unchanged", reason: "Note already references the current thumbnail." };
		}
		this.stampMetadata(data.frontmatter, metadata);
		data.content = updatedContent;
		await vault.modify(file, convertToMarkdown(data));
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

					// Bulk pass: no per-file Claude calls. Reranking and title
					// correction each cost a web search, and this loop can span
					// the whole vault.
					const result = await this.updateNoteThumbnail(file, folder, {
						rerank: false,
						correctOnEmpty: false,
					});

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
	onSubmit: (itemName: string, status: string) => Promise<void>;
	private readonly statuses: string[];
	private itemName = "";
	private selectedStatus: string;
	private statusInput: TextComponent | null = null;

	constructor(
		app: App,
		statuses: string[],
		onSubmit: (itemName: string, status: string) => Promise<void>
	) {
		super(app);
		this.statuses = statuses;
		this.onSubmit = onSubmit;
		const defaultStatus = statuses.find(
			(status) => status.toLowerCase() === "on radar"
		);
		this.selectedStatus = defaultStatus ?? statuses[0] ?? "on radar";
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "New item" });

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
					this.openStatusSuggest(this.statusInput?.getValue() ?? "");
				}
			});
		});
		statusSetting.addExtraButton((button) => {
			button.setIcon("search");
			button.setTooltip("Browse statuses");
			button.onClick(() => this.openStatusSuggest(""));
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
		const status = this.selectedStatus ?? "";
		// Close before searching — creation may open the confirm-match modal,
		// and stacking it on top of this one looks broken.
		this.close();
		await this.onSubmit(trimmed, status);
	}

	private openStatusSuggest(query: string): void {
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
			query
		);
		modal.open();
	}

	onClose() {
		this.contentEl.empty();
	}
}

/**
 * Shown when the automatic match isn't confident enough to commit to. Lets the
 * user pick from the ranked candidates, retype the search, or create the note
 * with no metadata at all so an item the providers don't know about is still
 * trackable.
 */
class MatchPickerModal extends Modal {
	private query: string;
	private candidates: ItemMatch[];
	private readonly search: (query: string) => Promise<ItemMatch[]>;
	private readonly onResolve: (resolution: MatchResolution) => void;
	private resolved = false;
	private searching = false;
	private resultsEl: HTMLElement | null = null;
	private queryInput: TextComponent | null = null;

	constructor(
		app: App,
		query: string,
		candidates: ItemMatch[],
		search: (query: string) => Promise<ItemMatch[]>,
		onResolve: (resolution: MatchResolution) => void
	) {
		super(app);
		this.query = query;
		this.candidates = candidates;
		this.search = search;
		this.onResolve = onResolve;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Confirm match" });

		const searchSetting = new Setting(contentEl)
			.setName("Search for")
			.setDesc("Edit the title and search again if none of these are right.");
		searchSetting.addText((text) => {
			this.queryInput = text;
			text.setValue(this.query);
			text.inputEl.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					void this.runSearch();
				}
			});
		});
		searchSetting.addButton((button) =>
			button.setButtonText("Search").onClick(() => void this.runSearch())
		);

		this.resultsEl = contentEl.createDiv();
		this.renderResults();

		const footer = new Setting(contentEl)
			.setName("None of these?")
			.setDesc("Create the note without any metadata, in the folder you choose.");
		for (const itemType of ITEM_TYPES) {
			footer.addButton((button) =>
				button
					.setButtonText(itemType.label)
					.onClick(() => this.resolve({ type: "plain", itemType }))
			);
		}
	}

	private async runSearch(): Promise<void> {
		if (this.searching) {
			return;
		}
		const nextQuery = this.queryInput?.getValue().trim() ?? "";
		if (!nextQuery) {
			new Notice("Enter something to search for.");
			return;
		}
		this.searching = true;
		this.query = nextQuery;
		this.renderMessage(`Searching for "${nextQuery}"...`);
		try {
			this.candidates = await this.search(nextQuery);
		} catch (error) {
			console.error("[Set Status Plugin] Match search failed:", error);
			this.candidates = [];
		} finally {
			this.searching = false;
		}
		this.renderResults();
	}

	private renderMessage(text: string): void {
		if (!this.resultsEl) {
			return;
		}
		this.resultsEl.empty();
		const message = this.resultsEl.createEl("p", { text });
		message.style.color = "var(--text-muted)";
	}

	private renderResults(): void {
		if (!this.resultsEl) {
			return;
		}
		if (this.candidates.length === 0) {
			this.renderMessage(
				`No matches found for "${this.query}". Try a different spelling, or create the note without metadata.`
			);
			return;
		}

		this.resultsEl.empty();
		const grid = this.resultsEl.createDiv({ cls: "match-picker-grid" });
		grid.style.display = "grid";
		grid.style.gridTemplateColumns = "repeat(auto-fill, minmax(150px, 1fr))";
		grid.style.gap = "12px";
		grid.style.margin = "12px 0";
		grid.style.maxHeight = "50vh";
		grid.style.overflowY = "auto";

		for (const candidate of this.candidates) {
			const card = grid.createDiv({ cls: "match-picker-card" });
			card.style.cursor = "pointer";
			card.style.textAlign = "center";
			card.style.padding = "8px";
			card.style.borderRadius = "6px";
			card.style.border = "1px solid var(--background-modifier-border)";

			if (candidate.metadata.thumbnail) {
				const img = card.createEl("img", {
					attr: { src: candidate.metadata.thumbnail },
				});
				img.style.width = "100%";
				img.style.height = "auto";
				img.style.borderRadius = "4px";
				img.style.marginBottom = "6px";
			} else {
				const placeholder = card.createDiv({ text: "No cover" });
				placeholder.style.padding = "24px 0";
				placeholder.style.fontSize = "0.8em";
				placeholder.style.color = "var(--text-faint)";
			}

			const title = card.createDiv({
				text: candidate.metadata.canonicalName ?? "Unknown title",
			});
			title.style.fontSize = "0.9em";

			if (candidate.metadata.author) {
				const author = card.createDiv({ text: candidate.metadata.author });
				author.style.fontSize = "0.8em";
				author.style.color = "var(--text-muted)";
			}

			const badge = card.createDiv({ text: candidate.itemType.label });
			badge.style.marginTop = "4px";
			badge.style.fontSize = "0.75em";
			badge.style.color = "var(--text-faint)";

			card.addEventListener("mouseenter", () => {
				card.style.border = "1px solid var(--interactive-accent)";
			});
			card.addEventListener("mouseleave", () => {
				card.style.border = "1px solid var(--background-modifier-border)";
			});
			card.addEventListener("click", () =>
				this.resolve({ type: "match", match: candidate })
			);
		}
	}

	private resolve(resolution: MatchResolution): void {
		if (this.resolved) {
			return;
		}
		this.resolved = true;
		this.onResolve(resolution);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
		// Dismissing the modal any other way (Esc, click-out) cancels creation.
		if (!this.resolved) {
			this.resolved = true;
			this.onResolve({ type: "cancel" });
		}
	}
}

class ThumbnailPickerModal extends Modal {
	private results: ItemMetadata[];
	private onPick: (choice: ItemMetadata) => void;

	constructor(
		app: App,
		results: ItemMetadata[],
		onPick: (choice: ItemMetadata) => void
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
		new Setting(containerEl)
			.setName("Always confirm match")
			.setDesc(
				"Show the candidate picker every time a new item is created, even when the best match looks certain."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.alwaysConfirmMatch)
					.onChange(async (value) => {
						this.plugin.settings.alwaysConfirmMatch = value;
						await this.plugin.saveSettings();
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
					const result = await searchTvShows("Breaking Bad", apiKey);
					if (result.length > 0) {
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

		new Setting(containerEl)
			.setName("Enable web search for reranking")
			.setDesc("Allow Claude to search the web when reranking results. More accurate, but costs ~$0.01 per search on top of token costs. Web search is always used for title correction.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.claudeWebSearch)
					.onChange(async (value) => {
						this.plugin.settings.claudeWebSearch = value;
						await this.plugin.saveSettings();
					});
			});
	}
}
