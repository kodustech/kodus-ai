/**
 * Matrix repro for the structured-output capability gate.
 *
 * Background:
 * - vLLM and a small set of OpenAI-compatible upstreams (Moonshot,
 *   OpenAI-via-OpenRouter, Anthropic-via-OpenRouter, Google-via-OpenRouter)
 *   accept `response_format: { type: "json_schema", json_schema: { schema } }`
 *   and constrain the output natively.
 * - Other OpenAI-compatible upstreams — DeepSeek, Grok, Mistral, most
 *   models routed through Novita/random OPENAI_COMPATIBLE endpoints —
 *   either 400 on `json_schema` or silently ignore it. They accept
 *   the older `response_format: { type: "json_object" }` (no schema)
 *   and rely on prompt-injected schema extraction, which is slow but
 *   works.
 *
 * PR #1125 ("fix passing structured outputs to llm") flipped the flag
 * unconditionally for every openai-compatible BYOK branch when the
 * three Output.object call sites in agent-loop.ts /
 * agent-review.stage.ts opted in. That fixed the vLLM target case but
 * regressed the DeepSeek / Grok / generic-OPENAI_COMPATIBLE tenants:
 * their structured-output fallbacks now 400 instead of falling back
 * to the slow-but-working path. Failures are caught upstream so it
 * looks silent, but the user-visible effect is missed dedups and
 * empty findings on those models.
 *
 * The follow-up fix adds a capability gate in byok-to-vercel.ts plus a
 * retry-on-error wrapper at the call sites. This matrix probes every
 * relevant branch hermetically and asserts the SDK emits the right
 * response_format for each.
 *
 * Run:
 *   pnpm run repro:structured-outputs                  # all scenarios, hermetic
 *   pnpm run repro:structured-outputs --scenario openrouter-kimi --live   # spot-check
 *
 * Exit code is 0 only when every scenario matches its expectation.
 *
 * This file is intentionally NOT named `*.spec.ts`, so Jest's
 * `testMatch` in jest.config.ts ignores it and `pnpm run test` does not
 * pick it up.
 */

import 'dotenv/config';

import { generateText, Output, jsonSchema, type LanguageModel } from 'ai';

import {
    byokToVercelModel,
    getInternalModel,
    withStructuredOutputFallback,
    __structuredFallbackInternals,
} from '@libs/llm/byok-to-vercel';
import { encrypt } from '@/common/utils/crypto';
import { BYOKConfig, BYOKProvider } from '@kodus/kodus-common/llm';

type Expectation = 'json_schema' | 'json_object' | 'gemini-native';

interface Scenario {
    name: string;
    provider: BYOKProvider;
    model: string;
    baseURL?: string;
    apiKeyEnv?: string;
    /** What we expect the outgoing structured-output request body to look like. */
    expected: Expectation;
    /** Plain-English why, printed alongside the assertion result. */
    why: string;
    /** Set when --live should not target this scenario (no key / cost / unsafe). */
    skipLive?: boolean;
}

const SCENARIOS: Scenario[] = [
    {
        name: 'openrouter-kimi',
        provider: BYOKProvider.OPEN_ROUTER,
        model: 'moonshotai/kimi-k2-thinking',
        apiKeyEnv: 'API_OPENROUTER_KEY',
        expected: 'json_schema',
        why: 'Moonshot supports native json_schema; allowlisted by model prefix',
    },
    {
        name: 'openrouter-openai',
        provider: BYOKProvider.OPEN_ROUTER,
        model: 'openai/gpt-4o-mini',
        apiKeyEnv: 'API_OPENROUTER_KEY',
        expected: 'json_schema',
        why: 'OpenAI Structured Outputs; allowlisted by model prefix',
        skipLive: true,
    },
    {
        name: 'openrouter-anthropic',
        provider: BYOKProvider.OPEN_ROUTER,
        model: 'anthropic/claude-3-5-sonnet',
        apiKeyEnv: 'API_OPENROUTER_KEY',
        expected: 'json_schema',
        why: 'Anthropic Sonnet via OR honors json_schema; allowlisted',
        skipLive: true,
    },
    {
        name: 'openrouter-deepseek',
        provider: BYOKProvider.OPEN_ROUTER,
        model: 'deepseek/deepseek-chat',
        apiKeyEnv: 'API_OPENROUTER_KEY',
        expected: 'json_object',
        why: 'DeepSeek API supports json_object only; must NOT receive json_schema',
        skipLive: true,
    },
    {
        name: 'openrouter-grok',
        provider: BYOKProvider.OPEN_ROUTER,
        model: 'x-ai/grok-2',
        apiKeyEnv: 'API_OPENROUTER_KEY',
        expected: 'json_object',
        why: 'Grok historically supports json_object; not yet json_schema strict',
        skipLive: true,
    },
    {
        name: 'oc-vllm',
        provider: BYOKProvider.OPENAI_COMPATIBLE,
        model: 'qwen-2.5-coder-32b',
        baseURL: 'http://vllm.internal:8000/v1',
        apiKeyEnv: 'API_OPENROUTER_KEY', // any non-empty value for hermetic mode
        expected: 'json_schema',
        why: 'Self-hosted vLLM (port 8000 heuristic) supports xgrammar json_schema',
        skipLive: true,
    },
    {
        name: 'oc-generic',
        provider: BYOKProvider.OPENAI_COMPATIBLE,
        model: 'mystery-model',
        baseURL: 'https://random-provider.example.com/v1',
        apiKeyEnv: 'API_OPENROUTER_KEY',
        expected: 'json_object',
        why: 'Unknown OpenAI-compatible endpoint — must fall back to json_object',
        skipLive: true,
    },
    {
        name: 'gemini-control',
        provider: BYOKProvider.GOOGLE_GEMINI,
        model: 'gemini-2.5-flash',
        apiKeyEnv: 'API_GOOGLE_AI_API_KEY',
        expected: 'gemini-native',
        why: '@ai-sdk/google emits generationConfig.responseSchema natively, unaffected by this fix',
    },
];

const LIVE = process.argv.includes('--live');
const SELECTED_SCENARIO = (() => {
    const i = process.argv.indexOf('--scenario');
    return i === -1 ? null : process.argv[i + 1];
})();

const minimalSchema = jsonSchema({
    type: 'object',
    additionalProperties: false,
    properties: { answer: { type: 'string' } },
    required: ['answer'],
} as any);

function buildByokConfig(scenario: Scenario, apiKey: string): BYOKConfig {
    return {
        main: {
            provider: scenario.provider,
            apiKey: encrypt(apiKey),
            model: scenario.model,
            ...(scenario.baseURL ? { baseURL: scenario.baseURL } : {}),
        },
    };
}

function fakeBodyFor(scenario: Scenario): {
    body: string;
    headers: Record<string, string>;
} {
    if (scenario.provider === BYOKProvider.GOOGLE_GEMINI) {
        return {
            body: JSON.stringify({
                candidates: [
                    {
                        content: {
                            role: 'model',
                            parts: [{ text: '{"answer":"ok"}' }],
                        },
                        finishReason: 'STOP',
                        index: 0,
                    },
                ],
                usageMetadata: {
                    promptTokenCount: 8,
                    candidatesTokenCount: 4,
                    totalTokenCount: 12,
                },
            }),
            headers: { 'content-type': 'application/json' },
        };
    }
    return {
        body: JSON.stringify({
            id: 'chatcmpl-fake',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: scenario.model,
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant', content: '{"answer":"ok"}' },
                    finish_reason: 'stop',
                },
            ],
            usage: {
                prompt_tokens: 8,
                completion_tokens: 4,
                total_tokens: 12,
            },
        }),
        headers: { 'content-type': 'application/json' },
    };
}

interface CapturedRequest {
    url: string;
    body: any;
}

function installInterceptingFetch(scenario: Scenario): {
    captured: CapturedRequest[];
    restore: () => void;
} {
    const original = globalThis.fetch;
    const captured: CapturedRequest[] = [];
    const fake = fakeBodyFor(scenario);

    globalThis.fetch = (async (input: any, init?: any) => {
        const url =
            typeof input === 'string'
                ? input
                : input instanceof URL
                  ? input.toString()
                  : (input?.url ?? '');
        let body: any = null;
        try {
            body = init?.body ? JSON.parse(init.body as string) : null;
        } catch {
            body = init?.body ?? null;
        }
        captured.push({ url, body });

        if (LIVE) {
            return original(input as any, init);
        }
        return new Response(fake.body, {
            status: 200,
            headers: fake.headers,
        });
    }) as typeof fetch;

    return {
        captured,
        restore: () => {
            globalThis.fetch = original;
        },
    };
}

async function probeStructured(
    scenario: Scenario,
    model: LanguageModel,
): Promise<CapturedRequest | null> {
    const { captured, restore } = installInterceptingFetch(scenario);
    try {
        await generateText({
            model: model as any,
            prompt: 'Return any JSON value matching the schema.',
            output: Output.object({ schema: minimalSchema }) as any,
        }).catch((err) => {
            console.warn(
                `[repro] [${scenario.name}] generateText threw (continuing): ${String(
                    (err as any)?.message ?? err,
                )}`,
            );
        });
    } finally {
        restore();
    }
    return captured[0] ?? null;
}

async function probeToolLoop(
    scenario: Scenario,
    model: LanguageModel,
): Promise<CapturedRequest | null> {
    const { captured, restore } = installInterceptingFetch(scenario);
    try {
        await generateText({
            model: model as any,
            prompt: 'Say hi.',
        }).catch((err) =>
            console.warn(
                `[repro] [${scenario.name}] tool-loop probe threw (continuing): ${String(
                    (err as any)?.message ?? err,
                )}`,
            ),
        );
    } finally {
        restore();
    }
    return captured[0] ?? null;
}

function evaluate(
    expected: Expectation,
    body: any,
): { ok: boolean; summary: string } {
    if (expected === 'gemini-native') {
        const gc = body?.generationConfig;
        const ok =
            gc?.responseMimeType === 'application/json' &&
            gc?.responseSchema != null;
        return {
            ok,
            summary: `generationConfig.responseMimeType=${JSON.stringify(
                gc?.responseMimeType ?? null,
            )} generationConfig.responseSchema=${
                gc?.responseSchema ? '<set>' : 'null'
            }`,
        };
    }
    const rf = body?.response_format;
    if (expected === 'json_schema') {
        const ok =
            rf?.type === 'json_schema' && rf?.json_schema?.schema != null;
        return {
            ok,
            summary: `response_format = ${JSON.stringify(rf ?? null)}`,
        };
    }
    // json_object
    const ok = rf?.type === 'json_object';
    return {
        ok,
        summary: `response_format = ${JSON.stringify(rf ?? null)}`,
    };
}

function evaluateToolLoop(
    expected: Expectation,
    body: any,
): { ok: boolean; summary: string } {
    if (expected === 'gemini-native') {
        const responseSchema = body?.generationConfig?.responseSchema;
        return {
            ok: responseSchema == null,
            summary: `generationConfig.responseSchema=${
                responseSchema ? '<set>' : 'null'
            }`,
        };
    }
    const rf = body?.response_format;
    return {
        ok: rf == null || rf?.type !== 'json_schema',
        summary: `response_format = ${JSON.stringify(rf ?? null)}`,
    };
}

interface ScenarioResult {
    scenario: Scenario;
    structuredOk: boolean;
    structuredSummary: string;
    toolOk: boolean;
    toolSummary: string;
    error?: string;
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
    const apiKey = LIVE
        ? process.env[scenario.apiKeyEnv ?? '']
        : 'sk-test-not-a-real-key';
    if (LIVE && !apiKey) {
        return {
            scenario,
            structuredOk: false,
            structuredSummary: '',
            toolOk: false,
            toolSummary: '',
            error: `--live requires ${scenario.apiKeyEnv} in env`,
        };
    }
    if (LIVE && scenario.skipLive) {
        return {
            scenario,
            structuredOk: true,
            structuredSummary: '(skipped in --live)',
            toolOk: true,
            toolSummary: '(skipped in --live)',
        };
    }

    const byok = buildByokConfig(scenario, apiKey as string);
    const internalModel = getInternalModel(byok, { structuredOutputs: true });
    if (!internalModel) {
        return {
            scenario,
            structuredOk: false,
            structuredSummary: '',
            toolOk: false,
            toolSummary: '',
            error: 'getInternalModel returned null',
        };
    }

    const structuredCaptured = await probeStructured(scenario, internalModel);
    const structured = evaluate(
        scenario.expected,
        structuredCaptured?.body ?? null,
    );

    const mainModel = byokToVercelModel(byok, 'main');
    const toolCaptured = await probeToolLoop(scenario, mainModel);
    const toolEval = evaluateToolLoop(
        scenario.expected,
        toolCaptured?.body ?? null,
    );

    return {
        scenario,
        structuredOk: structured.ok,
        structuredSummary: structured.summary,
        toolOk: toolEval.ok,
        toolSummary: toolEval.summary,
    };
}

function printResult(r: ScenarioResult): void {
    const tag = (b: boolean) => (b ? '[PASS]' : '[FAIL]');
    console.log(`\n--- ${r.scenario.name} (${r.scenario.expected})`);
    console.log(`    why: ${r.scenario.why}`);
    if (r.error) {
        console.log(`    [ERROR] ${r.error}`);
        return;
    }
    console.log(
        `    ${tag(r.structuredOk)} structured: ${r.structuredSummary}`,
    );
    console.log(`    ${tag(r.toolOk)} tool-loop:  ${r.toolSummary}`);
}

/**
 * Probe the retry-on-error path of `withStructuredOutputFallback`.
 *
 * Builds an allowlisted scenario (so the first call goes out with
 * json_schema), but the fake fetch returns 400 with a schema-related
 * error body — exactly what DeepSeek/Grok would respond if they were
 * mistakenly allowlisted. The helper should mark the combo
 * unsupported in its cache and retry with the flag off. We assert
 * two outbound requests and the response_format shape of each.
 */
async function probeRetryFallback(): Promise<{
    ok: boolean;
    summary: string;
}> {
    // Clear cache so this test runs from a clean slate.
    __structuredFallbackInternals.cache.clear();

    const apiKey = 'sk-test-not-a-real-key';
    const byok: BYOKConfig = {
        main: {
            provider: BYOKProvider.OPEN_ROUTER,
            apiKey: encrypt(apiKey),
            model: 'openai/gpt-4o-mini', // allowlisted by prefix
        },
    };

    const captured: CapturedRequest[] = [];
    const original = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url =
            typeof input === 'string'
                ? input
                : input instanceof URL
                  ? input.toString()
                  : (input?.url ?? '');
        let body: any = null;
        try {
            body = init?.body ? JSON.parse(init.body as string) : null;
        } catch {
            body = init?.body ?? null;
        }
        captured.push({ url, body });

        call++;
        if (call === 1) {
            // First call: simulate DeepSeek-like 400 on json_schema.
            return new Response(
                JSON.stringify({
                    error: {
                        message:
                            "Invalid value for 'response_format': supported values are 'text', 'json_object'",
                        type: 'invalid_request_error',
                        code: 'invalid_response_format',
                    },
                }),
                {
                    status: 400,
                    headers: { 'content-type': 'application/json' },
                },
            );
        }
        // Second call: succeed.
        return new Response(
            JSON.stringify({
                id: 'chatcmpl-fake',
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: 'openai/gpt-4o-mini',
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: '{"answer":"ok"}',
                        },
                        finish_reason: 'stop',
                    },
                ],
                usage: {
                    prompt_tokens: 8,
                    completion_tokens: 4,
                    total_tokens: 12,
                },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }) as typeof fetch;

    try {
        await withStructuredOutputFallback(
            { byokConfig: byok, label: 'retry-probe' },
            (model) =>
                // Bubble the SDK error up to the helper — `.catch(() => null)`
                // here would consume the rejection and starve the retry.
                generateText({
                    model: model as any,
                    prompt: 'Return any JSON value matching the schema.',
                    output: Output.object({ schema: minimalSchema }) as any,
                }),
        ).catch((err) => {
            // After retry the second response may not be parseable JSON
            // against the schema (we send `{"answer":"ok"}` which it is,
            // but the SDK can still throw on minor shape mismatches).
            // The captured request body is what we actually assert on.
            console.warn(
                `[repro] retry probe outer threw: ${String(
                    (err as any)?.message ?? err,
                )}`,
            );
        });
    } finally {
        globalThis.fetch = original;
    }

    const first = captured[0]?.body?.response_format;
    const second = captured[1]?.body?.response_format;
    const cached = __structuredFallbackInternals.cache.size > 0;

    const ok =
        first?.type === 'json_schema' &&
        second?.type === 'json_object' &&
        cached;
    return {
        ok,
        summary: `calls=${captured.length} first=${JSON.stringify(
            first ?? null,
        )} second=${JSON.stringify(second ?? null)} cacheSize=${
            __structuredFallbackInternals.cache.size
        }`,
    };
}

/**
 * Probe that `withStructuredOutputFallback` does NOT fire a futile retry
 * when the gate already kept json_schema OFF.
 *
 * Reproduces the observed Novita `kimi-k2-instruct` failure: the provider
 * is not allowlisted, so the first call already goes out as
 * `response_format: json_object`. The fake fetch 400s with Novita's exact
 * "does not support feature: structured-outputs" body. Downgrading
 * json_schema→json_object is impossible (we are already at json_object),
 * so the helper must throw after exactly ONE call — retrying would just
 * resend a byte-identical request.
 */
async function probeNoFutileRetry(): Promise<{ ok: boolean; summary: string }> {
    __structuredFallbackInternals.cache.clear();

    const byok: BYOKConfig = {
        main: {
            provider: BYOKProvider.NOVITA, // never allowlisted → gate OFF
            apiKey: encrypt('sk-test-not-a-real-key'),
            model: 'moonshotai/kimi-k2-instruct',
            baseURL: 'https://api.novita.ai/v3/openai',
        },
    };

    const captured: CapturedRequest[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        let body: any = null;
        try {
            body = init?.body ? JSON.parse(init.body as string) : null;
        } catch {
            body = init?.body ?? null;
        }
        captured.push({ url: '', body });
        // Novita's verbatim rejection body.
        return new Response(
            JSON.stringify({
                code: 400,
                reason: 'INVALID_REQUEST_BODY',
                message:
                    'model: moonshotai/kimi-k2-instruct does not support feature: structured-outputs',
                metadata: {},
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
        );
    }) as typeof fetch;

    let threw = false;
    try {
        await withStructuredOutputFallback(
            { byokConfig: byok, label: 'no-futile-retry-probe' },
            (model) =>
                generateText({
                    model: model as any,
                    prompt: 'Return any JSON value matching the schema.',
                    output: Output.object({ schema: minimalSchema }) as any,
                }),
        );
    } catch {
        threw = true;
    } finally {
        globalThis.fetch = original;
    }

    const first = captured[0]?.body?.response_format;
    // Exactly one call, it was json_object (gate OFF), and the error
    // propagated instead of triggering a doomed retry.
    const ok = captured.length === 1 && first?.type === 'json_object' && threw;
    return {
        ok,
        summary: `calls=${captured.length} (expect 1) first=${JSON.stringify(
            first ?? null,
        )} threw=${threw}`,
    };
}

/**
 * Probe that the no-json-schema cache is per-tenant and TTL-bounded.
 *
 * Two orgs share the same provider/model/key. Org A's upstream rejects
 * json_schema (so A's verdict gets cached); org B must NOT inherit it —
 * B's first call should still attempt json_schema. Then we expire org
 * A's entry and confirm A retries json_schema again instead of being
 * permanently denylisted.
 */
async function probeCacheIsolation(): Promise<{
    ok: boolean;
    summary: string;
}> {
    __structuredFallbackInternals.cache.clear();

    const byok: BYOKConfig = {
        main: {
            provider: BYOKProvider.OPEN_ROUTER,
            apiKey: encrypt('sk-test-not-a-real-key'),
            model: 'openai/gpt-4o-mini', // allowlisted → json_schema ON
        },
    };

    const captured: CapturedRequest[] = [];
    const original = globalThis.fetch;
    // Stateless fake: json_schema → 400 unsupported, json_object → 200.
    globalThis.fetch = (async (input: any, init?: any) => {
        let body: any = null;
        try {
            body = init?.body ? JSON.parse(init.body as string) : null;
        } catch {
            body = init?.body ?? null;
        }
        captured.push({ url: '', body });
        if (body?.response_format?.type === 'json_schema') {
            return new Response(
                JSON.stringify({
                    error: {
                        message: 'response_format json_schema is not supported',
                        type: 'invalid_request_error',
                    },
                }),
                {
                    status: 400,
                    headers: { 'content-type': 'application/json' },
                },
            );
        }
        return new Response(
            JSON.stringify({
                id: 'x',
                object: 'chat.completion',
                created: 0,
                model: 'openai/gpt-4o-mini',
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: '{"answer":"ok"}',
                        },
                        finish_reason: 'stop',
                    },
                ],
                usage: {
                    prompt_tokens: 8,
                    completion_tokens: 4,
                    total_tokens: 12,
                },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }) as typeof fetch;

    const runOnce = (orgId: string) =>
        withStructuredOutputFallback(
            {
                byokConfig: byok,
                organizationId: orgId,
                label: `cache-probe-${orgId}`,
            },
            (model) =>
                generateText({
                    model: model as any,
                    prompt: 'Return any JSON value matching the schema.',
                    output: Output.object({ schema: minimalSchema }) as any,
                }),
        ).catch(() => null);

    try {
        // Org A: json_schema 400 → retry json_object 200 → verdict cached.
        await runOnce('org-A');
        const afterA = captured.length;

        // Org B: same provider/model/key, different org — must not inherit
        // A's verdict, so its first call attempts json_schema again.
        await runOnce('org-B');
        const orgBFirst = captured[afterA]?.body?.response_format?.type;
        const isolated = orgBFirst === 'json_schema';

        // TTL: expire org A's entry, then A must retry json_schema.
        const keyA = __structuredFallbackInternals.cacheKey(byok, 'org-A');
        __structuredFallbackInternals.cache.set(
            keyA,
            Date.now() - __structuredFallbackInternals.ttlMs - 1000,
        );
        const expiredSeen =
            !__structuredFallbackInternals.isNoJsonSchemaCached(keyA);
        const beforeTtl = captured.length;
        await runOnce('org-A');
        const ttlRetried =
            captured[beforeTtl]?.body?.response_format?.type === 'json_schema';

        const ok = isolated && expiredSeen && ttlRetried;
        return {
            ok,
            summary: `orgB-isolated=${isolated} (orgB-first=${orgBFirst}) ttl-expired=${expiredSeen} ttl-retried=${ttlRetried}`,
        };
    } finally {
        globalThis.fetch = original;
    }
}

async function main(): Promise<void> {
    if (!process.env.API_CRYPTO_KEY) {
        console.error(
            '[repro] API_CRYPTO_KEY is required (used to encrypt the BYOK apiKey).',
        );
        process.exit(2);
    }

    const scenarios = SELECTED_SCENARIO
        ? SCENARIOS.filter((s) => s.name === SELECTED_SCENARIO)
        : SCENARIOS;
    if (scenarios.length === 0) {
        console.error(
            `[repro] No scenario matched '${SELECTED_SCENARIO}'. Known: ${SCENARIOS.map((s) => s.name).join(', ')}`,
        );
        process.exit(2);
    }

    console.log(
        `[repro] mode=${LIVE ? 'live' : 'hermetic'} scenarios=${scenarios.length}`,
    );

    const results: ScenarioResult[] = [];
    for (const s of scenarios) {
        results.push(await runScenario(s));
    }

    for (const r of results) printResult(r);

    let retryOk = true;
    let noFutileOk = true;
    let cacheOk = true;
    if (!LIVE && !SELECTED_SCENARIO) {
        console.log('\n--- retry-on-error fallback (helper-level)');
        console.log(
            '    why: allowlisted model that 400s on json_schema must trigger an automatic retry with response_format=json_object',
        );
        const retry = await probeRetryFallback();
        retryOk = retry.ok;
        console.log(`    ${retry.ok ? '[PASS]' : '[FAIL]'} ${retry.summary}`);

        console.log('\n--- no futile retry when gate kept json_schema OFF');
        console.log(
            '    why: a gated-off provider (Novita) that 400s on json_object must throw after ONE call — a retry would resend an identical request',
        );
        const noFutile = await probeNoFutileRetry();
        noFutileOk = noFutile.ok;
        console.log(
            `    ${noFutile.ok ? '[PASS]' : '[FAIL]'} ${noFutile.summary}`,
        );

        console.log('\n--- no-json-schema cache is per-tenant + TTL-bounded');
        console.log(
            '    why: one org’s json_schema rejection must not demote other orgs, and a stale verdict must expire',
        );
        const cache = await probeCacheIsolation();
        cacheOk = cache.ok;
        console.log(`    ${cache.ok ? '[PASS]' : '[FAIL]'} ${cache.summary}`);
    }

    const failed = results.filter(
        (r) => r.error || !r.structuredOk || !r.toolOk,
    );
    console.log('');
    console.log('='.repeat(60));
    const extraProbes = LIVE || SELECTED_SCENARIO ? 0 : 3;
    const totalRan = results.length + extraProbes;
    const totalFailed =
        failed.length +
        (retryOk ? 0 : 1) +
        (noFutileOk ? 0 : 1) +
        (cacheOk ? 0 : 1);
    console.log(`Summary: ${totalRan - totalFailed}/${totalRan} green`);
    if (failed.length > 0) {
        console.log(`Failed: ${failed.map((r) => r.scenario.name).join(', ')}`);
    }
    if (!retryOk) {
        console.log('Failed: retry-on-error fallback');
    }
    if (!noFutileOk) {
        console.log('Failed: no futile retry when gated off');
    }
    if (!cacheOk) {
        console.log('Failed: no-json-schema cache isolation');
    }

    process.exit(
        failed.length === 0 && retryOk && noFutileOk && cacheOk ? 0 : 1,
    );
}

main().catch((err) => {
    console.error('[repro] crashed:', err);
    process.exit(2);
});
