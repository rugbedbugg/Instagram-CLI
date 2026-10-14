/**
 * EXPERIMENTAL offline entry point for the session-bootstrap investigation
 * (see `docs/session-bootstrap.md`). It is deliberately NOT a Pastel command
 * and not part of the shipped `dist` bundle: it is a manual tool for a later,
 * separately authorized live test, not a supported way to log in.
 *
 * It reads a user-authorized Instagram session id with the terminal echo off,
 * validates it with one authenticated private-API request, and prints only a
 * sanitized outcome. It never retries, never falls back to credential login,
 * and never writes anything until the server has validated the session.
 *
 * Run it manually, for example:
 *   node --loader ts-node/esm source/experimental/session-bootstrap.ts
 */
import process from 'node:process';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {AuthenticationCoordinator} from '../auth/coordinator.js';
import {describeAuthenticationOutcome} from '../auth/outcomes.js';
import {InstagramClient} from '../client.js';
import {ConfigManager} from '../config.js';
import {initializeLogger} from '../utils/logger.js';

/** Read one line with the terminal echo suppressed. The value is never logged. */
async function readSecret(promptText: string): Promise<string> {
	return new Promise(resolve => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: true,
		});
		// Suppress the echo of every keystroke; print the prompt ourselves.
		const mutable = rl as unknown as {_writeToOutput: () => void};
		mutable._writeToOutput = () => {
			/* no echo */
		};

		process.stderr.write(promptText);
		rl.question('', answer => {
			rl.close();
			process.stderr.write('\n');
			resolve(answer.trim());
		});
	});
}

export async function runSessionBootstrap(): Promise<void> {
	await initializeLogger();
	await ConfigManager.getInstance().initialize();

	process.stderr.write(
		'EXPERIMENTAL session bootstrap — offline investigation only.\n' +
			'Use a session id for a dedicated test account you control. Input is hidden.\n',
	);
	const sessionId = await readSecret('Instagram session id: ');
	if (!sessionId) {
		process.stderr.write('No session id entered; nothing was attempted.\n');
		process.exitCode = 1;
		return;
	}

	const client = new InstagramClient();
	const coordinator = new AuthenticationCoordinator(client);
	try {
		const outcome = await coordinator.bootstrapSession(sessionId, {
			initializeRealtime: false,
		});
		process.stderr.write(`${describeAuthenticationOutcome(outcome)}\n`);
		process.stderr.write(`outcome: ${outcome.kind}\n`);
		process.exitCode = outcome.kind === 'session-validated' ? 0 : 1;
	} finally {
		await client.shutdown();
	}
}

// Run only when invoked directly, never on import (tests import nothing here).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	await runSessionBootstrap();
}
