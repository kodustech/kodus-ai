// The HMAC secrets the dev composes default to (docker-compose.dev.yml).
// They are public in the repository, so a production process signing with
// one lets anyone mint what it signs: Run tokens, evidence URLs, upload
// grants. Shared by the API and the worker (review 2026-11-14, hardening
// notes; the worker's seal key has its own check, 61f12013d).

export const DEV_ONLY_SECRETS: Readonly<Record<string, string>> = {
    RUNTIME_RUN_TOKEN_SECRET: 'dev-only-runtime-run-token-secret-0000',
    RUNTIME_EVIDENCE_SIGNING_SECRET: 'dev-only-runtime-evidence-signing-secret-000000',
};

/** 32 characters at least: an HMAC-SHA256 key shorter than its output is easier to guess than the signature it makes. */
export const MIN_PRODUCTION_SECRET_LENGTH = 32;

/**
 * In production, a set secret that is a dev-only value (or any `dev-only-`
 * one), blank, or shorter than 32 characters stops the boot. An unset or
 * empty one stays off: the feature it signs for is then off and says so.
 * The value never reaches the error.
 */
export function assertProductionSecret(name: string, value: string | undefined, production: boolean): void {
    if (!production || value === undefined || value === '') return;
    if (value === DEV_ONLY_SECRETS[name] || value.trim().startsWith('dev-only-')) {
        throw new Error(`${name} is the dev-only value from docker-compose.dev.yml; production needs its own secret`);
    }
    if (value.trim().length < MIN_PRODUCTION_SECRET_LENGTH) {
        throw new Error(`${name} must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`);
    }
}
