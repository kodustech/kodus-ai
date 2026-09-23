import { DoctorCheck, DoctorContext, DoctorResult } from '../doctor.types';

const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/;

/**
 * Env the apps refuse to boot without, or boot with and then fail on every
 * webhook: crypto.ts:5, webhookTokenCrypto.ts:4, apps/webhooks/src/main.ts:60.
 */
export const bootEnvCheck: DoctorCheck = {
    id: 'env.boot',
    async run({ env }: DoctorContext): Promise<DoctorResult[]> {
        const results: DoctorResult[] = [];
        const fail = (title: string, fix: string) =>
            results.push({
                check: 'env.boot',
                status: 'fail',
                title,
                impact: 'Kodus cannot read stored Git credentials or accept Git events, so no review runs.',
                fix,
            });

        if (!HEX_32_BYTES.test(env.API_CRYPTO_KEY ?? '')) {
            fail(
                'The encryption key is missing or malformed.',
                'Set API_CRYPTO_KEY to 64 hex characters (openssl rand -hex 32). Changing it on an existing install makes stored tokens unreadable; restore the original value if you had one.',
            );
        }
        if (!HEX_32_BYTES.test(env.CODE_MANAGEMENT_SECRET ?? '')) {
            fail(
                'The webhook signing secret is missing or malformed.',
                'Set CODE_MANAGEMENT_SECRET to 64 hex characters (openssl rand -hex 32), then restart api and webhooks.',
            );
        }
        if (!env.CODE_MANAGEMENT_WEBHOOK_TOKEN?.trim()) {
            fail(
                'The webhook token is not set.',
                'Set CODE_MANAGEMENT_WEBHOOK_TOKEN, then restart api and webhooks.',
            );
        }
        const port = Number(env.API_WEBHOOKS_PORT);
        if (!Number.isInteger(port) || port <= 0) {
            fail(
                'The webhook service port is not set.',
                'Set API_WEBHOOKS_PORT (default 3332) and restart the webhooks service.',
            );
        }

        if (!results.length) {
            results.push({
                check: 'env.boot',
                status: 'ok',
                title: 'Required secrets and ports are set.',
            });
        }
        return results;
    },
};

/** Degradations and advisories that only need the env. */
export const configEnvCheck: DoctorCheck = {
    id: 'env.config',
    async run({ env }: DoctorContext): Promise<DoctorResult[]> {
        const results: DoctorResult[] = [];

        const webNodeEnv = env.WEB_NODE_ENV;
        if (webNodeEnv === undefined) {
            results.push({
                check: 'env.web_node_env',
                status: 'unknown',
                title: 'Could not see the web app mode from the API.',
                fix: 'Check that WEB_NODE_ENV=self-hosted is set for the web service.',
            });
        } else if (webNodeEnv !== 'self-hosted') {
            results.push({
                check: 'env.web_node_env',
                status: 'warn',
                title: 'The web app is not running in self-hosted mode.',
                impact: 'Settings pages behave as in Kodus Cloud: some self-hosted options are hidden and the update banner is off.',
                fix: `Set WEB_NODE_ENV=self-hosted (now "${webNodeEnv}") and restart the web service.`,
            });
        } else {
            results.push({
                check: 'env.web_node_env',
                status: 'ok',
                title: 'The web app runs in self-hosted mode.',
            });
        }

        // `error` is the installer's default (.env.schema API_LOG_LEVEL), so it
        // is advisory here: a clean install must not read as degraded.
        if ((env.API_LOG_LEVEL ?? '').toLowerCase() === 'error') {
            results.push({
                check: 'env.log_level',
                status: 'info',
                title: 'Logs only show errors.',
                impact: 'Reviews that are skipped or degraded log a warning, not an error, so the logs will not tell you why.',
                fix: 'While diagnosing, set API_LOG_LEVEL=warn (or info) and restart api and worker.',
            });
        } else {
            results.push({
                check: 'env.log_level',
                status: 'ok',
                title: `Logs include warnings (API_LOG_LEVEL=${env.API_LOG_LEVEL || 'info'}).`,
            });
        }

        const sandbox = (env.SANDBOX_PROVIDER ?? 'auto').toLowerCase();
        if (sandbox === 'null') {
            results.push({
                check: 'sandbox.mode',
                status: 'warn',
                title: 'The code sandbox is turned off.',
                impact: 'Kody reviews only the diff: no cross-file context and no checks that need the repository checked out.',
                fix: 'Remove SANDBOX_PROVIDER=null (auto uses the local sandbox, or E2B when API_E2B_KEY is set).',
            });
        } else {
            results.push({
                check: 'sandbox.mode',
                status: 'ok',
                title: `The code sandbox is on (${sandbox}).`,
            });
        }

        if (!env.API_E2B_KEY) {
            results.push({
                check: 'advisory.e2b',
                status: 'info',
                title: 'Remote sandbox (E2B) is not configured; the local sandbox is used.',
                fix: 'Optional: set API_E2B_KEY to run repository work in E2B instead of the worker container.',
            });
        } else {
            results.push({
                check: 'advisory.e2b',
                status: 'ok',
                title: 'Remote sandbox (E2B) is configured.',
            });
        }
        if (!env.API_EXA_KEY) {
            results.push({
                check: 'advisory.exa',
                status: 'info',
                title: 'Documentation search is off.',
                impact: 'Kody does not look up library documentation while reviewing.',
                fix: 'Optional: set API_EXA_KEY.',
            });
        } else {
            results.push({
                check: 'advisory.exa',
                status: 'ok',
                title: 'Documentation search is on.',
            });
        }
        if ((env.API_MCP_SERVER_ENABLED ?? 'false').toLowerCase() !== 'true') {
            results.push({
                check: 'advisory.mcp',
                status: 'info',
                title: 'MCP integrations are off (no Jira, Linear or other tracker context).',
                fix: 'Optional: set API_MCP_SERVER_ENABLED=true and run the kodus-mcp-manager service, then connect a tracker in Settings.',
            });
        } else {
            results.push({
                check: 'advisory.mcp',
                status: 'ok',
                title: 'MCP integrations are on.',
            });
        }
        if (!env.API_OPEN_AI_API_KEY) {
            results.push({
                check: 'advisory.dedup',
                status: 'info',
                title: 'Duplicate-suggestion filtering by similarity is off.',
                impact: 'Kody may post near-identical suggestions on the same PR.',
                fix: 'Optional: set API_OPEN_AI_API_KEY (used for embeddings).',
            });
        } else {
            results.push({
                check: 'advisory.dedup',
                status: 'ok',
                title: 'Duplicate-suggestion filtering by similarity is on.',
            });
        }

        const emailProvider = (
            env.API_NOTIFICATION_EMAIL_PROVIDER ?? 'resend'
        ).toLowerCase();
        const emailConfigured =
            emailProvider === 'smtp' ? !!env.SMTP_HOST : !!env.RESEND_API_KEY;
        if (!emailConfigured) {
            results.push({
                check: 'advisory.email',
                status: 'info',
                title: 'Email is not configured.',
                impact: 'Invites, password resets and notifications are not sent.',
                fix:
                    emailProvider === 'smtp'
                        ? 'Optional: set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM.'
                        : 'Optional: set RESEND_API_KEY, or API_NOTIFICATION_EMAIL_PROVIDER=smtp with the SMTP_* variables.',
            });
        } else {
            results.push({
                check: 'advisory.email',
                status: 'ok',
                title: `Email is configured (${emailProvider}).`,
            });
        }

        return results;
    },
};
