import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import nodeUtil from 'node:util';
import debugModule from 'debug';
import {ConfigManager, resolveDataDir} from '../config.js';
import {safeDebugLine} from '../security/debug-diagnostics.js';
import {
	describeErrorForLog,
	redactText,
	redactValue,
} from '../security/redaction.js';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

type LogEntry = {
	readonly level: LogLevel;
	readonly timestamp: string;
	readonly message: string;
	readonly context?: string;
	readonly stack?: string;
};

class Logger {
	// eslint-disable-next-line @typescript-eslint/class-literal-property-style
	private static readonly MAX_BUFFER_SIZE = 1000;
	private logFilePath: string;
	private logsDir: string;
	private readonly sessionId: string;
	private readonly logBuffer: LogEntry[] = [];
	private isInitialized = false;
	private writes: Promise<void> = Promise.resolve();

	constructor() {
		// Initialize with default path; will be updated in initialize()
		this.logsDir = path.join(resolveDataDir(), 'logs');
		this.sessionId = this.generateSessionId();
		this.logFilePath = path.join(this.logsDir, `session-${this.sessionId}.log`);
	}

	async initialize(): Promise<void> {
		if (this.isInitialized) {
			return;
		}

		try {
			// Get logs directory from config
			const configManager = ConfigManager.getInstance();
			await configManager.initialize();
			const configuredLogsDir = configManager.get('advanced.logsDir');
			if (configuredLogsDir) {
				this.logsDir = configuredLogsDir;
				// Update logFilePath with the configured logs directory
				this.logFilePath = path.join(
					this.logsDir,
					`session-${this.sessionId}.log`,
				);
			}

			// Owner-only when created here; an existing directory is left as is.
			await fs.promises.mkdir(this.logsDir, {recursive: true, mode: 0o700});
			this.isInitialized = true;

			enableDependencyDiagnostics();

			// Log initialization
			this.info('Logger initialized', 'Logger');
		} catch {}
	}

	error(message: string, context?: string, error?: Error | unknown): void {
		// Errors become allowlisted diagnostics; other values are reduced by key
		// first. Request options, responses and bodies are never serialized.
		const stack =
			error === undefined
				? undefined
				: error instanceof Error
					? describeErrorForLog(error)
					: JSON.stringify(redactValue(error));
		const entry = this.createLogEntry('error', message, context, stack);
		this.logBuffer.push(entry);
		if (this.logBuffer.length > Logger.MAX_BUFFER_SIZE) {
			this.logBuffer.shift();
		}

		void this.writeToFile(entry);
	}

	warn(message: string, context?: string): void {
		const entry = this.createLogEntry('warn', message, context);
		this.logBuffer.push(entry);
		if (this.logBuffer.length > Logger.MAX_BUFFER_SIZE) {
			this.logBuffer.shift();
		}

		void this.writeToFile(entry);
	}

	info(message: string, context?: string): void {
		const entry = this.createLogEntry('info', message, context);
		this.logBuffer.push(entry);
		if (this.logBuffer.length > Logger.MAX_BUFFER_SIZE) {
			this.logBuffer.shift();
		}

		void this.writeToFile(entry);
	}

	debug(message: string, context?: string): void {
		const entry = this.createLogEntry('debug', message, context);
		this.logBuffer.push(entry);
		if (this.logBuffer.length > Logger.MAX_BUFFER_SIZE) {
			this.logBuffer.shift();
		}

		void this.writeToFile(entry);
	}

	getLogFilePath(): string {
		return this.logFilePath;
	}

	getLogsDirectory(): string {
		return this.logsDir;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getBufferedLogs(): LogEntry[] {
		return [...this.logBuffer];
	}

	/** Resolves once every entry logged so far has been written. */
	async flush(): Promise<void> {
		await this.writes;
	}

	private generateSessionId(): string {
		const now = new Date();
		const dateStr = now.toISOString().replaceAll(/[:.]/g, '-').split('T')[0];
		const timeStr = now
			.toISOString()
			.replaceAll(/[:.]/g, '-')
			.split('T')[1]
			?.split('-')[0];
		return `${dateStr}_${timeStr}`;
	}

	private formatLogEntry(entry: LogEntry): string {
		const timeStr = entry.timestamp;
		const contextStr = entry.context ? ` [${entry.context}]` : '';
		const levelStr = entry.level.toUpperCase();

		let output = `${timeStr} ${levelStr}${contextStr}: ${entry.message}`;

		if (entry.stack) {
			output += `\n${entry.stack}`;
		}

		return output;
	}

	private async writeToFile(entry: LogEntry): Promise<void> {
		if (!this.isInitialized) {
			return;
		}

		const formatted = this.formatLogEntry(entry);
		// In order, and owner-only when the file is created.
		this.writes = this.writes.then(async () => {
			try {
				await fs.promises.appendFile(this.logFilePath, `${formatted}\n`, {
					encoding: 'utf8',
					mode: 0o600,
				});
			} catch {
				// Silently fail if we can't write to file
			}
		});
		await this.writes;
	}

	private createLogEntry(
		level: LogLevel,
		message: string,
		context?: string,
		stack?: string,
	): LogEntry {
		// Every entry passes the central text redaction, whatever its source.
		return {
			level,
			timestamp: new Date().toISOString(),
			message: redactText(message),
			context,
			stack: stack === undefined ? undefined : redactText(stack),
		};
	}
}

type DebugInstance = {readonly namespace?: string};

/**
 * Route dependency debug output (instagram-private-api, instagram_mqtt, mqtts)
 * through the reviewed diagnostics allowlist into the log file, never stderr.
 * Installed when this module loads, before any client exists, and applied to
 * every namespace, so enabling more namespaces through DEBUG cannot bypass it.
 */
function installDependencyDiagnostics(): void {
	// The namespace prefix and colors are not wanted in the log file.
	debugModule.formatArgs = () => undefined;
	debugModule.log = function (this: DebugInstance, ...args: unknown[]) {
		getLogger().debug(
			safeDebugLine(this.namespace, nodeUtil.format(...args)),
			'Dependency',
		);
	};
}

installDependencyDiagnostics();

/** Enable the dependency namespaces that are logged (DEBUG overrides). */
function enableDependencyDiagnostics(): void {
	const requested = process.env['DEBUG'];
	debugModule.enable(
		requested === undefined || requested === '' ? 'ig:*' : requested,
	);
}

// Singleton instance
let loggerInstance: Logger | undefined;

export function getLogger(): Logger {
	loggerInstance ??= new Logger();
	return loggerInstance;
}

export async function initializeLogger(): Promise<void> {
	const logger = getLogger();
	await logger.initialize();
}

export function createContextualLogger(context: string) {
	const logger = getLogger();
	return {
		error(message: string, error?: Error | unknown) {
			logger.error(message, context, error);
		},
		warn(message: string) {
			logger.warn(message, context);
		},
		info(message: string) {
			logger.info(message, context);
		},
		debug(message: string) {
			logger.debug(message, context);
		},
	};
}
