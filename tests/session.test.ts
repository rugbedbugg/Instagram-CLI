/* eslint-disable @typescript-eslint/no-unsafe-call */

import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'ava';
import {SessionManager, type SessionFileSystem} from '../source/session.js';
import {ConfigManager} from '../source/config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const configManager = ConfigManager.getInstance();

async function withTempUsersDir(
	fn: (tmpDir: string) => Promise<void>,
): Promise<void> {
	await configManager.initialize();
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ig-cli-test-'));
	const originalUsersDir = configManager.get('advanced.usersDir');

	try {
		await configManager.set('advanced.usersDir', tmpDir);
		await fn(tmpDir);
	} finally {
		await configManager.set('advanced.usersDir', originalUsersDir);
		await fs.rm(tmpDir, {recursive: true, force: true});
	}
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.serial(
	'SessionManager: session file is written with owner-only permissions',
	async t => {
		await withTempUsersDir(async tmpDir => {
			const manager = new SessionManager('test-user');
			await manager.saveSession({test: 'data'});

			const sessionPath = path.join(tmpDir, 'test-user', 'session.ts.json');
			const stat = await fs.stat(sessionPath);

			t.is(
				stat.mode & 0o777,
				0o600,
				'Session file should be owner read/write only (0o600)',
			);
		});
	},
);

test.serial(
	'SessionManager: session directory is created with owner-only permissions',
	async t => {
		await withTempUsersDir(async tmpDir => {
			const manager = new SessionManager('test-user-dir');
			await manager.saveSession({test: 'data'});

			const dirPath = path.join(tmpDir, 'test-user-dir');
			const stat = await fs.stat(dirPath);

			t.is(
				stat.mode & 0o777,
				0o700,
				'Session directory should be owner-only (0o700)',
			);
		});
	},
);

// ── Atomic, serialized persistence ───────────────────────────────────────────

const realFileSystem: SessionFileSystem = {
	open: fs.open,
	rename: fs.rename,
	unlink: fs.unlink,
};

async function seed(username: string, tmpDir: string) {
	await new SessionManager(username).saveSession({
		cookies: 'previous-session',
		deviceId: 'android-0000000000000001',
		uuid: 'previous-uuid',
	});
	const sessionPath = path.join(tmpDir, username, 'session.ts.json');
	return {sessionPath, before: await fs.readFile(sessionPath, 'utf8')};
}

async function strayFiles(tmpDir: string, username: string) {
	const entries = await fs.readdir(path.join(tmpDir, username));
	return entries.filter(entry => entry !== 'session.ts.json');
}

test.serial(
	'SessionManager: an unserializable state leaves the previous session',
	async t => {
		await withTempUsersDir(async tmpDir => {
			const {sessionPath, before} = await seed('atomic-serialize', tmpDir);
			const manager = new SessionManager('atomic-serialize');

			await t.throwsAsync(manager.saveSession({cookies: 1n}), {
				instanceOf: TypeError,
			});
			t.is(await fs.readFile(sessionPath, 'utf8'), before);
			t.deepEqual(await strayFiles(tmpDir, 'atomic-serialize'), []);
		});
	},
);

test.serial(
	'SessionManager: an interrupted write never truncates the session',
	async t => {
		await withTempUsersDir(async tmpDir => {
			const {sessionPath, before} = await seed('atomic-interrupted', tmpDir);
			const fileSystem: SessionFileSystem = {
				...realFileSystem,
				async open(...parameters: Parameters<typeof fs.open>) {
					const handle = await fs.open(...parameters);
					if (String(parameters[0]).endsWith('.tmp')) {
						// Half the data reaches disk, then the device fills up.
						return Object.assign(handle, {
							async writeFile(data: string) {
								await handle.write(data.slice(0, data.length / 2));
								throw Object.assign(new Error('synthetic ENOSPC'), {
									code: 'ENOSPC',
								});
							},
						});
					}

					return handle;
				},
			};
			const manager = new SessionManager('atomic-interrupted', {fileSystem});

			await t.throwsAsync(
				manager.saveSession({cookies: 'replacement-session'}),
				{message: 'synthetic ENOSPC'},
			);
			t.is(await fs.readFile(sessionPath, 'utf8'), before);
			t.deepEqual(await strayFiles(tmpDir, 'atomic-interrupted'), []);
		});
	},
);

test.serial(
	'SessionManager: a failed atomic replacement keeps the previous session',
	async t => {
		await withTempUsersDir(async tmpDir => {
			const {sessionPath, before} = await seed('atomic-rename', tmpDir);
			const fileSystem: SessionFileSystem = {
				...realFileSystem,
				async rename() {
					throw Object.assign(new Error('synthetic EXDEV'), {code: 'EXDEV'});
				},
			};
			const manager = new SessionManager('atomic-rename', {fileSystem});

			await t.throwsAsync(
				manager.saveSession({cookies: 'replacement-session'}),
				{message: 'synthetic EXDEV'},
			);
			t.is(await fs.readFile(sessionPath, 'utf8'), before);
			t.deepEqual(await strayFiles(tmpDir, 'atomic-rename'), []);
		});
	},
);

test.serial(
	'SessionManager: concurrent saves never overlap and the last call wins',
	async t => {
		await withTempUsersDir(async tmpDir => {
			let active = 0;
			let maximum = 0;
			const fileSystem: SessionFileSystem = {
				...realFileSystem,
				async open(...parameters: Parameters<typeof fs.open>) {
					if (String(parameters[0]).endsWith('.tmp')) {
						active++;
						maximum = Math.max(maximum, active);
						// Yield so overlapping writes would interleave if allowed.
						await new Promise(resolve => {
							setTimeout(resolve, 2);
						});
					}

					return fs.open(...parameters);
				},
				async rename(...parameters: Parameters<typeof fs.rename>) {
					await fs.rename(...parameters);
					active--;
				},
			};
			// Separate managers for one account share the same write queue.
			const saves = Array.from({length: 12}, async (_, index) =>
				new SessionManager('atomic-concurrent', {fileSystem}).saveSession({
					cookies: `generation-${index}`,
					padding: 'x'.repeat(index * 997),
				}),
			);
			await Promise.all(saves);

			t.is(maximum, 1);
			const saved = await new SessionManager('atomic-concurrent').loadSession();
			t.is(saved?.['cookies'], 'generation-11');
			t.deepEqual(await strayFiles(tmpDir, 'atomic-concurrent'), []);
		});
	},
);

test.serial(
	'SessionManager: a delete queued after a save is not undone by it',
	async t => {
		await withTempUsersDir(async tmpDir => {
			const manager = new SessionManager('atomic-delete');
			const pending = manager.saveSession({cookies: 'late-write'});
			const deletion = new SessionManager('atomic-delete').deleteSession();
			await Promise.all([pending, deletion]);

			t.false(await manager.sessionExists());
			t.deepEqual(await strayFiles(tmpDir, 'atomic-delete'), []);
		});
	},
);

test.serial(
	'SessionManager: repeated saves reload intact with the same schema and owner-only mode',
	async t => {
		await withTempUsersDir(async tmpDir => {
			const {sessionPath} = await seed('atomic-reload', tmpDir);
			// A file left readable by an older version is tightened on replace.
			await fs.chmod(sessionPath, 0o644);
			const state = {
				constants: {APP_VERSION: 'never-persisted'},
				cookies: 'current-session',
				deviceId: 'android-0000000000000001',
				uuid: 'previous-uuid',
				supportedCapabilities: [{name: 'SUPPORTED_SDK_VERSIONS', value: '1'}],
			};
			for (let round = 0; round < 3; round++) {
				// eslint-disable-next-line no-await-in-loop
				await new SessionManager('atomic-reload').saveSession(state);
			}

			const {constants, ...expected} = state;
			const reloaded = await new SessionManager('atomic-reload').loadSession();
			t.deepEqual(reloaded, expected);
			const {mode} = await fs.stat(sessionPath);
			t.is(mode & 0o777, 0o600);
			t.deepEqual(await strayFiles(tmpDir, 'atomic-reload'), []);
		});
	},
);
