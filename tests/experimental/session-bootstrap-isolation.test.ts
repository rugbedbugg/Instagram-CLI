import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	ExperimentalStorageError,
	assertExperimentalStorage,
} from '../../source/experimental/session-bootstrap.js';
import {DATA_DIR_ENV_VAR} from '../../source/config.js';

function freshDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'ig-bootstrap-iso-'));
}

function seedSession(dataDir: string, username: string): void {
	const accountDir = path.join(dataDir, 'users', username);
	fs.mkdirSync(accountDir, {recursive: true});
	fs.writeFileSync(path.join(accountDir, 'session.ts.json'), '{}', {
		mode: 0o600,
	});
}

test('an isolated, empty directory is accepted', t => {
	const dataDir = freshDir();
	t.is(
		assertExperimentalStorage({[DATA_DIR_ENV_VAR]: dataDir}),
		path.resolve(dataDir),
	);
});

test('a missing data directory is refused', t => {
	const error = t.throws(() => assertExperimentalStorage({}), {
		instanceOf: ExperimentalStorageError,
	});
	t.true(error.message.includes(DATA_DIR_ENV_VAR));
});

test('an empty data directory variable is refused', t => {
	t.throws(() => assertExperimentalStorage({[DATA_DIR_ENV_VAR]: '   '}), {
		instanceOf: ExperimentalStorageError,
	});
});

test('the real ~/.instagram-cli is refused even when named explicitly', t => {
	const realDefault = path.join(os.homedir(), '.instagram-cli');
	const error = t.throws(
		() => assertExperimentalStorage({[DATA_DIR_ENV_VAR]: realDefault}),
		{instanceOf: ExperimentalStorageError},
	);
	t.true(error.message.includes('real data directory'));
});

test('a directory already holding a saved session is refused', t => {
	const dataDir = freshDir();
	seedSession(dataDir, 'existing_account');
	const error = t.throws(
		() => assertExperimentalStorage({[DATA_DIR_ENV_VAR]: dataDir}),
		{instanceOf: ExperimentalStorageError},
	);
	t.true(error.message.includes('overwrite'));
});

test('a directory with an empty users folder but no session is accepted', t => {
	const dataDir = freshDir();
	fs.mkdirSync(path.join(dataDir, 'users', 'empty_account'), {recursive: true});
	t.is(
		assertExperimentalStorage({[DATA_DIR_ENV_VAR]: dataDir}),
		path.resolve(dataDir),
	);
});
