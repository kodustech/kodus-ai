import { describeBaseUrlProblem } from '@libs/llm/base-url-hygiene';
import { BYOKProvider } from '@libs/llm/model-providers';
import { REGISTRY } from '@libs/llm/providers';
import { probeSlotCall } from '@libs/llm/probe-slot-call';
import {
    describeDroppedEffort,
    describeUnreachedKeys,
} from '@libs/llm/override-reachability';
import { LLM_ERROR_TAG, LLM_SUCCESS_TAG } from '@libs/llm/log-tags';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { encrypt } from '@libs/common/utils/crypto';
import { validateModelTuning } from '@libs/llm/validate-model-tuning';
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

    // Not a security rule, but the same seam: a base URL that already carries the
    // provider's own endpoint path (…/chat/completions) is appended to a SECOND
    // time and 404s on every call. Every caller of this guard — the save path,
    // the connection probe and the model-listing fetcher — wants to reject it, so
    // it lives here rather than in three places. Checked BEFORE the DNS lookup:
    // it is pure string work, and a wrong path should report the wrong path, not
    // whatever the resolver happens to say about the host.
    const hygiene = describeBaseUrlProblem(rawUrl);
    if (hygiene) {
        throw new BadRequestException(hygiene);
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
    /** Set on a SUCCESSFUL test whose Custom reasoning override was partly (or
     *  wholly) ignored by the provider's adapter. The connection is fine; the
     *  config is not doing what the user thinks. Advisory on purpose — a working
     *  credential must stay testable and savable. */
    warning?: string;
};

type TestByokInput = {
    provider: string;
    apiKey?: string;
    baseURL?: string;
    model?: string;
    /** The temperature the user configured — validated against the model's
     *  policy and sent (resolved) on the real chat probe so the Test exercises
     *  the exact request shape the review will make. */
    temperature?: number;
    /** The reasoning effort the user picked ('none' = thinking off) — validated
     *  against the model's traits so an "off" on an always-thinking model fails
     *  the Test instead of being silently ignored at review time. */
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
    /** Raw provider-options JSON the user pasted. It becomes `providerOptions`
     *  at review time, so the probe sends it too — a malformed or wrong-shaped
     *  override used to save clean and only surface on the first review. */
    reasoningConfigOverride?: string;
    /** Completion cap the slot will carry. */
    maxOutputTokens?: number;
    /** OpenRouter upstream pinning — a pin that no upstream can serve fails the
     *  Test now instead of every review afterwards. */
    openrouterProviderOrder?: string[];
    openrouterAllowFallbacks?: boolean;
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

    /**
     * Public entry: run the connection test and emit ONE greppable observability
     * line per outcome — `[LLM-SUCCESS]` or `[LLM-ERROR]` — so a failed "Test
     * connection" in the web is findable in the logs (provider / model / code /
     * HTTP status / provider message) instead of dying silently in the UI. Input
     * rejections (BadRequestException) are logged too, then re-thrown unchanged.
     */
    async execute(input: TestByokInput): Promise<TestByokResult> {
        try {
            const result = await this.runTest(input);
            this.logTestOutcome(input, result);
            return result;
        } catch (err) {
            this.logger.warn({
                message: `${LLM_ERROR_TAG} BYOK connection test rejected: provider=${input?.provider} model=${input?.model ?? '(none)'} — ${(err as Error)?.message ?? 'invalid request'}`,
                context: TestByokConnectionUseCase.name,
            });
            throw err;
        }
    }

    /** Emit the tagged success/failure line for a completed (non-thrown) test. */
    private logTestOutcome(input: TestByokInput, result: TestByokResult): void {
        const where = `provider=${input?.provider} model=${input?.model ?? '(none)'}`;
        if (result.ok) {
            this.logger.log({
                message: `${LLM_SUCCESS_TAG} BYOK connection test ok: ${where} latency=${result.latencyMs}ms`,
                context: TestByokConnectionUseCase.name,
            });
            return;
        }
        this.logger.warn({
            message: `${LLM_ERROR_TAG} BYOK connection test failed: ${where} code=${result.code}${result.httpStatus ? ` status=${result.httpStatus}` : ''}${result.providerMessage ? ` providerMsg=${JSON.stringify(result.providerMessage)}` : ''} — ${result.message ?? ''}`,
            context: TestByokConnectionUseCase.name,
        });
    }

    private async runTest(input: TestByokInput): Promise<TestByokResult> {
        const { provider, apiKey, baseURL } = input;

        if (!this.providerService.isProviderSupported(provider)) {
            throw new BadRequestException(`Unsupported provider: ${provider}`);
        }

        const byokProvider = provider as BYOKProvider;

        // Validate the configured tuning (temperature / reasoning) against the
        // MODEL's own rules BEFORE spending a network round-trip. The runtime
        // silently self-corrects a mis-set value (a `fixed` temperature is sent
        // over whatever is stored), so a mismatch never 400s at review time — it
        // is just ignored. Surfacing it here tells the user the value won't be
        // used before they save a config that quietly disagrees with it.
        const tuningIssues = validateModelTuning({
            provider,
            model: input.model,
            temperature: input.temperature,
            reasoningEffort: input.reasoningEffort,
        });
        if (tuningIssues.length > 0) {
            return {
                ok: false,
                code: 'bad_request',
                latencyMs: 0,
                message: tuningIssues.map((i) => i.message).join(' '),
            };
        }

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

            // With a model chosen, run the review's own call like every other
            // provider does. This branch used to answer a WEAKER question for
            // Bedrock alone — `GET /foundation-models` proves the credential and
            // nothing else — which is the exact fallback the runtime probe
            // replaced everywhere else. It is also why four live Bedrock slots
            // could carry a reasoning effort that reaches no parameter and still
            // show a green Test: the button never made the call that would have
            // shown it.
            //
            // The credential-only checks stay for a model-less test, which is
            // the case they were written for.
            if (input.model?.trim()) {
                return await this.probeViaRuntime(input, baseURL);
            }

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

        // ONE probe for every provider: build the model through the runtime
        // resolver and issue a minimal real call. The per-provider switch that
        // used to live here rebuilt each request by hand, which is why it drifted
        // — it never emitted reasoning, sent temperature on only one transport,
        // and had no case for Azure at all (which threw "Unsupported provider"
        // and made the provider impossible to connect). Going through
        // `resolveModelConfig` means every per-model fact the provider modules
        // own applies here automatically, and keeps applying when they change.
        //
        // Brands with a canonical endpoint (Kimi/GLM) resolve it from the module,
        // exactly as the model build does, so a key-only connect carries no
        // baseURL and still probes the right host.
        const effectiveBaseURL =
            baseURL?.trim() ||
            (REGISTRY.has(byokProvider)
                ? REGISTRY.get(byokProvider).defaultBaseURL
                : undefined);

        if (
            byokProvider === BYOKProvider.ANTHROPIC_COMPATIBLE &&
            !effectiveBaseURL
        ) {
            throw new BadRequestException(
                `baseURL is required for ${byokProvider}`,
            );
        }

        // A probe now PROVES the model, so it needs one. Previously a
        // model-less Test fell back to listing models, which answered a
        // different question ("is the key valid?") while the button claimed the
        // config works — the weaker signal this refactor exists to remove.
        if (!input.model?.trim()) {
            return {
                ok: false,
                code: 'bad_request',
                latencyMs: 0,
                message:
                    'Pick the model first — the connection test runs a real request with it, so it can tell you the model works and not just that the key is valid.',
            };
        }

        // SSRF guard: only a user-supplied endpoint is attacker-controlled. Runs
        // BEFORE the model is built so a private/reserved target never receives
        // the credential.
        //
        // Gated on the NAMESPACE, not on two literal provider ids. The literals
        // were a regression: the guard this replaced asked the registry which
        // providers speak the Anthropic protocol, which also covers the branded
        // ones (Moonshot, Z.ai, and any brand added later). Those declare
        // `baseURL` in their settings schema — the canonical endpoint is only a
        // DEFAULT — so a request naming `moonshot` with an arbitrary baseURL
        // reached probeSlotCall and made a server-side call to it, ungated.
        //
        // Narrower than it looks, and worth stating so the next reader does not
        // over- or under-rate it: the SAVE path validates every provider's
        // baseURL, so such a URL was never persisted and never reached a review.
        // The window was this endpoint alone — which is still an outbound request
        // to a host the caller chose, i.e. the whole SSRF primitive.
        const speaksAnthropicProtocol =
            REGISTRY.has(byokProvider) &&
            REGISTRY.get(byokProvider).providerOptionsNamespace?.(
                byokProvider,
            ) === 'anthropic' &&
            byokProvider !== BYOKProvider.ANTHROPIC;
        if (
            byokProvider === BYOKProvider.OPENAI_COMPATIBLE ||
            byokProvider === BYOKProvider.ANTHROPIC_COMPATIBLE ||
            speaksAnthropicProtocol
        ) {
            await assertSafeOpenAICompatibleUrl(effectiveBaseURL!);
        }

        return await this.probeViaRuntime(input, effectiveBaseURL);
    }

    /**
     * Build the slot the SAVE would persist and issue the review's own call
     * against it. This is what makes "Test" mean "this exact config works":
     * temperature, reasoning effort, a raw reasoning override and the OpenRouter
     * pins all ride the slot, so a value that the provider will reject fails here
     * instead of at the first review.
     */
    private async probeViaRuntime(
        input: TestByokInput,
        baseURL?: string,
    ): Promise<TestByokResult> {
        const start = Date.now();
        try {
            const probe = await probeSlotCall(
                this.slotFromInput(input, baseURL),
                { timeoutMs: TEST_TIMEOUT_MS },
            );
            // A passing test used to say only "the credential and model work",
            // which is true and incomplete: an override the adapter silently
            // dropped passes too, and the user walks away believing they
            // configured something they did not. The probe already built the real
            // request, so it can say which of their keys survived it.
            return {
                ok: true,
                code: 'ok',
                latencyMs: Date.now() - start,
                // The two ways a reasoning setting can do nothing: a Custom
                // override the adapter rejected, or a preset effort no parameter
                // could carry. They are mutually exclusive by construction — the
                // override REPLACES the preset — so one field says either.
                // A doubled base URL is deliberately NOT reported here: the
                // hygiene gate above rejects it outright, with the corrected URL
                // in the message. Telling the user to fix the stored value beats
                // telling them it worked anyway, so that path never reaches a
                // warning — the runtime repair exists for the reviews already
                // running, not for the person standing at the form.
                warning:
                    describeUnreachedKeys(probe.unreachedOverrideKeys) ??
                    (probe.droppedReasoningEffort
                        ? describeDroppedEffort(probe.droppedReasoningEffort)
                        : undefined),
            };
        } catch (err) {
            return this.normalizeError(err, Date.now() - start);
        }
    }

    /**
     * The form's values as the runtime slot they will become. `apiKey` is
     * re-encrypted because a slot carries ciphertext by contract (the model build
     * decrypts it downstream) — the probe must not be the one path that hands the
     * builder a raw secret and quietly changes that invariant.
     */
    private slotFromInput(
        input: TestByokInput,
        baseURL?: string,
    ): NormalizedModel {
        return {
            provider: input.provider as BYOKProvider,
            apiKey: encrypt(input.apiKey ?? ''),
            model: input.model?.trim() ?? '',
            baseURL: baseURL?.trim() || undefined,
            temperature: input.temperature,
            reasoningEffort: input.reasoningEffort,
            reasoningConfigOverride: input.reasoningConfigOverride,
            maxOutputTokens: input.maxOutputTokens,
            openrouterProviderOrder: input.openrouterProviderOrder,
            openrouterAllowFallbacks: input.openrouterAllowFallbacks,
            vertexLocation: input.vertexLocation,
            awsBearerToken: input.awsBearerToken,
            awsAccessKeyId: input.awsAccessKeyId,
            awsSecretAccessKey: input.awsSecretAccessKey,
            awsRegion: input.awsRegion,
            awsSessionToken: input.awsSessionToken,
        } as NormalizedModel;
    }

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
            if (
                !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(credentials.project_id)
            ) {
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
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                },
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

    /**
     * Any probe failure → a verdict the connect form can show. Two transports
     * reach here: the AI SDK (the unified model probe) and axios (the Vertex /
     * Bedrock auth preflights), so both are normalized onto the same
     * status-driven mapping and produce identical wording for identical
     * failures. Transport-level faults (timeout, DNS, refused) keep their own
     * messages — there is no HTTP status to map.
     */
    private normalizeError(err: unknown, latencyMs: number): TestByokResult {
        const sdk = this.sdkErrorFacts(err);
        if (sdk) {
            const providerMessage =
                this.extractProviderMessage(sdk.body) ?? sdk.message;
            return this.fromHttpStatus(sdk.status, providerMessage, latencyMs);
        }

        if (axios.isAxiosError(err)) {
            const status = err.response?.status;
            const providerMessage = this.extractProviderMessage(
                err.response?.data,
            );

            if (typeof status === 'number') {
                return this.fromHttpStatus(status, providerMessage, latencyMs);
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

            return this.fromHttpStatus(status, providerMessage, latencyMs);
        }

        // An aborted probe is our own timeout, not a provider fault — say so
        // instead of surfacing the SDK's terse "aborted".
        if ((err as { name?: string })?.name === 'AbortError') {
            return {
                ok: false,
                code: 'network',
                latencyMs,
                message: `The request timed out after ${TEST_TIMEOUT_MS}ms. The provider may be slow or unreachable from this deployment — retry or check outbound network.`,
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
     * HTTP status → user-facing verdict. Extracted verbatim from the axios
     * branch so both transports (axios for the auth preflights, the AI SDK for
     * the unified probe) hand back the same wording for the same failure.
     */
    private fromHttpStatus(
        status: number | undefined,
        providerMessage: string | undefined,
        latencyMs: number,
    ): TestByokResult {
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
                    'Rate-limited — the key works but the provider is throttling right now. Wait a moment and save again, or lower Max Concurrent Requests in Advanced settings.',
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
        return {
            ok: false,
            code: 'unknown',
            ...base,
            message: status
                ? `The provider returned HTTP ${status} and Kodus couldn't classify the error. See the provider message below for details.`
                : "Kodus reached the provider but couldn't classify the response. See the provider message below.",
        };
    }

    /**
     * HTTP facts out of an AI SDK failure. `APICallError` carries the status and
     * the raw provider body, but under different names than axios and sometimes
     * one level down in `cause` (a provider adapter re-wrapping its transport).
     * Returns undefined for anything that isn't an SDK call failure so the axios
     * branch keeps handling the paths that still use it.
     */
    private sdkErrorFacts(
        err: unknown,
    ): { status?: number; body?: unknown; message?: string } | undefined {
        if (!err || typeof err !== 'object') return undefined;
        if (axios.isAxiosError(err)) return undefined;

        const e = err as {
            name?: string;
            message?: string;
            statusCode?: number;
            responseBody?: unknown;
            data?: unknown;
            cause?: {
                statusCode?: number;
                responseBody?: unknown;
                message?: string;
            };
        };

        const status = e.statusCode ?? e.cause?.statusCode;
        const body = e.responseBody ?? e.data ?? e.cause?.responseBody;
        const isApiCallError =
            e.name === 'AI_APICallError' || e.name === 'APICallError';

        if (status === undefined && !isApiCallError && body === undefined) {
            return undefined;
        }
        return { status, body, message: e.message ?? e.cause?.message };
    }

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
