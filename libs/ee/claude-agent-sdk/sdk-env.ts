/**
 * The whole environment of a Claude Agent SDK subprocess. The SDK replaces the
 * child's env with this object (it does not merge `process.env`), so nothing
 * from the worker leaks in: no provider key, no database URL, no token. The
 * only credential is the gateway session token, valid for this call.
 */
import type { SdkRoute } from './route';

export interface SdkEnvSession {
    /** Gateway origin + `/s/<token>`. */
    baseUrl: string;
    token: string;
    /** Per-session HOME and config dir, removed when the call ends. */
    home: string;
}

export interface SdkEnvOptions {
    maxOutputTokens?: number;
    /** Per-request timeout the CLI applies to the gateway. */
    apiTimeoutMs?: number;
    /** API retries inside the CLI (429/5xx); each one passes the gateway's envelope. */
    maxRetries?: number;
}

export const DEFAULT_SDK_MAX_RETRIES = 2;

export function buildSdkEnv(route: SdkRoute, session: SdkEnvSession, opts: SdkEnvOptions = {}): Record<string, string> {
    const env: Record<string, string> = {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: session.home,
        CLAUDE_CONFIG_DIR: session.home,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_MAX_RETRIES: String(opts.maxRetries ?? DEFAULT_SDK_MAX_RETRIES),
    };
    if (opts.apiTimeoutMs && opts.apiTimeoutMs > 0) env.API_TIMEOUT_MS = String(Math.round(opts.apiTimeoutMs));
    if (opts.maxOutputTokens && opts.maxOutputTokens > 0) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.round(opts.maxOutputTokens));
    if (!route.firstParty) env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';

    switch (route.format) {
        case 'anthropic':
            env.ANTHROPIC_BASE_URL = session.baseUrl;
            env.ANTHROPIC_API_KEY = session.token;
            break;
        case 'vertex':
            env.CLAUDE_CODE_USE_VERTEX = '1';
            env.CLAUDE_CODE_SKIP_VERTEX_AUTH = '1';
            env.ANTHROPIC_VERTEX_BASE_URL = `${session.baseUrl}/v1`;
            env.ANTHROPIC_VERTEX_PROJECT_ID = route.project;
            env.CLOUD_ML_REGION = route.region;
            break;
        case 'bedrock':
            env.CLAUDE_CODE_USE_BEDROCK = '1';
            env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1';
            env.ANTHROPIC_BEDROCK_BASE_URL = session.baseUrl;
            env.AWS_REGION = route.region;
            break;
    }
    return env;
}
