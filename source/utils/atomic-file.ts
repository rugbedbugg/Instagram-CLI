import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/** File operations an atomic write depends on; replaceable in tests. */
export type AtomicFileSystem = {
	open: typeof fs.open;
	rename: typeof fs.rename;
	unlink: typeof fs.unlink;
};

export const nodeFileSystem: AtomicFileSystem = {
	open: fs.open,
	rename: fs.rename,
	unlink: fs.unlink,
};

// One operation at a time per file path, across every caller in this
// process, in call order. Atomic replacement covers other processes.
const fileQueues = new Map<string, Promise<void>>();

/** Run `task` after every earlier task queued for the same path. */
export async function enqueueFileOperation<T>(
	key: string,
	task: () => Promise<T>,
): Promise<T> {
	const previous = fileQueues.get(key) ?? Promise.resolve();
	const run = previous.then(task);
	const settled = run.then(
		() => undefined,
		() => undefined,
	);
	fileQueues.set(key, settled);
	void settled.then(() => {
		if (fileQueues.get(key) === settled) {
			fileQueues.delete(key);
		}
	});
	return run;
}

/** Name prefix of the temporary files `replaceFile` creates for `target`. */
export function temporaryFilePrefix(target: string): string {
	return `.${path.basename(target)}.`;
}

/**
 * Write a complete owner-only temporary file beside the target, flush it, then
 * rename it over the target. Readers see the previous file or the new one,
 * never a partial write; a failure removes the temporary file.
 */
export async function replaceFile(
	fileSystem: AtomicFileSystem,
	target: string,
	data: string,
): Promise<void> {
	const temporary = path.join(
		path.dirname(target),
		`${temporaryFilePrefix(target)}${process.pid}.${randomUUID()}.tmp`,
	);
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fileSystem.open(temporary, 'wx', 0o600);
		await handle.writeFile(data, 'utf8');
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fileSystem.rename(temporary, target);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await fileSystem.unlink(temporary).catch(() => undefined);
		throw error;
	}

	// Best effort: persist the rename itself. Not supported on every platform.
	try {
		const directory = await fileSystem.open(path.dirname(target), 'r');
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} catch {}
}
