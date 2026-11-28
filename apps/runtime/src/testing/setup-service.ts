import { EnvironmentSetupService } from '../worker/setup/environment-setup.service';

/**
 * A clock that runs from `iso` (a fixture's requestedAt) as real time
 * passes: a fixed past request is not read as one that waited in the
 * queue past its download tokens' life (setupRepoTokensRunOut).
 */
export const clockFrom = (iso: string): (() => Date) => {
    const started = Date.now();
    return () => new Date(Date.parse(iso) + (Date.now() - started));
};

/** The ready check's wait between tries, made instant for specs. */
export const instantSleep = async (_ms: number): Promise<void> => undefined;

/**
 * An EnvironmentSetupService whose ready check does not really wait (its
 * `sleep` is instant unless the spec passes one), and whose boot does not
 * wait for room on a cell (capacityWaitMs 0) unless the spec asks. It
 * makes no repair of Kody's recipe (authorRepairs 0) unless the spec asks.
 */
export const testSetupService = (...[envs, store, opts]: ConstructorParameters<typeof EnvironmentSetupService>) =>
    new EnvironmentSetupService(envs, store, { sleep: instantSleep, capacityWaitMs: 0, authorRepairs: 0, ...opts });
