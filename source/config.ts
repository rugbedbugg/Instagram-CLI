import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import yaml from 'js-yaml';
import {
	type AtomicFileSystem,
	enqueueFileOperation,
	nodeFileSystem,
	replaceFile,
} from './utils/atomic-file.js';
import {createContextualLogger} from './utils/logger.js';

type LoginConfig = {
	defaultUsername?: string;
	currentUsername?: string;
};

type ChatConfig = {
	layout: string;
	colors: boolean;
};

type PrivacyConfig = {
	invisibleMode: boolean;
};

type NotificationsConfig = {
	desktop: boolean;
	sound: boolean;
};

type ImageConfig = {
	protocol?: string;
};

type AdvancedConfig = {
	debugMode: boolean;
	dataDir: string;
	usersDir: string;
	cacheDir: string;
	mediaDir: string;
	generatedDir: string;
	logsDir: string;
	downloadDir: string;
};

type Config = {
	language: string;
	login: LoginConfig;
	chat: ChatConfig;
	privacy: PrivacyConfig;
	notifications: NotificationsConfig;
	image: ImageConfig;
	advanced: AdvancedConfig;
};

/**
 * Environment variable that relocates all CLI state (config, sessions, logs, cache).
 * Used by the test suite to keep automated runs away from real user data.
 */
export const DATA_DIR_ENV_VAR = 'INSTAGRAM_CLI_HOME';

/**
 * Resolves the root directory for all CLI state.
 *
 * @param environment - Environment to read the override from (injectable for tests).
 * @returns The absolute data directory, defaulting to `~/.instagram-cli`.
 */
export function resolveDataDir(
	environment: NodeJS.ProcessEnv = process.env,
): string {
	const override = environment[DATA_DIR_ENV_VAR]?.trim();
	if (override) {
		return path.resolve(override);
	}

	return path.join(os.homedir(), '.instagram-cli');
}

const createDefaultConfig = (dataDir: string): Config => ({
	language: 'en',
	login: {
		defaultUsername: undefined,
		currentUsername: undefined,
	},
	chat: {
		layout: 'compact',
		colors: true,
	},
	privacy: {
		invisibleMode: false,
	},
	notifications: {
		desktop: false,
		sound: false,
	},
	advanced: {
		debugMode: false,
		dataDir,
		usersDir: path.join(dataDir, 'users'),
		cacheDir: path.join(dataDir, 'cache'),
		mediaDir: path.join(dataDir, 'media'),
		generatedDir: path.join(dataDir, 'generated'),
		logsDir: path.join(dataDir, 'logs'),
		downloadDir: path.join(dataDir, 'downloads'),
	},
	image: {},
});

export type ConfigManagerOptions = {
	readonly dataDir?: string;
	readonly fileSystem?: AtomicFileSystem;
};

export class ConfigManager {
	public static getInstance(): ConfigManager {
		ConfigManager.instance ||= new ConfigManager();
		return ConfigManager.instance;
	}

	/**
	 * A manager for its own data directory, separate from the shared instance.
	 * Writes to one config file are still serialized across all managers.
	 */
	public static createIsolated(
		options: ConfigManagerOptions & {readonly dataDir: string},
	): ConfigManager {
		return new ConfigManager(options);
	}

	private static instance: ConfigManager;
	private config: Config;
	// Resolved at construction (not import) so the data dir override is honored
	private readonly defaultConfig: Config;
	private readonly configDir: string;
	private readonly configFile: string;
	private readonly fileSystem: AtomicFileSystem;
	private readonly logger = createContextualLogger('ConfigManager');

	private constructor(options: ConfigManagerOptions = {}) {
		this.defaultConfig = createDefaultConfig(
			options.dataDir ?? resolveDataDir(),
		);
		this.configDir = this.defaultConfig.advanced.dataDir;
		this.configFile = path.join(this.configDir, 'config.ts.yaml');
		this.fileSystem = options.fileSystem ?? nodeFileSystem;
		this.config = {...this.defaultConfig};
	}

	public getConfigFilePath(): string {
		return this.configFile;
	}

	public async initialize(): Promise<void> {
		await this.loadConfig();
	}

	public get<T = string>(keyPath: string, defaultValue?: T): T {
		const keys = keyPath.split('.');
		let value: any = this.config;

		for (const key of keys) {
			if (value && typeof value === 'object' && key in value) {
				value = value[key];
			} else {
				return defaultValue as T;
			}
		}

		return value as T;
	}

	/**
	 * Change one setting and save. The new configuration is serialized before
	 * anything changes: if it cannot be, the setting and the file both stay as
	 * they were. Saves apply in call order and replace the file atomically.
	 */
	public async set(keyPath: string, value: any): Promise<void> {
		const keys = keyPath.split('.');
		const next = structuredClone(this.config);
		let current: any = next;

		for (let i = 0; i < keys.length - 1; i++) {
			const key = keys[i];
			if (key && !(key in current)) {
				current[key] = {};
			}

			if (key) {
				current = current[key];
			}
		}

		const lastKey = keys.at(-1);
		if (lastKey) {
			current[lastKey] = value;
		}

		let data: string;
		try {
			data = yaml.dump(next);
		} catch (error) {
			this.logger.error(`Config value for ${keyPath} cannot be saved`, error);
			return;
		}

		this.config = next;
		await this.writeConfig(data);
	}

	public getConfig(): Config {
		return {...this.config};
	}

	private async loadConfig(): Promise<void> {
		try {
			// Queued behind pending saves, so a reload never reads stale settings.
			const configData = await enqueueFileOperation(
				this.configFile,
				async () => {
					await this.ensureConfigDir();
					try {
						return await fs.readFile(this.configFile, 'utf8');
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
							return undefined;
						}

						throw error;
					}
				},
			);

			if (configData === undefined) {
				await this.writeConfig(yaml.dump(this.config));
			} else {
				const loadedConfig = yaml.load(configData) as Partial<Config>;
				this.config = this.mergeConfig(this.defaultConfig, loadedConfig);
			}
		} catch (error) {
			this.logger.error('Error loading config:', error);
			this.config = {...this.defaultConfig};
		}
	}

	private mergeConfig(
		defaultConfig: Config,
		loadedConfig: Partial<Config>,
	): Config {
		return {
			...defaultConfig,
			...loadedConfig,
			login: {...defaultConfig.login, ...loadedConfig.login},
			chat: {...defaultConfig.chat, ...loadedConfig.chat},
			privacy: {...defaultConfig.privacy, ...loadedConfig.privacy},
			notifications: {
				...defaultConfig.notifications,
				...loadedConfig.notifications,
			},
			image: {...defaultConfig.image, ...loadedConfig.image},
			advanced: {...defaultConfig.advanced, ...loadedConfig.advanced},
		};
	}

	/**
	 * Atomically replace the config file with already-serialized content, after
	 * every earlier save. A failure keeps the previous file and is logged.
	 */
	private async writeConfig(data: string): Promise<void> {
		try {
			await enqueueFileOperation(this.configFile, async () => {
				await this.ensureConfigDir();
				await replaceFile(this.fileSystem, this.configFile, data);
			});
		} catch (error) {
			this.logger.error('Error saving config:', error);
		}
	}

	private async ensureConfigDir(): Promise<void> {
		// Owner-only when created here; an existing directory is left as is.
		await fs.mkdir(this.configDir, {recursive: true, mode: 0o700});
	}
}
