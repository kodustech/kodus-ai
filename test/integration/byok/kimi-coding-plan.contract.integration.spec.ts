/**
 * Live contract test for the `anthropic_compatible` BYOK provider against the
 * real Moonshot Kimi Code Plan endpoint (`api.kimi.com/coding`).
 *
 * Unit tests mock the HTTP layer, so they can't catch a drift in the *external*
 * contract or in our SDK wiring. Each assertion here maps to a concrete way the
 * feature breaks in production:
 *
 *   1. Adapter routing / baseURL `/v1` shape — a regression that drops
 *      `anthropic_compatible` to the OpenAI adapter hits Kimi's UA-gated
 *      `/chat/completions` and 403s; a wrong baseURL shape 404s.
 *   2. Vercel path with the *root* baseURL shape — the two SDKs require
 *      opposite shapes, so this guards `anthropicCompatibleRootURL` in the
 *      other direction.
 *   3. Tool calling — a protocol-wiring break silently strips tool use from
 *      reviews.
 *   4. Prompt-cache token accounting — if SDK normalization or our reading
 *      regresses, cost tracking silently under/over-counts.
 *   5. test-byok use-case end-to-end — confirms the real `/v1/messages` probe
 *      (not the ungated `/v1/models`) actually authenticates.
 *
 * Gated on `KIMI_CODING_PLAN_KEY` (a real coding-plan key). Skips — does not
 * fail — when the key is absent, so CI without the secret stays green. Run
 * locally with:
 *   KIMI_CODING_PLAN_KEY=sk-kimi-... yarn test --testPathPatterns=kimi-coding-plan.contract
 */
import { getAdapter, BYOKProvider } from '@kodus/kodus-common/llm';

// Identity crypto so byokToVercelModel can "decrypt" a raw key without needing
// API_CRYPTO_KEY — this test exercises the HTTP contract, not encryption.
jest.mock('@libs/common/utils/crypto', () => ({
    encrypt: (v: string) => v,
    decrypt: (v: string) => v,
}));

import { byokToVercelModel } from '@libs/llm/byok-to-vercel';
import { TestByokConnectionUseCase } from '@libs/organization/application/use-cases/organizationParameters/test-byok-connection.use-case';
import { generateText, tool } from 'ai';
import { z } from 'zod';

const KEY = process.env.KIMI_CODING_PLAN_KEY;
const CODING_BASE = 'https://api.kimi.com/coding';
const MODEL = 'kimi-for-coding';
const NET_TIMEOUT = 60_000;

const describeLive = KEY ? describe : describe.skip;

describeLive(
    'Kimi Code Plan — anthropic_compatible live contract (needs KIMI_CODING_PLAN_KEY)',
    () => {
        it(
            'LangChain adapter reaches the endpoint with a /v1-suffixed baseURL',
            async () => {
                // Worst-case input shape (user pastes the /v1 form). A routing
                // regression to OpenAIAdapter would 403 here; a bad URL 404s.
                const model = getAdapter(
                    BYOKProvider.ANTHROPIC_COMPATIBLE,
                ).build({
                    model: MODEL,
                    apiKey: KEY!,
                    baseURL: `${CODING_BASE}/v1`,
                    options: { maxTokens: 16, temperature: 1 },
                });
                expect(model.constructor.name).toBe('ChatAnthropic');

                const res = await model.invoke('Reply with exactly: ok');
                const text = Array.isArray(res.content)
                    ? JSON.stringify(res.content)
                    : String(res.content);
                expect(text.toLowerCase()).toContain('ok');
            },
            NET_TIMEOUT,
        );

        it(
            'Vercel path reaches the endpoint with the root baseURL shape',
            async () => {
                const model = byokToVercelModel({
                    main: {
                        provider: BYOKProvider.ANTHROPIC_COMPATIBLE,
                        apiKey: KEY!,
                        model: MODEL,
                        baseURL: CODING_BASE, // root form, no /v1
                    },
                } as any);

                const res = await generateText({
                    model,
                    maxOutputTokens: 16,
                    prompt: 'Reply with exactly: ok',
                });
                expect(res.text.toLowerCase()).toContain('ok');
            },
            NET_TIMEOUT,
        );

        it(
            'supports tool calling through the Vercel path',
            async () => {
                const model = byokToVercelModel({
                    main: {
                        provider: BYOKProvider.ANTHROPIC_COMPATIBLE,
                        apiKey: KEY!,
                        model: MODEL,
                        baseURL: CODING_BASE,
                    },
                } as any);

                const res = await generateText({
                    model,
                    maxOutputTokens: 200,
                    prompt: 'What is the weather in Sao Paulo? Use the tool.',
                    tools: {
                        get_weather: tool({
                            description: 'Get weather for a city',
                            inputSchema: z.object({ city: z.string() }),
                        }),
                    },
                });

                expect(res.toolCalls.length).toBeGreaterThan(0);
                expect(res.toolCalls[0].toolName).toBe('get_weather');
            },
            NET_TIMEOUT,
        );

        it(
            'reports prompt-cache read tokens on a repeated prefix',
            async () => {
                const model = byokToVercelModel({
                    main: {
                        provider: BYOKProvider.ANTHROPIC_COMPATIBLE,
                        apiKey: KEY!,
                        model: MODEL,
                        baseURL: CODING_BASE,
                    },
                } as any);

                // Prefix large enough for Kimi's automatic server-side cache to
                // kick in on the second call.
                const prefix =
                    'You are a code reviewer. Context follows.\n' +
                    Array.from(
                        { length: 400 },
                        (_, i) => `Rule ${i}: be precise.`,
                    ).join('\n');

                const run = (n: number) =>
                    generateText({
                        model,
                        maxOutputTokens: 8,
                        system: prefix,
                        prompt: `Reply with the number ${n}.`,
                    });

                await run(1);
                const second = await run(2);

                // The Vercel SDK normalizes Kimi's cache_read_input_tokens into
                // both fields; extractUsage() reads exactly these. A regression
                // here means cost tracking stops seeing cache savings.
                const cacheRead =
                    (second.usage as any).cachedInputTokens ??
                    (second.usage as any).inputTokenDetails?.cacheReadTokens ??
                    0;
                expect(cacheRead).toBeGreaterThan(0);
            },
            NET_TIMEOUT,
        );

        it(
            'test-byok use-case authenticates via the real /v1/messages probe',
            async () => {
                const useCase = new TestByokConnectionUseCase({
                    isProviderSupported: () => true,
                } as any);

                const ok = await useCase.execute({
                    provider: BYOKProvider.ANTHROPIC_COMPATIBLE,
                    apiKey: KEY!,
                    baseURL: `${CODING_BASE}/v1`,
                    model: MODEL,
                });
                expect(ok.ok).toBe(true);
                expect(ok.code).toBe('ok');

                const bad = await useCase.execute({
                    provider: BYOKProvider.ANTHROPIC_COMPATIBLE,
                    apiKey: 'sk-kimi-definitely-invalid',
                    baseURL: `${CODING_BASE}/v1`,
                    model: MODEL,
                });
                expect(bad.ok).toBe(false);
                expect(bad.code).toBe('auth');
            },
            NET_TIMEOUT,
        );
    },
);
