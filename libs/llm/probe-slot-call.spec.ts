// @ts-nocheck
// 
import {
    noRedirectFetch,
    probeMaxOutputTokens,
    reasoningBudgetFrom,
    slotForProbe,
} from './probe-slot-call';

describe('reasoningBudgetFrom', () => {
    it('finds the budget in the Anthropic namespace shape', () => {
        expect(
            reasoningBudgetFrom({
                anthropic: { thinking: { type: 'enabled', budgetTokens: 8000 } },
            }),
        ).toBe(8000);
    });

    it('finds a snake_case budget (compatible upstreams)', () => {
        expect(
            reasoningBudgetFrom({
                openaiCompatible: { thinking: { budget_tokens: 2048 } },
            }),
        ).toBe(2048);
    });

    it('takes the largest when several namespaces declare one', () => {
        expect(
            reasoningBudgetFrom({
                anthropic: { thinking: { budgetTokens: 1000 } },
                other: { nested: { deep: { budget_tokens: 4096 } } },
            }),
        ).toBe(4096);
    });

    it('is undefined when no budget is declared (effort-style reasoning)', () => {
        expect(
            reasoningBudgetFrom({ openrouter: { reasoning: { effort: 'high' } } }),
        ).toBeUndefined();
        expect(reasoningBudgetFrom({})).toBeUndefined();
        expect(reasoningBudgetFrom(undefined)).toBeUndefined();
    });

    it('ignores a non-numeric budget instead of trusting it', () => {
        expect(
            reasoningBudgetFrom({ anthropic: { thinking: { budgetTokens: 'lots' } } }),
        ).toBeUndefined();
    });
});

describe('probeMaxOutputTokens', () => {
    it('uses the small floor when nothing reasons', () => {
        expect(probeMaxOutputTokens({})).toBe(16);
    });

    // A thinking model rejects max_tokens <= budget, so a 1-token probe would
    // fail a config that actually works.
    it('clears the reasoning budget with headroom', () => {
        expect(
            probeMaxOutputTokens({
                anthropic: { thinking: { budgetTokens: 8000 } },
            }),
        ).toBeGreaterThan(8000);
    });
});

describe('slotForProbe', () => {
    const slot = {
        provider: 'anthropic',
        apiKey: 'cipher',
        model: 'claude-x',
        baseURL: 'https://api.example.com',
        temperature: 1,
        reasoningEffort: 'high',
        reasoningConfigOverride: '{"thinking":{"budgetTokens":100}}',
        maxOutputTokens: 4096,
        rpm: 10,
        tpm: 1000,
        cooldownMs: 60000,
        maxConcurrentRequests: 2,
        fallback: { provider: 'openai', apiKey: 'x', model: 'gpt' },
    };

    it('drops the throughput policy — a rate limit must not stall the connect form', () => {
        const probed = slotForProbe(slot);
        expect(probed.rpm).toBeUndefined();
        expect(probed.tpm).toBeUndefined();
        expect(probed.cooldownMs).toBeUndefined();
        expect(probed.maxConcurrentRequests).toBeUndefined();
    });

    it('never probes the fallback — the Test is about the model being saved', () => {
        expect(slotForProbe(slot).fallback).toBeUndefined();
    });

    it('keeps every field that shapes the inference itself', () => {
        const probed = slotForProbe(slot);
        expect(probed).toMatchObject({
            provider: 'anthropic',
            apiKey: 'cipher',
            model: 'claude-x',
            baseURL: 'https://api.example.com',
            temperature: 1,
            reasoningEffort: 'high',
            reasoningConfigOverride: '{"thinking":{"budgetTokens":100}}',
            maxOutputTokens: 4096,
        });
    });
});

/**
 * Regression guard for the SSRF hardening in b7a23abb7 (CodeQL,
 * js/request-forgery). The gate resolves the host the user typed and rejects
 * private targets, but it can only vouch for THAT host — the original axios
 * probe also set `maxRedirects: 0` so a 30x couldn't bounce the request to
 * link-local space afterwards. `fetch` follows redirects by default, so moving
 * the probe onto the SDK silently dropped that half of the mitigation; this
 * pins it back.
 */
describe('noRedirectFetch', () => {
    const original = global.fetch;
    afterEach(() => {
        global.fetch = original;
    });

    it('never lets the transport follow a redirect', async () => {
        const spy = jest.fn().mockResolvedValue({ ok: true });
        global.fetch = spy as any;

        await noRedirectFetch('https://provider.example/v1/messages', {
            method: 'POST',
        });

        expect(spy).toHaveBeenCalledWith(
            'https://provider.example/v1/messages',
            expect.objectContaining({ redirect: 'error' }),
        );
    });

    it('keeps the caller options it was given', async () => {
        const spy = jest.fn().mockResolvedValue({ ok: true });
        global.fetch = spy as any;

        await noRedirectFetch('https://provider.example/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': 'sk-test' },
        });

        expect(spy.mock.calls[0][1]).toMatchObject({
            method: 'POST',
            headers: { 'x-api-key': 'sk-test' },
            redirect: 'error',
        });
    });
});
