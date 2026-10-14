import {
	classifyAuthenticationError,
	type AuthenticationOutcome,
	type TwoFactorChallenge,
} from './outcomes.js';

/** The existing client flows the coordinator drives. */
export type AuthenticationClient = {
	loginBySession(options?: {
		initializeRealtime: boolean;
	}): Promise<AuthenticationOutcome>;
	loginBySessionId(
		sessionId: string,
		options?: {initializeRealtime: boolean},
	): Promise<AuthenticationOutcome>;
	login(
		username: string,
		password: string,
		options?: {initializeRealtime: boolean},
	): Promise<AuthenticationOutcome>;
	twoFactorLogin(
		code: string,
		challenge: TwoFactorChallenge,
	): Promise<AuthenticationOutcome>;
	startChallenge(): Promise<AuthenticationOutcome>;
	sendChallengeCode(code: string): Promise<AuthenticationOutcome>;
};

export type AuthenticationState =
	| {readonly kind: 'idle'}
	| {
			readonly kind: 'authenticating';
			readonly step: 'session' | 'credentials' | 'verification' | 'checkpoint';
	  }
	| AuthenticationOutcome;

type PendingVerification =
	| {readonly type: 'two-factor'; readonly challenge: TwoFactorChallenge}
	| {readonly type: 'checkpoint-code'}
	| {readonly type: 'checkpoint'};

/**
 * Sequences the client's existing authentication flows. One step runs at a
 * time, so a repeated submission is refused instead of sent twice; nothing is
 * retried automatically. The pending verification context lives only here, in
 * memory, and is dropped once a step ends without needing it.
 */
export class AuthenticationCoordinator {
	private current: AuthenticationState = {kind: 'idle'};
	private pending: PendingVerification | undefined;
	private readonly client: AuthenticationClient;

	constructor(client: AuthenticationClient) {
		this.client = client;
	}

	public get state(): AuthenticationState {
		return this.current;
	}

	public async restoreSession(options: {
		initializeRealtime: boolean;
	}): Promise<AuthenticationOutcome> {
		return this.run('session', async () => this.client.loginBySession(options));
	}

	/**
	 * EXPERIMENTAL: validate a user-authorized session id, once per call. Like
	 * every step here it runs alone and is never retried.
	 */
	public async bootstrapSession(
		sessionId: string,
		options: {initializeRealtime: boolean},
	): Promise<AuthenticationOutcome> {
		return this.run('session', async () =>
			this.client.loginBySessionId(sessionId, options),
		);
	}

	public async loginWithCredentials(
		username: string,
		password: string,
		options: {initializeRealtime: boolean},
	): Promise<AuthenticationOutcome> {
		return this.run('credentials', async () =>
			this.client.login(username, password, options),
		);
	}

	/** Ask Instagram for a challenge code, after `checkpoint-required`. */
	public async requestCheckpointCode(): Promise<AuthenticationOutcome> {
		if (this.pending?.type !== 'checkpoint') {
			return {kind: 'failed', reason: 'invalid-state'};
		}

		return this.run('checkpoint', async () => this.client.startChallenge());
	}

	/** Submit a user-entered 2FA or challenge code, once per call. */
	public async submitVerificationCode(
		code: string,
	): Promise<AuthenticationOutcome> {
		const {pending} = this;
		if (pending?.type === 'two-factor') {
			return this.run('verification', async () =>
				this.client.twoFactorLogin(code, pending.challenge),
			);
		}

		if (pending?.type === 'checkpoint-code') {
			return this.run('verification', async () =>
				this.client.sendChallengeCode(code),
			);
		}

		return {kind: 'failed', reason: 'invalid-state'};
	}

	private async run(
		step: Extract<AuthenticationState, {kind: 'authenticating'}>['step'],
		operation: () => Promise<AuthenticationOutcome>,
	): Promise<AuthenticationOutcome> {
		if (this.current.kind === 'authenticating') {
			return {kind: 'failed', reason: 'busy'};
		}

		this.current = {kind: 'authenticating', step};
		let outcome: AuthenticationOutcome;
		try {
			outcome = await operation();
		} catch (error) {
			outcome = classifyAuthenticationError(error);
		}

		this.pending = this.nextPending(outcome);
		this.current = outcome;
		return outcome;
	}

	private nextPending(
		outcome: AuthenticationOutcome,
	): PendingVerification | undefined {
		switch (outcome.kind) {
			case 'two-factor-required': {
				return {type: 'two-factor', challenge: outcome.challenge};
			}

			case 'checkpoint-required': {
				return {type: 'checkpoint'};
			}

			case 'checkpoint-code-sent': {
				return {type: 'checkpoint-code'};
			}

			case 'verification-code-rejected': {
				// The user may correct a mistyped code for the same verification.
				return this.pending;
			}

			default: {
				return undefined;
			}
		}
	}
}
