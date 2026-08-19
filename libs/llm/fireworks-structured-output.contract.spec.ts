/**
 * Contract test: pins the assumption behind two related fixes that the
 * managed/trial Fireworks default model actually honors strict
 * `response_format: json_schema` — not just that we set the flag.
 *
 * Bug (PR "fix(llm): enable supportsStructuredOutputs on Fireworks trial
 * fallback", 2026-08-14): the trial/no-BYOK default path
 * (accounts/fireworks/models/* in byokToVercelModel) builds its
 * `createOpenAICompatible` client directly, bypassing the BYOK provider
 * switch — so an earlier fix that added `supportsStructuredOutputs: true`
 * for BYOK-configured OpenAI-compatible providers had NO EFFECT for trial
 * orgs. The AI SDK silently fell back to the legacy `response_format:
 * json_object` path (or none at all) instead of emitting a real
 * `json_schema` request, for every trial/no-BYOK review.
 *
 * That fix is one line (`supportsStructuredOutputs: true` on the trial
 * client). `shouldEnableJsonSchema()` (same file) independently hardcodes
 * the belief that `api.fireworks.ai` "supports strict json_schema via
 * structuredOutputs" for the BYOK-configured path. Both rest on the same
 * external claim about Fireworks' API, which neither call site's existing
 * unit coverage (fully mocked) can verify — only a real request to
 * Fireworks can. If Fireworks ever stops honoring strict json_schema (or
 * never fully did for this model), the schema silently degrades to a
 * best-effort JSON blob and downstream `JSON.parse` either fails loudly
 * elsewhere or — worse — succeeds on a shape-drifted object.
 *
 * Needs a live Fireworks-compatible key — skips (not fails) without one.
 * `API_FIREWORKS_API_KEY` is the real env var this code path reads;
 * E2E_LLM_API_KEY/API_OPEN_AI_API_KEY (pointed at Fireworks via
 * API_OPENAI_FORCE_BASE_URL) is the e2e matrix's existing convention for
 * exercising the same model — see trial-model-availability.contract.spec.ts.
 */
import { KODUS_TRIAL_MODEL } from './byok-to-vercel';

const API_KEY =
    process.env.API_FIREWORKS_API_KEY ||
    process.env.FIREWORKS_API_KEY ||
    process.env.E2E_LLM_API_KEY ||
    process.env.API_OPEN_AI_API_KEY;
const BASE_URL = (
    process.env.API_FIREWORKS_BASE_URL ||
    process.env.API_OPENAI_FORCE_BASE_URL ||
    'https://api.fireworks.ai/inference/v1'
).replace(/\/$/, '');

const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey('Fireworks structured-output support (contract)', () => {
    it(`${KODUS_TRIAL_MODEL} honors strict response_format: json_schema`, async () => {
        const resp = await fetch(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: KODUS_TRIAL_MODEL,
                messages: [
                    {
                        role: 'user',
                        content:
                            'Say the word "hello" and rate your confidence from 0 to 1.',
                    },
                ],
                max_tokens: 64,
                response_format: {
                    type: 'json_schema',
                    json_schema: {
                        name: 'greeting',
                        strict: true,
                        schema: {
                            type: 'object',
                            properties: {
                                word: { type: 'string' },
                                confidence: { type: 'number' },
                            },
                            required: ['word', 'confidence'],
                            additionalProperties: false,
                        },
                    },
                },
            }),
            signal: AbortSignal.timeout(30_000),
        });

        const raw = await resp.text();
        // Jest's expect() takes exactly one argument (no custom message, unlike
        // Vitest/chai) — throw with the diagnostic so a failure says WHICH
        // assumption broke, not just "expected true, received false".
        if (!resp.ok) {
            throw new Error(
                `Fireworks rejected a json_schema response_format request for ${KODUS_TRIAL_MODEL} — ` +
                    `HTTP ${resp.status}: ${raw.slice(0, 300)}. If Fireworks stopped honoring strict ` +
                    'json_schema, both shouldEnableJsonSchema() and the trial-fallback ' +
                    'supportsStructuredOutputs flag rest on a false assumption.',
            );
        }

        const body = JSON.parse(raw);
        const content = body?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
            throw new Error(
                `Expected a JSON string in choices[0].message.content, got: ${JSON.stringify(body).slice(0, 300)}`,
            );
        }

        // The real proof: the content must be valid JSON matching the exact
        // schema shape, not prose, not a loosely-formatted best-effort blob.
        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch {
            throw new Error(
                `Model output was not valid JSON despite a json_schema request: ${content}`,
            );
        }

        expect(parsed).toEqual(
            expect.objectContaining({
                word: expect.any(String),
                confidence: expect.any(Number),
            }),
        );
    }, 35_000);
});
