import { EnvironmentSetupService } from '../worker/setup/environment-setup.service';

/** The ready check's wait between tries, made instant for specs. */
export const instantSleep = async (_ms: number): Promise<void> => undefined;

/**
 * An EnvironmentSetupService whose ready check does not really wait (its
 * `sleep` is instant unless the spec passes one), and whose boot does not
 * wait for room on a cell (capacityWaitMs 0) unless the spec asks.
 */
export const testSetupService = (...[envs, store, opts]: ConstructorParameters<typeof EnvironmentSetupService>) =>
    new EnvironmentSetupService(envs, store, { sleep: instantSleep, capacityWaitMs: 0, ...opts });
