/**
 * Contract: every provider's Custom-reasoning placeholder is the shape that
 * model's transport actually accepts — the web picker shows it verbatim, so a
 * wrong example is a config the user pastes and that silently 400s or drops.
 *
 * The generic front-end fallback used to be `{ thinking: { type: "enabled" } }`,
 * which is wrong for OpenAI-effort transports (Azure), a dead key for Bedrock's
 * `reasoningConfig` envelope, and budget-less for the Anthropic-protocol brands
 * (Kimi/GLM) that REQUIRE a token budget. Each module now owns its own example;
 * this pins them so a regression can't quietly send everyone back to the generic.
 *
 * The complementary proof that these examples reach the WIRE (change the request
 * body, per key) lives in `byok-config-matrix.spec.ts`; here we pin the exact
 * shape each module hands the UI.
 */
import './index'; // side-effect: registers every provider module in REGISTRY
import { REGISTRY } from './kernel/registry';

const example = (id: string, model?: string): string | undefined =>
    REGISTRY.get(id).reasoningOverrideExample?.(id, model);

const parsed = (id: string, model?: string): any =>
    JSON.parse(example(id, model) as string);

describe('reasoningOverrideExample — per-provider Custom placeholder', () => {
    it('native Anthropic → adaptive thinking + effort (4.6+ shape)', () => {
        expect(parsed('anthropic', 'claude-opus-4-8')).toEqual({
            thinking: { type: 'adaptive' },
            effort: 'high',
        });
    });

    it('anthropic_compatible (Kimi/GLM/DeepSeek) → legacy thinking WITH a budget', () => {
        // The whole point of the fix: `type:enabled` without budgetTokens 400s
        // on these upstreams ("thinking.budget_tokens: required").
        // Keyed off the provider id (how the web calls it), not the model.
        const p = parsed('anthropic_compatible', 'kimi-k2.6');
        expect(p.thinking.type).toBe('enabled');
        expect(typeof p.thinking.budgetTokens).toBe('number');
        expect(p.thinking.budgetTokens).toBeGreaterThan(0);
    });

    it('Azure → OpenAI reasoningEffort, never a thinking block', () => {
        expect(parsed('azure', 'o3-mini')).toEqual({ reasoningEffort: 'high' });
    });

    it('Bedrock adaptive Claude → reasoningConfig{adaptive,maxReasoningEffort}', () => {
        expect(
            parsed('amazon_bedrock', 'anthropic.claude-opus-4-8'),
        ).toEqual({
            reasoningConfig: { type: 'adaptive', maxReasoningEffort: 'high' },
        });
    });

    it('Bedrock legacy Claude → reasoningConfig{enabled,budgetTokens}', () => {
        const p = parsed(
            'amazon_bedrock',
            'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        );
        expect(p.reasoningConfig.type).toBe('enabled');
        expect(typeof p.reasoningConfig.budgetTokens).toBe('number');
    });

    it('Bedrock non-Anthropic family → no example (Custom is disabled there)', () => {
        expect(example('amazon_bedrock', 'minimax.minimax-m2')).toBeUndefined();
    });

    it('Novita → OpenAI-compatible thinking toggle', () => {
        expect(parsed('novita', 'deepseek/deepseek-v4-pro')).toEqual({
            thinking: { type: 'enabled' },
        });
    });

    it.each(['moonshot', 'zai'])(
        'brand %s → Anthropic-protocol legacy thinking WITH a budget',
        (id) => {
            const p = parsed(id, 'kimi-k2.6');
            expect(p.thinking.type).toBe('enabled');
            expect(typeof p.thinking.budgetTokens).toBe('number');
        },
    );

    it('every example a module ships is valid JSON', () => {
        for (const id of REGISTRY.ids()) {
            const mod = REGISTRY.get(id);
            if (!mod.reasoningOverrideExample) continue;
            // A couple of representative models per module; undefined is allowed
            // (it means "no example for this model"), a non-JSON string is not.
            for (const model of [
                'claude-opus-4-8',
                'o3-mini',
                'kimi-k2.6',
                undefined as any,
            ]) {
                const ex = mod.reasoningOverrideExample(id, model);
                if (ex === undefined) continue;
                expect(() => JSON.parse(ex)).not.toThrow();
            }
        }
    });
});
