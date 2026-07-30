import {
    anthropicCompatibleRootURL,
    BYOKProvider,
} from '@kodus/kodus-common/llm';
import { ProviderService } from '@libs/core/infrastructure/services/providers/provider.service';
import { createLogger } from '@libs/core/log/logger';
import { BadRequestException, Injectable } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { lookup } from 'dns/promises';

/**
 * Cloud regions follow tight naming rules (AWS: us-east-1, GCP:
 * us-central1). We only accept that shape when building URLs with
 * user-provided regions so an attacker can't smuggle path traversal or
 * hostname injection through the region field (e.g. "evil.com/?").
 */
const REGION_PATTERN = /^[a-z0-9-]{2,32}$/;

function assertSafeRegion(region: string): void {
    if (!REGION_PATTERN.test(region)) {
        throw new BadRequestException(
            `Invalid region "${region}". Expected lowercase letters, digits, or hyphens.`,
        );
    }
}

/**
 * Guard user-provided base URLs against SSRF before making outbound
 * HTTP calls:
 *   - Require https:// (reject http:, file:, javascript:, etc.)
 *   - Resolve the hostname and reject any loopback / link-local /
 *     RFC1918 private address (including IPv6 equivalents). Stops an
 *     authenticated caller from probing internal infra, the cloud
 *     metadata service (169.254.169.254), or localhost services.
 *
 * There is a small TOCTOU window between the lookup and the actual
 * axios.get — acceptable for a one-shot test probe that doesn't leak
 * response bodies back to the user.
 */
export async function assertSafeOpenAICompatibleUrl(
    rawUrl: string,
): Promise<void> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new BadRequestException('baseURL is not a valid URL.');
    }
    if (parsed.protocol !== 'https:') {
        throw new BadRequestException(
            'baseURL must use https:// for security.',
        );
    }
    let addresses: Array<{ address: string; family: number }>;
    try {
        addresses = await lookup(parsed.hostname, { all: true });
    } catch {
        throw new BadRequestException(
            `Couldn't resolve host "${parsed.hostname}". Check the base URL.`,
        );
    }
    for (const { address } of addresses) {
        if (isPrivateOrReservedIp(address)) {
            throw new BadRequestException(
                `baseURL resolves to a private or reserved address (${address}). Point it at a public provider endpoint.`,
            );
        }
    }
}

function isPrivateOrReservedIp(ip: string): boolean {
    // IPv4
    if (ip === '0.0.0.0' || ip.startsWith('127.')) return true; // loopback / unspecified
    if (ip.startsWith('10.')) return true; // RFC1918
    if (ip.startsWith('192.168.')) return true; // RFC1918
    if (ip.startsWith('169.254.')) return true; // link-local (incl. cloud metadata)
    if (ip.startsWith('100.64.')) return true; // CGNAT
    const m172 = ip.match(/^172\.(\d+)\./);
    if (m172) {
        const n = parseInt(m172[1], 10);
        if (n >= 16 && n <= 31) return true; // RFC1918
    }
    // IPv6
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true; // fc00::/7 ULA
    if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true; // fe80::/10 link-local
    return false;
}

export type TestByokResultCode =
    | 'ok'
    | 'auth'
    | 'not_found'
    | 'bad_request'
    | 'payment'
    | 'rate_limit'
    | 'server_error'
    | 'network'
    | 'unknown';

export type TestByokResult = {
    ok: boolean;
    code: TestByokResultCode;
    latencyMs: number;
    /** Short, user-friendly explanation of the failure. */
    message?: string;
    /** Raw error message surfaced by the provider (e.g. "model 'x' does not exist"). */
    providerMessage?: string;
    /** HTTP status returned by the provider, when applicable. */
    httpStatus?: number;
};

type TestByokInput = {
    provider: string;
    apiKey?: string;
    baseURL?: string;
    model?: string;
    vertexLocation?: string;
    awsBearerToken?: string;
    awsAccessKeyId?: string;
    awsSecretAccessKey?: string;
    awsRegion?: string;
    awsSessionToken?: string;
};

const TEST_TIMEOUT_MS = 15_000;

@Injectable()
export class TestByokConnectionUseCase {
    private readonly logger = createLogger(TestByokConnectionUseCase.name);

    constructor(private readonly providerService: ProviderService) {}

    async execute(input: TestByokInput): Promise<TestByokResult> {
        const { provider, apiKey, baseURL } = input;

        if (!this.providerService.isProviderSupported(provider)) {
            throw new BadRequestException(`Unsupported provider: ${provider}`);
        }

        const byokProvider = provider as BYOKProvider;

        // Vertex: SA JSON (apiKey) + optional location. Validate auth via
        // google-auth-library getAccessToken() then probe the regional
        // Vertex endpoint — mirrors what the real LLM call will do.
        if (byokProvider === BYOKProvider.GOOGLE_VERTEX) {
            if (!apiKey?.trim()) {
                throw new BadRequestException(
                    'apiKey (service account JSON, raw or base64-encoded) is required for Google Vertex',
                );
            }
            return await this.testVertex(
                apiKey,
                input.vertexLocation,
                input.model,
            );
        }

        // Bedrock: prefer the bearer API key path (2025+ auth). Fall back
        // to static IAM user creds (SigV4) when no bearer token is given.
        if (byokProvider === BYOKProvider.AMAZON_BEDROCK) {
            const region = input.awsRegion?.trim() || 'us-east-1';

            if (input.awsBearerToken?.trim()) {
                return await this.testBedrockBearer(
                    input.awsBearerToken.trim(),
                    region,
                );
            }

            if (
                !input.awsAccessKeyId?.trim() ||
                !input.awsSecretAccessKey?.trim()
            ) {
                throw new BadRequestException(
                    'Provide either a Bedrock API key (awsBearerToken) or IAM user credentials (awsAccessKeyId + awsSecretAccessKey).',
                );
            }
            return await this.testBedrockSigV4({
                accessKeyId: input.awsAccessKeyId,
                secretAccessKey: input.awsSecretAccessKey,
                sessionToken: input.awsSessionToken,
                region,
            });
        }

        if (!apiKey?.trim()) {
            throw new BadRequestException('apiKey is required');
        }

        if (
            byokProvider === BYOKProvider.OPENAI_COMPATIBLE &&
            !baseURL?.trim()
        ) {
            throw new BadRequestException(
                'baseURL is required for openai_compatible',
            );
        }

        // Anthropic-compatible: probe the real /v1/messages endpoint with a
        // 1-token request instead of /v1/models. Some vendors gate the two
        // differently — Kimi Code's models list is open while chat is
        // restricted — so a models-list probe can report "connection OK"
        // for a key whose actual reviews would fail.
        if (byokProvider === BYOKProvider.ANTHROPIC_COMPATIBLE) {
            if (!baseURL?.trim()) {
                throw new BadRequestException(
                    'baseURL is required for anthropic_compatible',
                );
            }
            return await this.testAnthropicCompatible(
                apiKey,
                baseURL,
                input.model,
            );
        }

        const { url, headers } = this.buildProbeRequest(byokProvider, apiKey, baseURL);

        // SSRF guard: only openai_compatible consumes a user-provided
        // base URL here; the other providers hardcode their endpoints.
        if (byokProvider === BYOKProvider.OPENAI_COMPATIBLE) {
            await assertSafeOpenAICompatibleUrl(url);
        }

        const start = Date.now();

        try {
            await axios.get(url, {
                headers,
                timeout: TEST_TIMEOUT_MS,
                maxRedirects: 0, // don't follow redirects: could lead back to a private IP
            });
            return {
                ok: true,
                code: 'ok',
                latencyMs: Date.now() - start,
            };
        } catch (err) {
            const latencyMs = Date.now() - start;
            return this.normalizeError(err, latencyMs);
        }
    }

    /**
     * Validate an Anthropic-compatible endpoint (Kimi Code, Z.ai, DeepSeek)
     * by sending a minimal 1-token /v1/messages request — the same call the
     * real review path makes. Falls back to GET /v1/models when no model is
     * provided, accepting the weaker signal.
     */
    private async testAnthropicCompatible(
        apiKey: string,
        baseURL: string,
        model?: string,
    ): Promise<TestByokResult> {
        const root = anthropicCompatibleRootURL(baseURL);

        // SSRF guard: user-provided base URL, same rules as openai_compatible.
        await assertSafeOpenAICompatibleUrl(root);

        const headers = {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
        };

        const start = Date.now();
        try {
            if (model?.trim()) {
                await axios.post(
                    `${root}/v1/messages`,
                    {
                        model: model.trim(),
                        max_tokens: 1,
                        messages: [{ role: 'user', content: 'ping' }],
                    },
                    {
                        headers,
                        timeout: TEST_TIMEOUT_MS,
                        maxRedirects: 0,
                    },
                );
            } else {
                await axios.get(`${root}/v1/models`, {
                    headers,
                    timeout: TEST_TIMEOUT_MS,
                    maxRedirects: 0,
                });
            }
            return {
                ok: true,
                code: 'ok',
                latencyMs: Date.now() - start,
            };
        } catch (err) {
            return this.normalizeError(err, Date.now() - start);
        }
    }

    /**
     * Validate a Google Vertex BYOK config end-to-end: parse the SA JSON,
     * exchange it for an access token, and — crucially — probe the *actual
     * configured model* with a 1-token call on the same endpoint the review
     * uses (claude-* → publishers/anthropic :rawPredict; otherwise
     * publishers/google :generateContent). This surfaces "model not
     * available in this region" at Test time instead of mid-review, which
     * is the whole point of the Test button.
     */
    private async testVertex(
        saJsonOrBase64: string,
        location?: string,
        modelId?: string,
    ): Promise<TestByokResult> {
        const start = Date.now();

        // Accept the SA key as raw JSON (pasted file contents) or as
        // base64-encoded JSON. base64 of a JSON object always starts with
        // `ey` (from `{"`); raw JSON starts with `{`, so the leading char
        // disambiguates the two forms unambiguously.
        let credentials: { project_id?: string; client_email?: string };
        try {
            const trimmed = (saJsonOrBase64 || '').trim();
            const decoded = trimmed.startsWith('{')
                ? trimmed
                : Buffer.from(trimmed, 'base64').toString('utf-8');
            credentials = JSON.parse(decoded);
        } catch {
            return {
                ok: false,
                code: 'bad_request',
                latencyMs: Date.now() - start,
                message:
                    "The service account key isn't valid JSON (or base64-encoded JSON). Paste the contents of your service account JSON file.",
            };
        }

        if (!credentials.project_id) {
            return {
                ok: false,
                code: 'bad_request',
                latencyMs: Date.now() - start,
                message:
                    "The service account JSON doesn't contain a project_id. Make sure you're pasting a valid GCP service account key, not an OAuth client or AI Studio key.",
            };
        }

        try {
            const { GoogleAuth } = await import('google-auth-library');
            const auth = new GoogleAuth({
                credentials: credentials as any,
                scopes: ['https://www.googleapis.com/auth/cloud-platform'],
            });
            const client = await auth.getClient();
            // Default to the global endpoint — serves all Claude + Gemini
            // models on Vertex, so users don't need to know per-model region
            // availability (us-central1 doesn't serve Claude).
            const region = location?.trim() || 'global';
            assertSafeRegion(region);
            // GCP project IDs: 6-30 chars, lowercase letters/digits/hyphens,
            // must start with a letter. Sanity-check the SA key's project.
            if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(credentials.project_id)) {
                return {
                    ok: false,
                    code: 'bad_request',
                    latencyMs: Date.now() - start,
                    message:
                        'The service account JSON has an unusual project_id. Expected lowercase letters, digits, and hyphens.',
                };
            }
            // Global endpoint has no region prefix; regional endpoints do.
            const host =
                region === 'global'
                    ? 'aiplatform.googleapis.com'
                    : `${region}-aiplatform.googleapis.com`;
            const projectPath = `projects/${credentials.project_id}/locations/${region}`;
            const model = (modelId || '').trim();

            // No model to validate (shouldn't happen for BYOK) → fall back to
            // a pure auth/API-enabled probe via ListModels.
            if (!model) {
                const res = await client.request({
                    url: `https://${host}/v1/${projectPath}/models?pageSize=1`,
                    method: 'GET',
                    timeout: TEST_TIMEOUT_MS,
                });
                return {
                    ok: true,
                    code: 'ok',
                    latencyMs: Date.now() - start,
                    httpStatus: res.status,
                };
            }

            // Guard the model id before putting it in the URL path.
            if (!/^[a-zA-Z0-9][a-zA-Z0-9._@-]*$/.test(model)) {
                return {
                    ok: false,
                    code: 'bad_request',
                    latencyMs: Date.now() - start,
                    message: `"${model}" doesn't look like a valid Vertex model id.`,
                };
            }

            // Probe the REAL model with a 1-token call on the same endpoint
            // the review uses, so an unavailable model/region fails here.
            const isClaude = /^claude[-_]/i.test(model);
            const publisher = isClaude ? 'anthropic' : 'google';
            const verb = isClaude ? 'rawPredict' : 'generateContent';
            const probeUrl = `https://${host}/v1/${projectPath}/publishers/${publisher}/models/${model}:${verb}`;
            const data = isClaude
                ? {
                      anthropic_version: 'vertex-2023-10-16',
                      messages: [{ role: 'user', content: 'ping' }],
                      max_tokens: 1,
                  }
                : {
                      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
                      generationConfig: { maxOutputTokens: 1 },
                  };

            try {
                const res = await client.request({
                    url: probeUrl,
                    method: 'POST',
                    data,
                    timeout: TEST_TIMEOUT_MS,
                });
                return {
                    ok: true,
                    code: 'ok',
                    latencyMs: Date.now() - start,
                    httpStatus: res.status,
                };
            } catch (probeErr) {
                const status =
                    (probeErr as any)?.response?.status ??
                    (probeErr as any)?.status ??
                    (probeErr as any)?.code;
                if (status === 404) {
                    // Vertex returns 404 NOT_FOUND both when the model doesn't
                    // exist in the region AND when the project hasn't enabled
                    // it. The latter is the common case for Anthropic models
                    // (each must be enabled in Model Garden first), so guide
                    // the user there.
                    const provider = isClaude ? 'Anthropic' : 'Google';
                    return {
                        ok: false,
                        code: 'bad_request',
                        latencyMs: Date.now() - start,
                        message: `Your Google Cloud project doesn't have access to "${model}" in region "${region}". Enable it for the project in Vertex AI Model Garden (search "${provider}" → the model → "Enable"/accept terms), then test again. If it's already enabled, double-check the model id and region.`,
                    };
                }
                throw probeErr; // 401/403/429/5xx → normalizeError below
            }
        } catch (err) {
            return this.normalizeError(err, Date.now() - start);
        }
    }

    /**
     * Validate a Bedrock API key (bearer token) by probing the Bedrock
     * ListFoundationModels endpoint with `Authorization: Bearer <token>`.
     * The modern, recommended auth path for Bedrock.
     */
    private async testBedrockBearer(
        token: string,
        region: string,
    ): Promise<TestByokResult> {
        assertSafeRegion(region);
        const start = Date.now();
        try {
            const url = `https://bedrock.${region}.amazonaws.com/foundation-models`;
            const res = await fetch(url, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${token}`,
                },
                signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
            });

            if (res.ok) {
                return {
                    ok: true,
                    code: 'ok',
                    latencyMs: Date.now() - start,
                    httpStatus: res.status,
                };
            }

            const body = await res.text().catch(() => '');
            return this.buildBedrockError(res.status, body, start, region);
        } catch (err) {
            return this.normalizeError(err, Date.now() - start);
        }
    }

    /**
     * Validate AWS IAM credentials by calling STS GetCallerIdentity — a
     * free, universally-available call that confirms the keys are live
     * without requiring any Bedrock model access. Used as fallback when
     * the user is on static IAM auth instead of Bedrock API keys.
     */
    private async testBedrockSigV4(creds: {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
        region: string;
    }): Promise<TestByokResult> {
        assertSafeRegion(creds.region);
        const start = Date.now();
        try {
            const { AwsClient } = await import('aws4fetch');
            const client = new AwsClient({
                accessKeyId: creds.accessKeyId,
                secretAccessKey: creds.secretAccessKey,
                sessionToken: creds.sessionToken,
                region: creds.region,
                service: 'sts',
            });
            // STS global endpoint — GetCallerIdentity has no regional
            // authorization nuance and returns 200 for any valid signer.
            const stsUrl =
                'https://sts.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15';
            const res = await client.fetch(stsUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
            });

            if (!res.ok) {
                const body = await res.text().catch(() => '');
                return this.buildBedrockError(res.status, body, start);
            }

            // Keys are valid. Also verify the region is a known Bedrock
            // region by probing the service endpoint (cheap HEAD call).
            const bedrockClient = new AwsClient({
                accessKeyId: creds.accessKeyId,
                secretAccessKey: creds.secretAccessKey,
                sessionToken: creds.sessionToken,
                region: creds.region,
                service: 'bedrock',
            });
            const bedrockUrl = `https://bedrock.${creds.region}.amazonaws.com/foundation-models`;
            const bedrockRes = await bedrockClient.fetch(bedrockUrl, {
                method: 'GET',
            });

            if (!bedrockRes.ok && bedrockRes.status !== 200) {
                const body = await bedrockRes.text().catch(() => '');
                // 403 on Bedrock typically means the user doesn't have
                // bedrock:ListFoundationModels IAM perm — still an auth
                // success from STS's POV. Surface as a warning.
                if (bedrockRes.status === 403) {
                    return {
                        ok: true,
                        code: 'ok',
                        latencyMs: Date.now() - start,
                        httpStatus: 200,
                        message:
                            'STS credentials work but Bedrock ListFoundationModels returned 403. Kodus can still call models if the InvokeModel permission is granted — this is usually fine.',
                    };
                }
                return this.buildBedrockError(
                    bedrockRes.status,
                    body,
                    start,
                    creds.region,
                );
            }

            return {
                ok: true,
                code: 'ok',
                latencyMs: Date.now() - start,
                httpStatus: 200,
            };
        } catch (err) {
            return this.normalizeError(err, Date.now() - start);
        }
    }

    private buildBedrockError(
        status: number,
        body: string,
        start: number,
        region?: string,
    ): TestByokResult {
        const providerMessage =
            this.extractProviderMessage(this.parseXmlOrJson(body)) ||
            body.slice(0, 300) ||
            undefined;
        const latencyMs = Date.now() - start;
        const base = { latencyMs, httpStatus: status, providerMessage };

        if (status === 401 || status === 403) {
            return {
                ok: false,
                code: 'auth',
                ...base,
                message:
                    'AWS rejected the credentials. Check that accessKeyId / secretAccessKey are correct and active, and that the IAM user or role is allowed to call STS and Bedrock.',
            };
        }
        if (status === 404) {
            return {
                ok: false,
                code: 'not_found',
                ...base,
                message: region
                    ? `Bedrock is not reachable at region "${region}". Confirm Bedrock is enabled in that region for your account.`
                    : 'Bedrock endpoint not found.',
            };
        }
        return {
            ok: false,
            code: 'server_error',
            ...base,
            message: `AWS returned HTTP ${status} when validating credentials.`,
        };
    }

    private parseXmlOrJson(body: string): unknown {
        if (!body) return null;
        try {
            return JSON.parse(body);
        } catch {
            // AWS sometimes returns XML — extract the first <Message> block
            const match = body.match(/<Message>([^<]+)<\/Message>/);
            return match ? { message: match[1] } : null;
        }
    }

    private buildProbeRequest(
        provider: BYOKProvider,
        apiKey: string,
        baseURL?: string,
    ): { url: string; headers: Record<string, string> } {
        switch (provider) {
            case BYOKProvider.OPENAI:
                return {
                    url: 'https://api.openai.com/v1/models',
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                };

            case BYOKProvider.ANTHROPIC:
                return {
                    url: 'https://api.anthropic.com/v1/models',
                    headers: {
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01',
                        'Content-Type': 'application/json',
                    },
                };

            case BYOKProvider.GOOGLE_GEMINI:
                return {
                    url: 'https://generativelanguage.googleapis.com/v1beta/models',
                    headers: {
                        'x-goog-api-key': apiKey,
                    },
                };

            case BYOKProvider.OPEN_ROUTER:
                return {
                    url: 'https://openrouter.ai/api/v1/models',
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                };

            case BYOKProvider.NOVITA:
                return {
                    url: 'https://api.novita.ai/v3/openai/models',
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                };

            case BYOKProvider.OPENAI_COMPATIBLE: {
                // Trim trailing slashes without a `/+$` regex (polynomial
                // backtracking risk on user input). endsWith+slice is O(n).
                let trimmed = baseURL!;
                while (trimmed.endsWith('/')) {
                    trimmed = trimmed.slice(0, -1);
                }
                const needsV1 = !/\/v\d+$/i.test(trimmed);
                const url = needsV1
                    ? `${trimmed}/v1/models`
                    : `${trimmed}/models`;
                return {
                    url,
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                };
            }

            default:
                throw new BadRequestException(
                    `Unsupported provider: ${provider}`,
                );
        }
    }

    private normalizeError(err: unknown, latencyMs: number): TestByokResult {
        if (axios.isAxiosError(err)) {
            const status = err.response?.status;
            const providerMessage = this.extractProviderMessage(
                err.response?.data,
            );

            const base = { latencyMs, httpStatus: status, providerMessage };

            if (status === 401 || status === 403) {
                return {
                    ok: false,
                    code: 'auth',
                    ...base,
                    message:
                        'The provider rejected this API key. Double-check it was copied in full, billing is active, and the key matches the endpoint you selected.',
                };
            }

            if (status === 404) {
                return {
                    ok: false,
                    code: 'not_found',
                    ...base,
                    message:
                        "The provider returned 404. Either the base URL is wrong for this provider, or the API path isn't exposed on your plan.",
                };
            }

            if (status === 400) {
                return {
                    ok: false,
                    code: 'bad_request',
                    ...base,
                    message:
                        'The provider rejected the request format. The key may be valid but the model ID or request shape is off — check the exact model name in the provider catalog.',
                };
            }

            if (status === 402) {
                return {
                    ok: false,
                    code: 'payment',
                    ...base,
                    message:
                        'The provider account has insufficient credits or a blocked billing status. Top up on the provider dashboard and retry.',
                };
            }

            if (status === 429) {
                return {
                    ok: true,
                    code: 'rate_limit',
                    ...base,
                    message:
                        "Rate-limited — the key works but the provider is throttling right now. Wait a moment and save again, or lower Max Concurrent Requests in Advanced settings.",
                };
            }

            if (typeof status === 'number' && status >= 500) {
                return {
                    ok: false,
                    code: 'server_error',
                    ...base,
                    message: `The provider returned HTTP ${status}. This is a provider-side error — wait a moment and retry. If it persists, check the provider status page.`,
                };
            }

            if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
                return {
                    ok: false,
                    code: 'network',
                    latencyMs,
                    message: `The request timed out after ${TEST_TIMEOUT_MS}ms. The provider may be slow or unreachable from this deployment — retry or check outbound network.`,
                };
            }

            if (
                err.code === 'ECONNREFUSED' ||
                err.code === 'ENOTFOUND' ||
                err.code === 'EAI_AGAIN'
            ) {
                return {
                    ok: false,
                    code: 'network',
                    latencyMs,
                    message: `Couldn't reach the provider (${err.code}). The base URL may be wrong, the host may be down, or your deployment can't make outbound HTTPS calls.`,
                };
            }

            return {
                ok: false,
                code: 'unknown',
                ...base,
                message: status
                    ? `The provider returned HTTP ${status} and Kodus couldn't classify the error. See the provider message below for details.`
                    : 'Kodus reached the provider but couldn\'t classify the response. See the provider message below.',
            };
        }

        this.logger.warn({
            message: 'Unexpected error while testing BYOK connection',
            context: TestByokConnectionUseCase.name,
            error: err as AxiosError,
        });

        return {
            ok: false,
            code: 'unknown',
            latencyMs,
            message:
                (err as Error)?.message ??
                'Unexpected error while testing the connection.',
        };
    }

    /**
     * Extract the provider's own error message from the response body.
     * Covers OpenAI/Anthropic/Google/OpenRouter/OpenAI-compatible shapes.
     */
    private extractProviderMessage(data: unknown): string | undefined {
        if (!data) return undefined;

        // Some providers return a plain string body
        if (typeof data === 'string') {
            const trimmed = data.trim();
            return trimmed.length > 0 && trimmed.length < 500
                ? trimmed
                : undefined;
        }

        if (typeof data !== 'object') return undefined;
        const d = data as Record<string, unknown>;

        // OpenAI / Anthropic / Google / OpenRouter:  { error: { message, ... } }
        const errorField = d.error;
        if (errorField && typeof errorField === 'object') {
            const inner = errorField as Record<string, unknown>;
            if (typeof inner.message === 'string' && inner.message.trim()) {
                return inner.message.trim();
            }
        }
        // Some OpenAI-compatible servers:  { error: "plain string" }
        if (typeof errorField === 'string' && errorField.trim()) {
            return errorField.trim();
        }

        // Fallback: top-level message
        if (typeof d.message === 'string' && d.message.trim()) {
            return d.message.trim();
        }

        // Gemini's google.rpc.Status shape: { error: { details: [...] } }
        if (
            errorField &&
            typeof errorField === 'object' &&
            Array.isArray((errorField as any).details)
        ) {
            const first = (errorField as any).details[0];
            if (first?.reason && typeof first.reason === 'string') {
                return first.reason;
            }
        }

        return undefined;
    }
}
