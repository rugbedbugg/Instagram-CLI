import {
	type IgApiClient,
	IgLoginRequiredError,
	IgUserHasLoggedOutError,
} from 'instagram-private-api';
import type {SessionManager} from '../session.js';
import {createContextualLogger} from '../utils/logger.js';

type Subscription = ReturnType<IgApiClient['request']['end$']['subscribe']>;

/**
 * Owns the client's response-driven session saving.
 *
 * Saving is inactive until the client has established an authenticated
 * session, so responses produced by a failed or interrupted login are never
 * written. While active, response completions are coalesced into one save at a
 * time; each save serializes the client state when it starts, so a later save
 * always reflects state at least as new as any earlier one.
 */
export class SessionPersistence {
	private manager: SessionManager | undefined;
	private subscriptions: Subscription[] = [];
	private scheduled: NodeJS.Immediate | undefined;
	private dirty = false;
	private draining = false;
	private cycle: Promise<boolean> = Promise.resolve(false);
	private readonly ig: IgApiClient;
	private readonly logger = createContextualLogger('SessionPersistence');

	constructor(ig: IgApiClient) {
		this.ig = ig;
	}

	public get isActive(): boolean {
		return this.manager !== undefined;
	}

	/** Start saving for an authenticated session. Idempotent per manager. */
	public activate(manager: SessionManager): void {
		if (this.manager === manager) {
			return;
		}

		if (this.manager) {
			throw new Error(
				'Session persistence is active for another session; deactivate it first',
			);
		}

		this.manager = manager;
		this.subscriptions = [
			this.ig.request.end$.subscribe(() => {
				this.scheduleFromResponse();
			}),
			this.ig.request.error$.subscribe(error => {
				// The server ended this session. Keep the saved file for the user
				// to inspect or replace; only stop writing over it.
				if (
					error instanceof IgLoginRequiredError ||
					error instanceof IgUserHasLoggedOutError
				) {
					this.logger.warn('Server ended the session; persistence suspended');
					this.detach();
				}
			}),
		];
	}

	/**
	 * Stop saving and wait for any write already in progress. With `flush`, a
	 * save requested by a completed response but not yet started runs first.
	 */
	public async deactivate(options: {flush?: boolean} = {}): Promise<void> {
		const responsePending = this.scheduled !== undefined;
		this.cancelScheduled();
		if (options.flush && responsePending && this.manager) {
			await this.save();
		}

		this.detach();
		await this.cycle;
	}

	/**
	 * Save the current client state. Resolves once a write that started after
	 * this call finishes; `false` if persistence is inactive or the write failed.
	 */
	public async save(): Promise<boolean> {
		if (!this.manager) {
			return false;
		}

		this.dirty = true;
		if (!this.draining) {
			this.draining = true;
			this.cycle = this.drain();
		}

		return this.cycle;
	}

	private async drain(): Promise<boolean> {
		let saved = false;
		try {
			while (this.dirty && this.manager) {
				this.dirty = false;
				// eslint-disable-next-line no-await-in-loop
				saved = await this.write(this.manager);
			}
		} finally {
			this.draining = false;
		}

		return saved;
	}

	private async write(manager: SessionManager): Promise<boolean> {
		try {
			const serialized: Record<string, unknown> =
				await this.ig.state.serialize();
			await manager.saveSession(serialized);
			return true;
		} catch (error) {
			this.logger.error('Error saving session state', error);
			return false;
		}
	}

	// Deferred past the response's own error$ notification, which the
	// dependency emits on the next tick after end$, so an ended session is never
	// saved.
	private scheduleFromResponse(): void {
		if (this.scheduled) {
			return;
		}

		this.scheduled = setImmediate(() => {
			this.scheduled = undefined;
			void this.save();
		});
	}

	private cancelScheduled(): void {
		if (this.scheduled) {
			clearImmediate(this.scheduled);
			this.scheduled = undefined;
		}
	}

	private detach(): void {
		this.cancelScheduled();
		for (const subscription of this.subscriptions) {
			subscription.unsubscribe();
		}

		this.subscriptions = [];
		this.manager = undefined;
	}
}
