import type { EnvironmentSetupProgress, EnvironmentSetupRecord } from '@libs/runtime/run';

export const ENVIRONMENT_SETUP_STORE = Symbol('ENVIRONMENT_SETUP_STORE');

/** The latest setup of each environment (Environment Health reads it; a Run boots with its recipe). */
export interface EnvironmentSetupStore {
    get(environmentId: string): Promise<EnvironmentSetupRecord | null>;
    save(record: EnvironmentSetupRecord): Promise<void>;
    /**
     * Sets only the running boot's progress of that setup (key), outside the
     * workflow's journal: a live view, best effort; the setup's own saves
     * carry it from the boot's end.
     */
    saveProgress?(environmentId: string, key: string, progress: EnvironmentSetupProgress): Promise<void>;
}

/** The Runtime Postgres store (runtime.runtime_environment_setups), one row per environment (the latest setup). */
export { PgEnvironmentSetupStore } from '@libs/runtime/run/adapters/pg-environment-setup.store';

