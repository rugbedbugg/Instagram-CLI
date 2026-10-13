import fs from 'node:fs/promises';
import path from 'node:path';
import {ConfigManager} from './config.js';
import {
	type AtomicFileSystem,
	enqueueFileOperation as enqueue,
	nodeFileSystem,
	replaceFile,
	temporaryFilePrefix,
} from './utils/atomic-file.js';
import {createContextualLogger} from './utils/logger.js';

export type SerializedState = Record<string, any>;

/** File operations a session write depends on; replaceable in tests. */
export type SessionFileSystem = AtomicFileSystem;

/**
 * Remove temporary files that interrupted writes of `target` left behind; they
 * hold session state. Run inside the target's queue, so none of them belongs
 * to a write still in progress in this process.
 */
async function removeTemporaryFiles(
	fileSystem: SessionFileSystem,
	target: string,
): Promise<void> {
	const directory = path.dirname(target);
	const prefix = temporaryFilePrefix(target);
	let entries: string[];
	try {
		entries = await fs.readdir(directory);
	} catch {
		return;
	}

	await Promise.all(
		entries
			.filter(entry => entry.startsWith(prefix) && entry.endsWith('.tmp'))
			.map(async entry => {
				try {
					await fileSystem.unlink(path.join(directory, entry));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
						throw error;
					}
				}
			}),
	);
}

export class SessionManager {
	private username: string | undefined;
	private readonly configManager: ConfigManager;
	private readonly fileSystem: SessionFileSystem;
	private readonly logger = createContextualLogger('SessionManager');

	constructor(
		username?: string,
		options: {fileSystem?: SessionFileSystem} = {},
	) {
		this.configManager = ConfigManager.getInstance();
		this.fileSystem = options.fileSystem ?? nodeFileSystem;
		this.username = username ?? undefined;

		if (!this.username) {
			this.username = this.getDefaultUsername();
			if (!this.username) {
				throw new Error(
					'No username provided and no default username found in config',
				);
			}
		}
	}

	public getUsername(): string | undefined {
		return this.username;
	}

	public setUsername(username: string): void {
		this.username = username;
	}

	/**
	 * Atomically replace the saved session. The state is serialized before the
	 * file system is touched, so a state that cannot be serialized, or a failed
	 * write, leaves the previous session in place.
	 */
	public async saveSession(serializedState: SerializedState): Promise<void> {
		const sessionPath = this.getSessionPath();

		try {
			// Remove constants to always use the latest version
			const {constants, ...stateToSave} = serializedState;
			const data = JSON.stringify(stateToSave, null, 2) as string | undefined;
			if (typeof data !== 'string') {
				throw new TypeError('Session state is not serializable');
			}

			await enqueue(sessionPath, async () => {
				await this.ensureSessionDir();
				await replaceFile(this.fileSystem, sessionPath, data);
			});
		} catch (error) {
			this.logger.error('Error saving session:', error);
			throw error;
		}
	}

	public async loadSession(): Promise<SerializedState | undefined> {
		const sessionPath = this.getSessionPath();

		try {
			// Queued so a load observes every save requested before it.
			const sessionData = await enqueue(sessionPath, async () => {
				try {
					return await fs.readFile(sessionPath, 'utf8');
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
						return undefined;
					}

					throw error;
				}
			});
			return sessionData === undefined
				? undefined
				: (JSON.parse(sessionData) as SerializedState);
		} catch (error) {
			this.logger.error('Error loading session:', error);
			return undefined;
		}
	}

	public async deleteSession(): Promise<void> {
		const sessionPath = this.getSessionPath();

		// Queued behind pending saves, so none of them can recreate the file.
		await enqueue(sessionPath, async () => {
			try {
				await this.fileSystem.unlink(sessionPath);
			} catch (error) {
				// Session file doesn't exist, which is fine
				if ((error as any).code !== 'ENOENT') {
					this.logger.error('Error deleting session:', error);
					throw error;
				}
			}

			try {
				await removeTemporaryFiles(this.fileSystem, sessionPath);
			} catch (error) {
				this.logger.error('Error deleting interrupted session write:', error);
				throw error;
			}
		});
	}

	public async sessionExists(): Promise<boolean> {
		const sessionPath = this.getSessionPath();
		try {
			await fs.access(sessionPath);
			return true;
		} catch {
			return false;
		}
	}

	private getDefaultUsername(): string | undefined {
		const current = this.configManager.get('login.currentUsername');
		if (current) {
			return current;
		}

		const defaultUsername = this.configManager.get('login.defaultUsername');
		if (defaultUsername) {
			return defaultUsername;
		}

		return undefined;
	}

	private getSessionPath(): string {
		if (!this.username) {
			throw new Error('Username is not set');
		}

		const usersDirectory = this.configManager.get('advanced.usersDir');
		return path.join(usersDirectory, this.username, 'session.ts.json');
	}

	private async ensureSessionDir(): Promise<string> {
		if (!this.username) {
			throw new Error('Username is not set');
		}

		const usersDirectory = this.configManager.get('advanced.usersDir');
		const sessionDirectory = path.join(usersDirectory, this.username);
		await fs.mkdir(sessionDirectory, {recursive: true, mode: 0o700});
		return sessionDirectory;
	}
}
