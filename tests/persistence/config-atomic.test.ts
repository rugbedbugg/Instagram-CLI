import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import yaml from 'js-yaml';
import {ConfigManager} from '../../source/config.js';
import type {AtomicFileSystem} from '../../source/utils/atomic-file.js';

const realFileSystem: AtomicFileSystem = {
	open: fs.open,
	rename: fs.rename,
	unlink: fs.unlink,
};

async function withDataDir(
	run: (dataDir: string, configFile: string) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ig-cli-config-'));
	const dataDir = path.join(root, 'data');
	try {
		await run(dataDir, path.join(dataDir, 'config.ts.yaml'));
	} finally {
		await fs.rm(root, {recursive: true, force: true});
	}
}

async function manager(dataDir: string, fileSystem?: AtomicFileSystem) {
	const config = ConfigManager.createIsolated({dataDir, fileSystem});
	await config.initialize();
	return config;
}

async function strayFiles(dataDir: string): Promise<string[]> {
	const entries = await fs.readdir(dataDir);
	return entries.filter(entry => entry !== 'config.ts.yaml');
}

async function mode(file: string): Promise<number> {
	const stat = await fs.stat(file);
	return stat.mode & 0o777;
}

test.serial(
	'a value that cannot be serialized changes neither the setting nor the file',
	async t => {
		await withDataDir(async (dataDir, configFile) => {
			const config = await manager(dataDir);
			await config.set('chat.layout', 'wide');
			const before = await fs.readFile(configFile, 'utf8');

			await config.set('chat.layout', () => 'not serializable');

			t.is(config.get('chat.layout'), 'wide');
			t.is(await fs.readFile(configFile, 'utf8'), before);
			t.deepEqual(await strayFiles(dataDir), []);
		});
	},
);

test.serial(
	'an interrupted write keeps the previous config intact',
	async t => {
		await withDataDir(async (dataDir, configFile) => {
			const writer = await manager(dataDir);
			await writer.set('login.defaultUsername', 'kept-user');
			const before = await fs.readFile(configFile, 'utf8');
			const fileSystem: AtomicFileSystem = {
				...realFileSystem,
				async open(...parameters: Parameters<typeof fs.open>) {
					const handle = await fs.open(...parameters);
					if (String(parameters[0]).endsWith('.tmp')) {
						handle.writeFile = async () => {
							await handle.write('login:\n  defaultUsername: trunc');
							throw new Error('Synthetic interruption');
						};
					}

					return handle;
				},
			};

			const interrupted = await manager(dataDir, fileSystem);
			await interrupted.set('login.defaultUsername', 'lost-user');

			t.is(await fs.readFile(configFile, 'utf8'), before);
			t.deepEqual(await strayFiles(dataDir), []);
			const reloaded = await manager(dataDir);
			t.is(reloaded.get('login.defaultUsername'), 'kept-user');
		});
	},
);

test.serial('a failed rename keeps the previous config intact', async t => {
	await withDataDir(async (dataDir, configFile) => {
		const writer = await manager(dataDir);
		await writer.set('chat.colors', false);
		const before = await fs.readFile(configFile, 'utf8');
		const fileSystem: AtomicFileSystem = {
			...realFileSystem,
			async rename() {
				throw Object.assign(new Error('Synthetic rename failure'), {
					code: 'EXDEV',
				});
			},
		};

		const failing = await manager(dataDir, fileSystem);
		await failing.set('chat.colors', true);

		t.is(await fs.readFile(configFile, 'utf8'), before);
		t.deepEqual(await strayFiles(dataDir), []);
	});
});

test.serial(
	'overlapping saves never overlap on disk and the newest state wins',
	async t => {
		await withDataDir(async (dataDir, configFile) => {
			let active = 0;
			let maximum = 0;
			const fileSystem: AtomicFileSystem = {
				...realFileSystem,
				async open(...parameters: Parameters<typeof fs.open>) {
					if (String(parameters[0]).endsWith('.tmp')) {
						active++;
						maximum = Math.max(maximum, active);
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
			const config = await manager(dataDir, fileSystem);
			// A second manager for the same file shares its write queue.
			const other = ConfigManager.createIsolated({dataDir, fileSystem});

			await Promise.all([
				...Array.from({length: 10}, async (_, index) =>
					config.set('chat.layout', `layout-${index}`),
				),
				config.set('login.defaultUsername', 'concurrent-user'),
				config.set('notifications.desktop', true),
				other.set('privacy.invisibleMode', false),
			]);
			await config.set('chat.layout', 'final');

			t.is(maximum, 1);
			const saved = yaml.load(await fs.readFile(configFile, 'utf8')) as {
				chat: {layout: string};
				login: {defaultUsername: string};
				notifications: {desktop: boolean};
			};
			t.is(saved.chat.layout, 'final');
			t.is(saved.login.defaultUsername, 'concurrent-user');
			t.true(saved.notifications.desktop);
			t.deepEqual(await strayFiles(dataDir), []);
		});
	},
);

test.serial('a reload waits for saves already requested', async t => {
	await withDataDir(async dataDir => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const fileSystem: AtomicFileSystem = {
			...realFileSystem,
			async rename(...parameters: Parameters<typeof fs.rename>) {
				await gate;
				await fs.rename(...parameters);
			},
		};
		const config = await manager(dataDir);
		const slow = ConfigManager.createIsolated({dataDir, fileSystem});
		const save = slow.set('chat.layout', 'saved-before-reload');
		const reload = config.initialize();
		setTimeout(release, 20);
		await Promise.all([save, reload]);

		t.is(config.get('chat.layout'), 'saved-before-reload');
	});
});

test.serial(
	'config files are owner-only and keep user settings across reloads',
	async t => {
		await withDataDir(async (dataDir, configFile) => {
			await fs.mkdir(dataDir, {recursive: true});
			// A config written by an older version, readable by others.
			await fs.writeFile(
				configFile,
				yaml.dump({
					language: 'fr',
					login: {defaultUsername: 'existing-user'},
					advanced: {downloadDir: '/custom/downloads'},
				}),
				{mode: 0o644},
			);
			await fs.chmod(configFile, 0o644);

			const config = await manager(dataDir);
			await config.set('chat.layout', 'wide');

			t.is(await mode(configFile), 0o600);
			const reloaded = await manager(dataDir);
			t.is(reloaded.get('language'), 'fr');
			t.is(reloaded.get('login.defaultUsername'), 'existing-user');
			t.is(reloaded.get('advanced.downloadDir'), '/custom/downloads');
			t.is(reloaded.get('chat.layout'), 'wide');
			t.is(reloaded.get('advanced.usersDir'), path.join(dataDir, 'users'));
		});
	},
);

test.serial('a new data directory is created owner-only', async t => {
	await withDataDir(async (dataDir, configFile) => {
		await manager(dataDir);
		t.is(await mode(dataDir), 0o700);
		t.is(await mode(configFile), 0o600);
	});
});
