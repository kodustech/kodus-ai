/**
 * BYOK config matrix — the contract between "what the user saved" and "what we
 * put on the network".
 *
 * ─── ADDING A CASE (you do not write a test) ────────────────────────────────
 * Append one row to `CASES`. A row is:
 *
 *   {
 *     id:   'openai_compatible/kimi — thinking toggle',
 *     why:  'one sentence a reviewer can check without reading code',
 *     slot: { provider, model, baseURL?, reasoningEffort?, ... },   // as STORED
 *     wire: {
 *       url?:    'https://…',              // exact request URL, if it matters
 *       has?:    { thinking: {...} },      // fields that MUST be in the body
 *       hasNot?: ['reasoning_effort'],     // fields that must NOT be there
 *     },
 *   }
 *
 * Adding a provider or a model family is the same one row. Nothing else to wire.
 *
 * ─── WHY IT LOOKS AT THE WIRE ───────────────────────────────────────────────
 * Every BYOK bug this file was written after was invisible to unit tests of the
 * pieces, because each piece was individually right and the COMPOSITION was
 * wrong. Three shipped examples, all now pinned below:
 *   - OpenRouter built its client as `name: 'open-router'` while emitting
 *     provider options under `openrouter` → the SDK matched neither key and
 *     dropped every reasoning effort and every provider pin, silently.
 *   - `openai_compatible` sent `thinking:{enabled}` to ANY upstream, so a user
 *     on NVIDIA NIM / MiniMax / an OpenAI proxy who picked "High" got a field
 *     their server ignores and no reasoning at all.
 *   - `reasoning_effort` (snake_case) is silently overwritten by the SDK; only
 *     `reasoningEffort` (camelCase) reaches the body.
 * None of those change a return value any existing spec asserted. All three
 * change the request body. So the body is the assertion.
 *
 * The harness (`testing/byok-wire.ts`) runs the REAL stack — resolveModelConfig,
 * the real provider module, the real AI SDK — and only stubs `globalThis.fetch`.
 */

jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import PROD_SHAPES from './testing/__fixtures__/byok-prod-shapes.json';
import { describeBaseUrlProblem } from './base-url-hygiene';
import { captureByokWire } from './testing/byok-wire';
import type { NormalizedModel } from './byok-config';

const CASES = [
    // ─── openai_compatible ──────────────────────────────────────────────────
    // The transport the user chose is ALWAYS honored. What changes per model is
    // the reasoning parameter — and the brands disagree hard on the SAME
    // transport, which is exactly why this cannot be an
    // `if (provider === 'openai_compatible')`.
    {
        id: 'deepseek — `thinking` AND `reasoning_effort`, on the brand vocabulary',
        why: 'DeepSeek requires the pair together and has no "medium": its scale is low/high/max, so our top effort maps to max',
        doc: 'api-docs.deepseek.com/guides/thinking_mode',
        slot: {
            provider: 'openai_compatible',
            model: 'deepseek-v4-flash',
            baseURL: 'https://api.deepseek.com',
            reasoningEffort: 'high',
            temperature: 0,
        },
        wire: {
            url: 'https://api.deepseek.com/chat/completions',
            has: { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
        },
    },
    {
        id: 'deepseek — no temperature while thinking',
        why: '"Thinking mode does not support the temperature, top_p, presence_penalty, or frequency_penalty parameters" — forwarding it made the UI value a lie',
        doc: 'api-docs.deepseek.com/guides/thinking_mode',
        slot: {
            provider: 'openai_compatible',
            model: 'deepseek-v4-flash',
            baseURL: 'https://api.deepseek.com',
            reasoningEffort: 'high',
            temperature: 0,
        },
        wire: { hasNot: ['temperature'] },
    },
    {
        id: 'deepseek — Off is said out loud',
        why: 'DeepSeek thinks by default; omitting the disable left it reasoning (and billing) while the user had picked Off',
        doc: 'api-docs.deepseek.com/guides/thinking_mode',
        slot: {
            provider: 'openai_compatible',
            model: 'deepseek-v4-pro',
            baseURL: 'https://api.deepseek.com',
            reasoningEffort: 'none',
        },
        wire: {
            has: { thinking: { type: 'disabled' } },
            hasNot: ['reasoning_effort'],
        },
    },
    {
        id: 'deepseek — temperature comes BACK once reasoning is off',
        why: 'The vendor rule is scoped to thinking mode, not to the model. Reading it as "never takes a temperature" removed a setting that works with reasoning disabled',
        doc: 'api-docs.deepseek.com/guides/thinking_mode',
        slot: {
            provider: 'openai_compatible',
            model: 'deepseek-v4-pro',
            baseURL: 'https://api.deepseek.com',
            reasoningEffort: 'none',
            temperature: 0.2,
        },
        wire: { has: { temperature: 0.2, thinking: { type: 'disabled' } } },
    },
    {
        id: 'kimi — `thinking` ONLY, never alongside an effort',
        why: 'Moonshot 400s on the pair ("cannot specify both"), so Kimi granularity genuinely stops at the toggle',
        doc: 'github.com/HKUDS/nanobot/issues/3939',
        slot: {
            provider: 'openai_compatible',
            model: 'kimi-k2.6',
            baseURL: 'https://api.moonshot.ai/v1',
            reasoningEffort: 'high',
        },
        wire: {
            has: { thinking: { type: 'enabled' } },
            hasNot: ['reasoning_effort'],
        },
    },
    {
        id: 'glm — effort accepted AND temperature preserved',
        why: 'Z.ai takes reasoning_effort and keeps sampling params working while thinking — the opposite of DeepSeek and Kimi, on the same transport',
        doc: 'docs.z.ai/api-reference/llm/chat-completion',
        slot: {
            provider: 'openai_compatible',
            model: 'glm-5.2',
            baseURL: 'https://api.z.ai/api/paas/v4',
            reasoningEffort: 'medium',
            temperature: 0,
        },
        wire: {
            has: {
                thinking: { type: 'enabled' },
                reasoning_effort: 'high',
                temperature: 0,
            },
        },
    },
    {
        id: 'glm-5.3 — always-thinking pins temperature to 1',
        why: 'A model that cannot stop thinking has one sound temperature; the pin is a MODEL rule and must survive any transport',
        doc: 'docs.z.ai/api-reference/llm/chat-completion',
        slot: {
            provider: 'openai_compatible',
            model: 'glm-5.3',
            baseURL: 'https://api.z.ai/api/paas/v4',
            maxOutputTokens: 0,
        },
        wire: { has: { temperature: 1 }, hasNot: ['max_tokens'] },
    },
    {
        id: 'gpt-5.x via a proxy — the OpenAI param, camelCase at the SDK boundary',
        why: 'A gpt-* id proxied over a custom endpoint speaks reasoning_effort; sending `thinking` was a no-op, so the user picked High and got no reasoning',
        slot: {
            provider: 'openai_compatible',
            model: 'gpt-5.6-sol',
            baseURL: 'https://example.test/codex/v1',
            reasoningEffort: 'high',
        },
        wire: { has: { reasoning_effort: 'high' }, hasNot: ['thinking'] },
    },
    {
        id: 'unknown upstream — no reasoning param is invented',
        why: 'NVIDIA NIM, MiniMax, Ollama, a self-hosted vLLM: a strict server 400s on an unknown body field and a lenient one ignores it, so silence is the only safe answer',
        slot: {
            provider: 'openai_compatible',
            model: 'nemotron-3-ultra-550b-a55b',
            baseURL: 'https://integrate.api.nvidia.com/v1',
            reasoningEffort: 'medium',
        },
        wire: { hasNot: ['thinking', 'reasoning_effort'] },
    },

    // ─── OpenRouter ─────────────────────────────────────────────────────────
    {
        id: 'open_router — effort reaches the body',
        why: 'OpenRouter normalizes reasoning across upstreams via reasoning.effort; a provider-name/namespace mismatch dropped it entirely',
        doc: 'openrouter.ai/docs/docs/best-practices/reasoning-tokens',
        slot: {
            provider: 'open_router',
            model: 'z-ai/glm-5.2',
            reasoningEffort: 'high',
        },
        wire: {
            url: 'https://openrouter.ai/api/v1/chat/completions',
            has: { reasoning: { effort: 'high' } },
        },
    },
    {
        id: 'open_router — provider pin reaches the body',
        why: 'Pinning the upstream is a cost and quality control; dropping it silently routes the org somewhere it explicitly excluded',
        doc: 'openrouter.ai/docs/docs/best-practices/reasoning-tokens',
        slot: {
            provider: 'open_router',
            model: 'z-ai/glm-5.2',
            reasoningEffort: 'high',
            openrouterProviderOrder: ['fireworks'],
            openrouterAllowFallbacks: false,
        },
        wire: {
            has: { provider: { order: ['fireworks'], allow_fallbacks: false } },
        },
    },

    {
        id: 'open_router — the family rules survive the aggregator',
        why: 'OpenRouter is a transport hosting other people\'s models; it does not change what a GLM is. Without delegating the shared traits, an always-thinking glm-5.3 got whatever temperature was stored, and GLM was reported as accepting a FORCED tool_choice its auto-only API rejects — for 17% of production slots',
        doc: 'docs.z.ai/api-reference/llm/chat-completion',
        slot: { provider: 'open_router', model: 'z-ai/glm-5.3', temperature: 0 },
        wire: { has: { temperature: 1 } },
    },
    {
        id: 'open_router — a prefixed OpenAI id is NOT dragged into the compatible table',
        why: 'The shared table only knows the compatible brands, so openai/* and anthropic/* fall to the unknown default — unchanged, and safe because that default never forces a param',
        slot: { provider: 'open_router', model: 'openai/gpt-5.6-luna', temperature: 0.5 },
        wire: { has: { temperature: 0.5 }, hasNot: ['thinking'] },
    },

    // ─── Anthropic, native and proxied ──────────────────────────────────────
    {
        id: 'anthropic/claude 4.6+ — adaptive thinking, temperature withheld',
        why: 'The adaptive generation 400s when a sampling temperature rides along with thinking, so a configured temperature must be dropped, not forwarded',
        doc: 'platform.claude.com/docs/en/build-with-claude/extended-thinking',
        slot: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            temperature: 0,
            maxOutputTokens: 8000,
        },
        wire: {
            url: 'https://api.anthropic.com/v1/messages',
            has: { thinking: { type: 'adaptive' }, max_tokens: 8000 },
            hasNot: ['temperature'],
        },
    },
    {
        id: 'anthropic_compatible/claude-opus-5 — a proxied Claude is still a Claude',
        why: 'Opus 5 REJECTS thinking:{type:"enabled"} with a 400; the compatible branch used to send the budget shape "whatever the id looks like", a guaranteed failure for every 4.7+ model behind a proxy',
        doc: 'platform.claude.com/docs/en/build-with-claude/extended-thinking',
        slot: {
            provider: 'anthropic_compatible',
            model: 'claude-opus-5',
            baseURL: 'https://proxy.test/anthropic',
            reasoningEffort: 'high',
        },
        wire: {
            has: {
                thinking: { type: 'adaptive' },
                output_config: { effort: 'high' },
            },
        },
    },
    {
        id: 'anthropic_compatible/claude-sonnet-4-5 — the older generation keeps the budget',
        why: 'Adaptive thinking is not available on 4.5 and type:"adaptive" 400s there, so the id decides in both directions',
        doc: 'platform.claude.com/docs/en/build-with-claude/extended-thinking',
        slot: {
            provider: 'anthropic_compatible',
            model: 'claude-sonnet-4-5',
            baseURL: 'https://proxy.test/anthropic',
            reasoningEffort: 'high',
        },
        wire: { has: { thinking: { type: 'enabled' } } },
    },
    {
        id: 'anthropic_compatible/glm — a NON-Claude id still gets the compatible shape',
        why: 'Guards the Claude branch above from swallowing the brands that share this transport',
        slot: {
            provider: 'anthropic_compatible',
            model: 'glm-5.2',
            baseURL: 'https://proxy.test/anthropic',
            reasoningEffort: 'high',
        },
        wire: {
            has: { thinking: { type: 'enabled' } },
            hasNot: ['output_config'],
        },
    },
    {
        id: 'anthropic_compatible/k3 — never send a disable to an always-thinking model',
        why: 'k3 has no off switch and rejects thinking:{disabled}; a bare `k3` id used to miss the Kimi family branch entirely and got sent exactly that',
        slot: {
            provider: 'anthropic_compatible',
            model: 'k3',
            baseURL: 'https://api.moonshot.ai/anthropic',
        },
        wire: { notThinkingDisabled: true },
    },

    // ─── Gemini: the shape AND the legal range are per model ─────────────────
    {
        id: 'gemini 3 — thinkingLevel',
        why: 'Gemini 3 carries reasoning as a qualitative level inside generationConfig',
        doc: 'ai.google.dev/gemini-api/docs/thinking',
        slot: {
            provider: 'google_gemini',
            model: 'gemini-3-pro-preview',
            reasoningEffort: 'low',
        },
        wire: {
            has: {
                generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
            },
        },
    },
    {
        id: 'gemini 3-pro-preview — an unsupported level rounds UP instead of being sent',
        why: 'That model takes low and high ONLY, while its 3.1 sibling accepts medium',
        doc: 'ai.google.dev/gemini-api/docs/thinking',
        slot: {
            provider: 'google_gemini',
            model: 'gemini-3-pro-preview',
            reasoningEffort: 'medium',
        },
        wire: {
            has: {
                generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
            },
        },
    },
    {
        id: 'gemini 2.5-pro — budget clamped to the documented ceiling',
        why: 'Range is 128-32,768 and a request outside it is rejected, but our shared effort table says 40,000 for High',
        doc: 'firebase.google.com/docs/ai-logic/thinking',
        slot: {
            provider: 'google_gemini',
            model: 'gemini-2.5-pro',
            reasoningEffort: 'high',
        },
        wire: {
            has: {
                generationConfig: { thinkingConfig: { thinkingBudget: 32768 } },
            },
        },
    },
    {
        id: 'gemini 2.5-flash — the SAME effort clamps to a LOWER ceiling',
        why: 'Flash tops out at 24,576 and Pro at 32,768, so one shared effort-to-budget number cannot serve both',
        doc: 'firebase.google.com/docs/ai-logic/thinking',
        slot: {
            provider: 'google_gemini',
            model: 'gemini-2.5-flash',
            reasoningEffort: 'high',
        },
        wire: {
            has: {
                generationConfig: { thinkingConfig: { thinkingBudget: 24576 } },
            },
        },
    },
    {
        id: 'gemini 2.0-flash — a non-thinking model gets no thinkingConfig',
        why: 'Plain 2.0 predates thinking and appears in no supported list, so the field is unsupported there rather than a no-op',
        doc: 'ai.google.dev/gemini-api/docs/thinking',
        slot: {
            provider: 'google_gemini',
            model: 'gemini-2.0-flash',
            reasoningEffort: 'medium',
        },
        wire: { noThinkingConfig: true },
    },

    // ─── KNOWN GAPS, pinned on purpose ──────────────────────────────────────
    // These assert what we send TODAY, which is nothing. They exist so the gap
    // is visible instead of invisible: each names real production slots whose
    // configured effort never reaches the provider. The day someone implements
    // the mapping these go red — the correct signal to come update them, not a
    // regression. None of them is a crash; all of them are a silently ignored
    // user choice, which is the failure mode this whole file was written after.
    {
        id: 'GAP minimax — effort dropped on the biggest unmapped family',
        why: 'MiniMax M2 documents reasoning_effort as low/medium/high (default medium, "none" rejected) and M3 uses thinking.type. We send neither, so 18 production slots reason at the vendor default and the level the user picked is ignored',
        slot: {
            provider: 'openai_compatible',
            model: 'MiniMax-M3',
            baseURL: 'https://api.minimax.io/v1',
            reasoningEffort: 'high',
        },
        wire: { hasNot: ['thinking', 'reasoning_effort'] },
    },
    {
        id: 'GAP novita — no reasoning mapping, so a chosen effort is dropped',
        why: 'The module has no reasoning(). All 4 production novita slots are DeepSeek on effort=high; DeepSeek thinks by default so they still reason, just never at the level asked for',
        slot: {
            provider: 'novita',
            model: 'deepseek/deepseek-v4-pro',
            reasoningEffort: 'high',
        },
        wire: {
            url: 'https://api.novita.ai/v3/openai/chat/completions',
            hasNot: ['thinking', 'reasoning_effort'],
        },
    },
    {
        id: 'GAP amazon_bedrock — no reasoning mapping on the Converse API',
        why: 'Bedrock Claude supports thinking via additionalModelRequestFields but the module sends none, so two production slots (claude-opus-4-7 and 4-8, both effort=high) get NO reasoning at all. Unverified against a live AWS account, so pinned rather than guessed',
        slot: {
            provider: 'amazon_bedrock',
            awsRegion: 'us-east-1',
            model: 'anthropic.claude-opus-4-8',
            reasoningEffort: 'high',
        },
        wire: { hasNot: ['thinking', 'additionalModelRequestFields'] },
    },

    // ─── native OpenAI ──────────────────────────────────────────────────────
    {
        id: 'openai native — reasoning effort on the Responses API',
        why: 'Native OpenAI goes through /v1/responses, where reasoning is an object rather than a string field',
        slot: { provider: 'openai', model: 'gpt-5.4', reasoningEffort: 'high' },
        wire: {
            url: 'https://api.openai.com/v1/responses',
            has: { reasoning: { effort: 'high' } },
        },
    },
];

/** Models known to reason ALWAYS, with no way to turn it off. Sending them a
 *  disable is a 400. Kept here as an independent oracle so a regression in the
 *  provider trait table cannot make this check vacuously pass. */
const ALWAYS_THINKING = [
    /^k3/i,
    /kimi.*k2\.7-code/i,
    /k2\.7-code/i,
    /glm-?5\.3/i,
];

function contains(actual: any, expected: any): boolean {
    if (expected === null || typeof expected !== 'object')
        return actual === expected;
    if (actual === null || typeof actual !== 'object') return false;
    if (Array.isArray(expected)) {
        return (
            Array.isArray(actual) &&
            actual.length === expected.length &&
            expected.every((v, i) => contains(actual[i], v))
        );
    }
    return Object.entries(expected).every(([k, v]) => contains(actual[k], v));
}

describe('BYOK config matrix — config in, wire out', () => {
    for (const c of CASES) {
        it(`${c.id} — ${c.why}${c.doc ? ` (${c.doc})` : ''}`, async () => {
            const w = await captureByokWire({
                apiKey: 'k',
                ...c.slot,
            } as NormalizedModel);
            if (c.wire.url) expect(w.url).toBe(c.wire.url);
            if (c.wire.has) {
                expect({
                    body: w.body,
                    ok: contains(w.body, c.wire.has),
                }).toEqual({ body: w.body, ok: true });
            }
            for (const missing of c.wire.hasNot ?? []) {
                expect({
                    field: missing,
                    body: w.body,
                    present: missing in w.body,
                }).toEqual({ field: missing, body: w.body, present: false });
            }
            if (c.wire.notThinkingDisabled) {
                expect(w.body?.thinking?.type).not.toBe('disabled');
            }
            if (c.wire.noThinkingConfig) {
                expect(
                    w.body?.generationConfig?.thinkingConfig,
                ).toBeUndefined();
            }
        });
    }
});

/**
 * The same contract, replayed over EVERY distinct BYOK config shape currently
 * stored in production (`__fixtures__/byok-prod-shapes.json`, 322 shapes over
 * 495 slots).
 *
 * ANONYMIZED, and it must stay that way — this repo is public. Org ids and
 * credentials are stripped, and every baseURL host that is not a documented
 * PUBLIC vendor endpoint is replaced with `redacted-N.…`. Customer endpoints are
 * personal domains, home labs, ngrok tunnels and named cloud resources; they
 * identify people. The redaction preserves only what the invariants read —
 * scheme, path shape, and whether the host is private — never the identity.
 * Refresh it by re-exporting the org-parameters rows AND re-running that
 * redaction; the invariants below are what must hold for all of them.
 *
 * These are INVARIANTS, not snapshots: they stay green as models come and go,
 * and go red only when a real config becomes unservable.
 */
describe('production config shapes — invariants', () => {
    // `google_vertex` is the ONE provider this harness cannot exercise: its build
    // needs a real service-account JSON, and with a placeholder it falls through
    // to a different client entirely, so an assertion here would describe the
    // fallback rather than Vertex. It is 1 production slot, and the weekly live
    // tier is where it has to be covered. Bedrock DOES build offline (region +
    // placeholder key are enough to shape the Converse URL), so it is swept.
    const UNEXERCISABLE = ['google_vertex'];
    const runnable = PROD_SHAPES.filter(
        (s: any) => !UNEXERCISABLE.includes(s.provider),
    );

    it('the production corpus is actually loaded', () => {
        // Without this, a missing or emptied fixture turns every invariant below
        // into a green assertion over an empty array — the exact failure the
        // .gitignore un-ignore rule for that file exists to prevent.
        expect(PROD_SHAPES.length).toBeGreaterThan(200);
        expect(runnable.length).toBeGreaterThan(200);
    });

    it('every stored shape produces a request (nothing throws before the network)', async () => {
        const broken: any[] = [];
        for (const shape of runnable) {
            const { orgs, ...slot } = shape as any;
            try {
                await captureByokWire({ ...slot, apiKey: 'k' });
            } catch (e) {
                broken.push({
                    provider: slot.provider,
                    model: slot.model,
                    err: String(e).slice(0, 140),
                });
            }
        }
        expect(broken).toEqual([]);
    }, 180000);

    it('every stored baseURL that would double the endpoint path is caught by the save guard', async () => {
        // This does NOT assert that no such config exists — one does, in
        // production, on both slots of a live org. It asserts that the guard
        // recognises every one of them, so the org is told what to fix instead of
        // 404ing on every review forever.
        const doubled: any[] = [];
        for (const shape of runnable) {
            const { orgs, ...slot } = shape as any;
            const w = await captureByokWire({ ...slot, apiKey: 'k' }).catch(
                () => null,
            );
            if (!w) continue;
            const path = new URL(w.url).pathname;
            if (
                (path.match(/\/chat\/completions/g) || []).length > 1 ||
                (path.match(/\/v1\/messages/g) || []).length > 1
            ) {
                doubled.push(slot.baseURL);
            }
        }
        const unguarded = doubled.filter((b) => !describeBaseUrlProblem(b));
        expect(unguarded).toEqual([]);
    }, 180000);

    it('never sends a thinking DISABLE to a model that cannot stop thinking', async () => {
        const bad: any[] = [];
        for (const shape of runnable) {
            const { orgs, ...slot } = shape as any;
            if (!ALWAYS_THINKING.some((re) => re.test(String(slot.model))))
                continue;
            const w = await captureByokWire({ ...slot, apiKey: 'k' }).catch(
                () => null,
            );
            if (w?.body?.thinking?.type === 'disabled') {
                bad.push({ provider: slot.provider, model: slot.model });
            }
        }
        expect(bad).toEqual([]);
    }, 180000);
});
