/**
 * Shared Mongo gate for the integration suites.
 *
 * These suites gate themselves on an env var and quietly `describe.skip` when
 * it is missing. That is right on a dev machine with no Mongo — and was very
 * wrong in CI, where nothing ever set the var: every run reported green while
 * the suites never executed, and a real aggregation bug shipped behind them.
 *
 * So: skip locally, but make a CI run that lost its Mongo FAIL LOUDLY instead
 * of silently covering nothing.
 */

/** Truthy on GitHub Actions and every other mainstream CI. */
const isCI = (): boolean =>
    process.env.CI === 'true' || process.env.CI === '1';

export type MongoTestGate = {
    /** Whether this suite should describe.skip. Never true in CI. */
    shouldSkip: boolean;
    /** Connection string; only meaningful when shouldSkip is false. */
    mongoUri: string;
};

/**
 * @param dbName database to use when the env var is a bare host rather than a
 *               full connection string.
 * @param allowHostFallback some suites accept API_MG_DB_HOST as a fallback;
 *               the webhook suite does not, because that value is a
 *               docker-network hostname that never resolves from the runner.
 */
export const resolveMongoTestGate = (
    dbName = 'kodus_test',
    allowHostFallback = true,
): MongoTestGate => {
    const raw =
        process.env.TEST_MONGODB_URI ||
        (allowHostFallback ? process.env.API_MG_DB_HOST : undefined);

    if (!raw) {
        if (isCI()) {
            throw new Error(
                'TEST_MONGODB_URI is not set, so this Mongo integration suite ' +
                    'would silently skip. In CI that is a false green — the ' +
                    'suite must run. Set TEST_MONGODB_URI in the workflow ' +
                    '(see .github/workflows/tests.yml, "Run tests").',
            );
        }
        return { shouldSkip: true, mongoUri: '' };
    }

    return {
        shouldSkip: false,
        mongoUri: raw.includes('://') ? raw : `mongodb://${raw}:27017/${dbName}`,
    };
};
