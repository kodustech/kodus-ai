/**
 * ChatGPT/Codex subscription transport.
 *
 * The subscription endpoint only accepts streaming requests with `store: false`.
 * Kodus callers use both `doStream` and `doGenerate`, so this adapter drains the
 * stream for non-streaming calls while preserving the provider metadata needed to
 * round-trip retained reasoning across tool-call steps.
 */
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import fs from 'node:fs';
import path from 'node:path';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_REFRESH_SCOPE = 'openid profile email';

export interface CodexAuth {
    accessToken: string;
    accountId: string;
    refreshToken?: string;
    credentialId?: string;
    authPath?: string;
}

export interface RotatedCodexAuth {
    accessToken: string;
    refreshToken: string;
    accountId: string;
}

export interface CodexCredentialStore {
    rotateCodexTokens(input: {
        credentialId: string;
        expectedRefreshToken: string;
        accessToken: string;
        refreshToken: string;
        accountId: string;
    }): Promise<RotatedCodexAuth>;
}

let credentialStore: CodexCredentialStore | undefined;

export function setCodexCredentialStore(
    store: CodexCredentialStore | undefined,
): void {
    credentialStore = store;
}

type CodexProviderModel = ReturnType<
    ReturnType<typeof createOpenAI>['responses']
>;
type CodexSdkModel = Pick<
    CodexProviderModel,
    | 'specificationVersion'
    | 'provider'
    | 'modelId'
    | 'supportedUrls'
    | 'doGenerate'
    | 'doStream'
>;
type CodexCallOptions = Parameters<CodexSdkModel['doStream']>[0];
type CodexStreamResult = Awaited<ReturnType<CodexSdkModel['doStream']>>;
type CodexGenerateResult = Awaited<ReturnType<CodexSdkModel['doGenerate']>>;
type CodexContent = CodexGenerateResult['content'][number];
type CodexProviderMetadata = Extract<
    CodexContent,
    { type: 'reasoning' }
>['providerMetadata'];

interface CodexModelOptions {
    retainReasoning?: boolean;
}

interface CodexAuthFile {
    auth_mode?: unknown;
    tokens?: {
        access_token?: unknown;
        refresh_token?: unknown;
        account_id?: unknown;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseCodexAuthFile(
    raw: string,
    authPath: string,
): {
    document: CodexAuthFile;
    auth: CodexAuth;
} {
    const document = JSON.parse(raw) as CodexAuthFile;
    const accessToken = nonEmptyString(document.tokens?.access_token);
    const accountId = nonEmptyString(document.tokens?.account_id);
    const refreshToken = nonEmptyString(document.tokens?.refresh_token);
    if (!accessToken || !accountId) {
        throw new Error(
            `Codex auth is incomplete at ${authPath}; run \`codex login\` (auth_mode=${String(document.auth_mode ?? 'unknown')}).`,
        );
    }
    return {
        document,
        auth: { accessToken, accountId, refreshToken, authPath },
    };
}

/** Read Codex CLI OAuth credentials from the explicitly configured dev file. */
export function readCodexAuth(
    authPath = process.env.API_CODEX_AUTH_FILE,
): CodexAuth {
    if (!authPath) {
        throw new Error(
            'ChatGPT subscription credentials are not configured. Save them in BYOK settings or set API_CODEX_AUTH_FILE to an explicit bind-mounted auth.json path.',
        );
    }
    return parseCodexAuthFile(fs.readFileSync(authPath, 'utf8'), authPath).auth;
}

function codexFetch(retainReasoning: boolean): typeof fetch {
    return (input, init) => {
        if (retainReasoning || typeof init?.body !== 'string') {
            return fetch(input, init);
        }
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (!Array.isArray(body.include)) {
            return fetch(input, init);
        }
        const include = body.include.filter(
            (entry) => entry !== 'reasoning.encrypted_content',
        );
        if (include.length === body.include.length) {
            return fetch(input, init);
        }
        if (include.length === 0) {
            delete body.include;
        } else {
            body.include = include;
        }
        return fetch(input, { ...init, body: JSON.stringify(body) });
    };
}

function createCodexSdkModel(
    modelId: string,
    auth: CodexAuth,
    retainReasoning = true,
): CodexSdkModel {
    const provider = createOpenAI({
        apiKey: auth.accessToken,
        baseURL: CODEX_BASE_URL,
        headers: {
            'chatgpt-account-id': auth.accountId,
            'OpenAI-Beta': 'responses=experimental',
            'originator': 'codex_cli_rs',
        },
        fetch: codexFetch(retainReasoning),
    });
    return provider.responses(modelId);
}

function codexCallOptions(
    options: CodexCallOptions,
    retainReasoning: boolean,
): CodexCallOptions {
    const {
        temperature: _temperature,
        maxOutputTokens: _maxOutputTokens,
        ...supported
    } = options;
    const { include: _include, ...openAiOptions } =
        supported.providerOptions?.openai ?? {};
    return {
        ...supported,
        providerOptions: {
            ...(supported.providerOptions ?? {}),
            openai: {
                ...openAiOptions,
                store: false,
                ...(retainReasoning
                    ? { include: ['reasoning.encrypted_content'] }
                    : {}),
            },
        },
    };
}

function emptyUsage(): CodexGenerateResult['usage'] {
    return {
        inputTokens: {
            total: undefined,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
        },
        outputTokens: {
            total: undefined,
            text: undefined,
            reasoning: undefined,
        },
    };
}

/**
 * Add a non-streaming implementation to a streaming model. Exported for focused
 * transport tests; product callers use `buildCodexSubscriptionModel`.
 */
export function withGenerateFromStream(model: CodexSdkModel): LanguageModel {
    const doStream = (
        options: CodexCallOptions,
    ): PromiseLike<CodexStreamResult> => model.doStream(options);

    const doGenerate = async (
        options: CodexCallOptions,
    ): Promise<CodexGenerateResult> => {
        const { stream, request } = await doStream(options);
        const passthroughContent: CodexGenerateResult['content'] = [];
        const textByFragment = new Map<string, string>();
        const metadataByFragment = new Map<string, CodexProviderMetadata>();
        let finishReason: CodexGenerateResult['finishReason'] = {
            unified: 'stop',
            raw: undefined,
        };
        let usage = emptyUsage();
        let responseMetadata: NonNullable<CodexGenerateResult['response']> = {};
        const warnings: CodexGenerateResult['warnings'] = [];

        const fragmentKey = (kind: 'text' | 'reasoning', id: string): string =>
            `${kind}:${id}`;
        const ensureFragment = (key: string): void => {
            if (!textByFragment.has(key)) {
                textByFragment.set(key, '');
            }
        };
        const appendFragment = (key: string, delta: string): void => {
            textByFragment.set(key, (textByFragment.get(key) ?? '') + delta);
        };
        const mergeMetadata = (
            key: string,
            metadata: CodexProviderMetadata,
        ): void => {
            if (metadata) {
                const previous = metadataByFragment.get(key) ?? {};
                const merged = { ...previous };
                for (const [provider, providerMetadata] of Object.entries(
                    metadata,
                )) {
                    merged[provider] = {
                        ...(previous[provider] ?? {}),
                        ...providerMetadata,
                    };
                }
                metadataByFragment.set(key, merged);
            }
        };

        const reader = stream.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            switch (value.type) {
                case 'text-start': {
                    ensureFragment(fragmentKey('text', value.id));
                    break;
                }
                case 'text-delta': {
                    const key = fragmentKey('text', value.id);
                    appendFragment(key, value.delta);
                    break;
                }
                case 'reasoning-start':
                case 'reasoning-end': {
                    const key = fragmentKey('reasoning', value.id);
                    ensureFragment(key);
                    mergeMetadata(key, value.providerMetadata);
                    break;
                }
                case 'reasoning-delta': {
                    const key = fragmentKey('reasoning', value.id);
                    appendFragment(key, value.delta);
                    mergeMetadata(key, value.providerMetadata);
                    break;
                }
                case 'tool-call':
                case 'tool-result':
                case 'tool-approval-request':
                case 'custom':
                case 'file':
                case 'reasoning-file':
                case 'source':
                    passthroughContent.push(value);
                    break;
                case 'finish':
                    finishReason = value.finishReason;
                    usage = value.usage;
                    break;
                case 'response-metadata':
                    responseMetadata = {
                        ...responseMetadata,
                        ...(value.id === undefined ? {} : { id: value.id }),
                        ...(value.timestamp === undefined
                            ? {}
                            : { timestamp: value.timestamp }),
                        ...(value.modelId === undefined
                            ? {}
                            : { modelId: value.modelId }),
                    };
                    break;
                case 'stream-start':
                    warnings.push(...value.warnings);
                    break;
                case 'error':
                    throw value.error instanceof Error
                        ? value.error
                        : new Error(JSON.stringify(value.error));
            }
        }

        const content: CodexGenerateResult['content'] = [];
        for (const [key, text] of textByFragment) {
            if (key.startsWith('reasoning:')) {
                const providerMetadata = metadataByFragment.get(key);
                if (!text && !providerMetadata) continue;
                content.push({
                    type: 'reasoning',
                    text,
                    ...(providerMetadata ? { providerMetadata } : {}),
                });
            } else if (text) {
                content.push({ type: 'text', text });
            }
        }
        content.push(...passthroughContent);

        return {
            content,
            finishReason,
            usage,
            warnings,
            request,
            response: responseMetadata,
        };
    };

    return {
        specificationVersion: model.specificationVersion,
        provider: model.provider,
        modelId: model.modelId,
        supportedUrls: model.supportedUrls,
        doStream,
        doGenerate,
    };
}

function errorStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const candidate = error as {
        statusCode?: unknown;
        status?: unknown;
        response?: { status?: unknown };
    };
    for (const status of [
        candidate.statusCode,
        candidate.status,
        candidate.response?.status,
    ]) {
        if (typeof status === 'number') return status;
    }
    return undefined;
}

function isAuthenticationError(error: unknown): boolean {
    const status = errorStatus(error);
    return status === 401 || status === 403;
}

interface RefreshResponse {
    access_token?: unknown;
    refresh_token?: unknown;
}

async function requestCodexRefresh(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
}> {
    const response = await fetch(CODEX_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: CODEX_CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            scope: CODEX_REFRESH_SCOPE,
        }),
    });
    const raw = await response.text();
    if (!response.ok) {
        throw new Error(
            `Codex token refresh failed with HTTP ${response.status}: ${raw}`,
        );
    }
    const parsed = JSON.parse(raw) as RefreshResponse;
    const accessToken = nonEmptyString(parsed.access_token);
    const rotatedRefreshToken = nonEmptyString(parsed.refresh_token);
    if (!accessToken || !rotatedRefreshToken) {
        throw new Error('Codex token refresh returned incomplete credentials.');
    }
    return { accessToken, refreshToken: rotatedRefreshToken };
}

function persistCodexAuthFile(
    auth: CodexAuth,
    refreshed: { accessToken: string; refreshToken: string },
): RotatedCodexAuth {
    const authPath = auth.authPath;
    if (!authPath) {
        throw new Error(
            'Codex auth file persistence requires an explicit auth path.',
        );
    }
    const current = parseCodexAuthFile(
        fs.readFileSync(authPath, 'utf8'),
        authPath,
    );
    if (current.auth.refreshToken !== auth.refreshToken) {
        return {
            accessToken: current.auth.accessToken,
            refreshToken: current.auth.refreshToken ?? '',
            accountId: current.auth.accountId,
        };
    }
    const document: CodexAuthFile = {
        ...current.document,
        tokens: {
            ...(current.document.tokens ?? {}),
            access_token: refreshed.accessToken,
            refresh_token: refreshed.refreshToken,
            account_id: auth.accountId,
        },
    };
    const temporaryPath = path.join(
        path.dirname(authPath),
        `.${path.basename(authPath)}.${process.pid}.tmp`,
    );
    fs.writeFileSync(temporaryPath, JSON.stringify(document), { mode: 0o600 });
    fs.renameSync(temporaryPath, authPath);
    return { ...refreshed, accountId: auth.accountId };
}

async function persistRotatedAuth(
    auth: CodexAuth,
    refreshed: { accessToken: string; refreshToken: string },
): Promise<RotatedCodexAuth> {
    if (!auth.refreshToken) {
        throw new Error('Codex token refresh requires a refresh token.');
    }
    if (auth.credentialId) {
        if (!credentialStore) {
            throw new Error(
                'Codex credential persistence is not available in this process.',
            );
        }
        return credentialStore.rotateCodexTokens({
            credentialId: auth.credentialId,
            expectedRefreshToken: auth.refreshToken,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            accountId: auth.accountId,
        });
    }
    return persistCodexAuthFile(auth, refreshed);
}

/**
 * Build a ChatGPT subscription model without reading credentials. Credentials are
 * resolved only when the first request starts, which keeps registry conformance
 * and provider discovery offline-safe.
 */
export function buildCodexSubscriptionModel(
    modelId: string,
    configuredAuth?: CodexAuth,
    options: CodexModelOptions = {},
): LanguageModel {
    const placeholder = createCodexSdkModel(modelId, {
        accessToken: 'codex-lazy-auth',
        accountId: 'codex-lazy-account',
    });
    let currentAuth = configuredAuth;
    let refreshInFlight: Promise<CodexAuth> | undefined;

    const auth = (): CodexAuth => {
        currentAuth ??= readCodexAuth();
        return currentAuth;
    };

    const refresh = async (stale: CodexAuth): Promise<CodexAuth> => {
        const refreshed = await requestCodexRefresh(stale.refreshToken ?? '');
        const persisted = await persistRotatedAuth(stale, refreshed);
        currentAuth = {
            accessToken: persisted.accessToken,
            refreshToken: persisted.refreshToken,
            accountId: persisted.accountId,
            credentialId: stale.credentialId,
            authPath: stale.authPath,
        };
        return currentAuth;
    };

    const doStream = async (
        callOptions: CodexCallOptions,
    ): Promise<CodexStreamResult> => {
        const prepared = codexCallOptions(
            callOptions,
            options.retainReasoning !== false,
        );
        const initialAuth = auth();
        const retainReasoning = options.retainReasoning !== false;
        try {
            return await createCodexSdkModel(
                modelId,
                initialAuth,
                retainReasoning,
            ).doStream(prepared);
        } catch (error) {
            if (!isAuthenticationError(error) || !initialAuth.refreshToken) {
                throw error;
            }
            refreshInFlight ??= refresh(initialAuth).finally(() => {
                refreshInFlight = undefined;
            });
            const refreshedAuth = await refreshInFlight;
            return createCodexSdkModel(
                modelId,
                refreshedAuth,
                retainReasoning,
            ).doStream(prepared);
        }
    };

    return withGenerateFromStream({
        specificationVersion: placeholder.specificationVersion,
        provider: placeholder.provider,
        modelId: placeholder.modelId,
        supportedUrls: placeholder.supportedUrls,
        doStream,
        doGenerate: placeholder.doGenerate.bind(placeholder),
    });
}

export const CODEX_PROVIDER_OPTIONS = { openai: { store: false } } as const;
