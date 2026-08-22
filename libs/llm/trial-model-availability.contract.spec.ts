/**
 * Contract test: pins KODUS_TRIAL_MODEL to a real, callable model at
 * Fireworks — not to whatever the CI workflow's own hardcoded default says.
 *
 * Bug this exists to catch (PR #1734, "fix(code-review): Fixing model
 * name"): KODUS_TRIAL_MODEL is a hardcoded model id, used as the default
 * for every trial org and every self-hosted install with no BYOK
 * configured (referenced from commentManager.service.ts,
 * build-orchestrator-input.ts, documentation-search-exa.service.ts,
 * kody-rules-model-policy.ts, reference-detector.service.ts — a one-line
 * regression here breaks review/conversation/kody-rules for every trial
 * org at once). Fireworks deprecated `deepseek-v4-flash` in favor of a
 * dated version (`-0731`); nothing caught the old id going stale until it
 * broke in production.
 *
 * The existing e2e preflight check (tests/e2e/lib/llm-preflight.ts) DOES
 * call this model for real during matrix runs — but through
 * API_LLM_PROVIDER_MODEL, a value the CI workflow hardcodes SEPARATELY
 * from this constant. If someone updates KODUS_TRIAL_MODEL here without
 * updating that workflow default (or the reverse), the preflight keeps
 * silently checking a value that no longer matches what the product
 * actually ships — exactly the drift that let this go stale. This test
 * imports the constant directly, so there is no second value to drift
 * from.
 *
 * Needs a live Fireworks-compatible key — skips (not fails) when
 * E2E_LLM_API_KEY/API_OPEN_AI_API_KEY isn't set, same convention as
 * llmPreflight. Not run by the default fast unit pass in practice (no key
 * in that job's env); runs for real wherever E2E_LLM_API_KEY is available
 * (the self-hosted e2e matrix job already has it).
 */
import { KODUS_TRIAL_MODEL } from './byok-to-vercel';

const API_KEY = process.env.E2E_LLM_API_KEY || process.env.API_OPEN_AI_API_KEY;
const BASE_URL = (
    process.env.API_OPENAI_FORCE_BASE_URL || 'https://api.fireworks.ai/inference/v1'
).replace(/\/$/, '');

const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey('KODUS_TRIAL_MODEL availability (contract)', () => {
    it(`${KODUS_TRIAL_MODEL} answers a real completion request`, async () => {
        const resp = await fetch(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: KODUS_TRIAL_MODEL,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 16,
            }),
            signal: AbortSignal.timeout(30_000),
        });

        const raw = await resp.text();

        // A 400 "context/output limit reached" still proves the model id
        // and key are both valid — the request was accepted and the model
        // ran, it just could not fit an answer in our tiny cap. Anything
        // else (404 model_not_found, 401/403 auth, 429/quota) is a real
        // failure of the thing this test exists to catch.
        const ranAnyway =
            resp.status === 400 &&
            /max_tokens|output limit|could not finish/i.test(raw);

        // Jest's expect() takes exactly one argument (no custom message, unlike
        // Vitest/chai) — throw with the diagnostic so a failure says WHICH
        // assumption broke, not just "expected true, received false".
        if (!(resp.ok || ranAnyway)) {
            throw new Error(
                `KODUS_TRIAL_MODEL ('${KODUS_TRIAL_MODEL}') is not answering at ${BASE_URL} — ` +
                    `HTTP ${resp.status}: ${raw.slice(0, 300)}. If Fireworks deprecated/renamed this ` +
                    'id again, every trial org and every no-BYOK self-hosted install just went dark, ' +
                    'silently (see PR #1734).',
            );
        }
        expect(resp.ok || ranAnyway).toBe(true);
    }, 35_000);
});
