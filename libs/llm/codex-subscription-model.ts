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
const CODEX_PERSIST_ATTEMPTS = 3;
const CODEX_PERSIST_BACKOFF_MS = 50;

export interface CodexAuth {
    accessToken: string;
    accountId: string;
    refreshToken?: string;
    credentialId?: string;
    organizationId?: string;
    authPath?: string;
}

export interface RotatedCodexAuth {
    accessToken: string;
    refreshToken: string;
    accountId: string;
}

export class CodexCredentialRecoveryError extends Error {
    constructor(cause: unknown) {
        super(
            'Codex token rotation succeeded, but the replacement credentials could not be saved. Run `codex login` and reconnect the ChatGPT subscription credential.',
            { cause },
        );
        this.name = CodexCredentialRecoveryError.name;
    }
}

export interface CodexCredentialStore {
    rotateCodexTokens(input: {
        credentialId: string;
        organizationId: string;
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

export function clearCodexCredentialStore(store: CodexCredentialStore): void {
    if (credentialStore === store) {
        credentialStore = undefined;
    }
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
        const textByFragment = new Map<string, string>();
        const metadataByFragment = new Map<string, CodexProviderMetadata>();
        // Fragments and passthrough parts interleave: the Responses stream can
        // emit text, a tool call, then more text, and the replayed transcript
        // must preserve that order — emitting all fragments first would reorder
        // the conversation for agent loops.
        const orderedParts: Array<
            | { kind: 'fragment'; key: string }
            | {
                  kind: 'passthrough';
                  part: CodexGenerateResult['content'][number];
              }
        > = [];
        let finishReason: CodexGenerateResult['finishReason'] = {
            unified: 'stop',
            raw: undefined,
        };
        let usage = emptyUsage();
        let responseMetadata: NonNullable<CodexGenerateResult['response']> = {};
        let finishMetadata: CodexProviderMetadata | undefined;
        const warnings: CodexGenerateResult['warnings'] = [];

        const fragmentKey = (kind: 'text' | 'reasoning', id: string): string =>
            `${kind}:${id}`;
        const ensureFragment = (key: string): void => {
            if (!textByFragment.has(key)) {
                textByFragment.set(key, '');
                orderedParts.push({ kind: 'fragment', key });
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
                    const key = fragmentKey('text', value.id);
                    ensureFragment(key);
                    mergeMetadata(key, value.providerMetadata);
                    break;
                }
                case 'text-delta': {
                    const key = fragmentKey('text', value.id);
                    // A delta can arrive without a start part; register so
                    // ordered emission keeps it instead of dropping it.
                    ensureFragment(key);
                    appendFragment(key, value.delta);
                    mergeMetadata(key, value.providerMetadata);
                    break;
                }
                case 'text-end': {
                    const key = fragmentKey('text', value.id);
                    ensureFragment(key);
                    mergeMetadata(key, value.providerMetadata);
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
                    ensureFragment(key);
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
                    orderedParts.push({
                        kind: 'passthrough',
                        part: value,
                    });
                    break;
                case 'finish':
                    finishReason = value.finishReason;
                    usage = value.usage;
                    finishMetadata = value.providerMetadata;
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
        for (const entry of orderedParts) {
            if (entry.kind === 'passthrough') {
                content.push(entry.part);
                continue;
            }
            const key = entry.key;
            const text = textByFragment.get(key) ?? '';
            const providerMetadata = metadataByFragment.get(key);
            if (key.startsWith('reasoning:')) {
                if (!text && !providerMetadata) continue;
                content.push({
                    type: 'reasoning',
                    text,
                    ...(providerMetadata ? { providerMetadata } : {}),
                });
            } else if (text || providerMetadata) {
                content.push({
                    type: 'text',
                    text,
                    ...(providerMetadata ? { providerMetadata } : {}),
                });
            }
        }

        return {
            content,
            finishReason,
            usage,
            warnings,
            request,
            response: responseMetadata,
            ...(finishMetadata ? { providerMetadata: finishMetadata } : {}),
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

function validateRotatedAuthPersistence(auth: CodexAuth): void {
    if (!auth.refreshToken) {
        throw new Error('Codex token refresh requires a refresh token.');
    }
    if (auth.credentialId && !auth.organizationId) {
        throw new Error(
            'Codex credential persistence requires an organization scope.',
        );
    }
    if (auth.credentialId && !credentialStore) {
        throw new Error(
            'Codex credential persistence is not available in this process.',
        );
    }
    if (!auth.credentialId && !auth.authPath) {
        throw new Error(
            'Codex auth file persistence requires an explicit auth path.',
        );
    }
}

async function persistRotatedAuth(
    auth: CodexAuth,
    refreshed: { accessToken: string; refreshToken: string },
    store: CodexCredentialStore | undefined,
): Promise<RotatedCodexAuth> {
    if (!auth.refreshToken) {
        throw new Error('Codex token refresh requires a refresh token.');
    }
    if (auth.credentialId) {
        if (!auth.organizationId) {
            throw new Error(
                'Codex credential persistence requires an organization scope.',
            );
        }
        if (!store) {
            throw new Error(
                'Codex credential persistence is not available in this process.',
            );
        }
        return store.rotateCodexTokens({
            credentialId: auth.credentialId,
            organizationId: auth.organizationId,
            expectedRefreshToken: auth.refreshToken,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            accountId: auth.accountId,
        });
    }
    return persistCodexAuthFile(auth, refreshed);
}

async function persistRotatedAuthWithRetry(
    auth: CodexAuth,
    refreshed: { accessToken: string; refreshToken: string },
    store: CodexCredentialStore | undefined,
): Promise<RotatedCodexAuth> {
    let lastError: unknown;
    for (let attempt = 0; attempt < CODEX_PERSIST_ATTEMPTS; attempt++) {
        try {
            return await persistRotatedAuth(auth, refreshed, store);
        } catch (error) {
            lastError = error;
            if (attempt < CODEX_PERSIST_ATTEMPTS - 1) {
                await new Promise<void>((resolve) =>
                    setTimeout(
                        resolve,
                        CODEX_PERSIST_BACKOFF_MS * 2 ** attempt,
                    ),
                );
            }
        }
    }
    throw new CodexCredentialRecoveryError(lastError);
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
    // A rotation whose OAuth leg succeeded but whose persistence failed leaves
    // the ONLY valid refresh token in this field. The stale token was already
    // consumed server-side, so the next call must retry persistence — never the
    // exchange, which would burn the replacement and destroy the credential.
    let pendingRotation:
        | {
              stale: CodexAuth;
              refreshed: { accessToken: string; refreshToken: string };
          }
        | undefined;

    const auth = (): CodexAuth => {
        currentAuth ??= readCodexAuth();
        return currentAuth;
    };

    const refresh = async (stale: CodexAuth): Promise<CodexAuth> => {
        validateRotatedAuthPersistence(stale);
        // Captured at rotation start: module teardown can null the global store
        // mid-rotation, and the server-issued replacement must still reach the
        // store instance that validated the rotation.
        const store = credentialStore;
        if (!pendingRotation) {
            const refreshed = await requestCodexRefresh(
                stale.refreshToken ?? '',
            );
            pendingRotation = { stale, refreshed };
        }
        const persisted = await persistRotatedAuthWithRetry(
            pendingRotation.stale,
            pendingRotation.refreshed,
            store,
        );
        currentAuth = {
            accessToken: persisted.accessToken,
            refreshToken: persisted.refreshToken,
            accountId: persisted.accountId,
            credentialId: pendingRotation.stale.credentialId,
            organizationId: pendingRotation.stale.organizationId,
            authPath: pendingRotation.stale.authPath,
        };
        pendingRotation = undefined;
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
