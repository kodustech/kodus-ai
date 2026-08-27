/**
 * CONTRACT — the tuning a user configures for a BYOK slot is validated against
 * the MODEL's own rules, transport-agnostically. The runtime silently self-
 * corrects a mis-set value (a `fixed` temperature is sent over whatever is
 * stored), so a mismatch never surfaces at review time; this validator is the ONE
 * place the connect Test learns the value won't be honored and tells the user.
 *
 * The guarantees pinned here:
 *   1. An always-thinking model (Kimi k2.7-code/k3, GLM-5.3) with a temperature
 *      other than its pinned 1 → a temperature issue, on EVERY transport that can
 *      host it (anthropic_compatible, openai_compatible, novita, the brand).
 *   2. Turning reasoning OFF on an always-thinking model → a reasoning issue.
 *   3. A native Anthropic model that rejects temperature (4.7+/5) with any
 *      temperature set → a temperature issue.
 *   4. A free model (Kimi k2.6, a plain upstream) with any tuning → NO issue.
 *   5. Unknown/absent provider, or no tuning set → NO issue (never throws).
 */
import { validateModelTuning } from './validate-model-tuning';

describe('validateModelTuning — always-thinking temperature pin (every transport)', () => {
    // The same always-thinking Kimi obeys the same rule wherever it is hosted.
    const TRANSPORTS = [
        'anthropic_compatible',
        'openai_compatible',
        'novita',
        'moonshot',
    ];

    it.each(TRANSPORTS)(
        '%s / kimi-k2.7-code + temperature 0.2 → temperature issue',
        (provider) => {
            const issues = validateModelTuning({
                provider,
                model: 'kimi-k2.7-code',
                temperature: 0.2,
            });
            expect(issues).toHaveLength(1);
            expect(issues[0].field).toBe('temperature');
            expect(issues[0].message).toContain('1');
            expect(issues[0].message.toLowerCase()).toContain('kimi-k2.7-code');
        },
    );

    it.each(TRANSPORTS)(
        '%s / kimi-k2.7-code + temperature 1 → no issue (matches the pin)',
        (provider) => {
            expect(
                validateModelTuning({
                    provider,
                    model: 'kimi-k2.7-code',
                    temperature: 1,
                }),
            ).toEqual([]);
        },
    );

    it.each(TRANSPORTS)(
        '%s / kimi-k2.7-code + no temperature → no issue',
        (provider) => {
            expect(
                validateModelTuning({
                    provider,
                    model: 'kimi-k2.7-code',
                }),
            ).toEqual([]);
        },
    );

    it('glm-5.3 (always-thinking) + temperature 0 → temperature issue', () => {
        const issues = validateModelTuning({
            provider: 'zai',
            model: 'glm-5.3',
            temperature: 0,
        });
        expect(issues).toHaveLength(1);
        expect(issues[0].field).toBe('temperature');
    });
});

describe('validateModelTuning — reasoning off on an always-thinking model', () => {
    it('kimi-k2.7-code + reasoningEffort "none" → reasoning issue', () => {
        const issues = validateModelTuning({
            provider: 'anthropic_compatible',
            model: 'kimi-k2.7-code',
            reasoningEffort: 'none',
        });
        expect(issues).toHaveLength(1);
        expect(issues[0].field).toBe('reasoning');
        expect(issues[0].message.toLowerCase()).toContain('always reasons');
    });

    it('a temperature AND an off-reasoning mismatch → both issues', () => {
        const issues = validateModelTuning({
            provider: 'novita',
            model: 'kimi-k2.7-code',
            temperature: 0.5,
            reasoningEffort: 'none',
        });
        expect(issues.map((i) => i.field).sort()).toEqual([
            'reasoning',
            'temperature',
        ]);
    });

    it('kimi-k2.6 (can disable) + reasoningEffort "none" → no issue', () => {
        expect(
            validateModelTuning({
                provider: 'anthropic_compatible',
                model: 'kimi-k2.6',
                reasoningEffort: 'none',
            }),
        ).toEqual([]);
    });
});

describe('validateModelTuning — native Anthropic that rejects temperature', () => {
    it('claude-opus-5 (4.7+/5 rejects temperature) + temperature 0.3 → issue', () => {
        const issues = validateModelTuning({
            provider: 'anthropic',
            model: 'claude-opus-5',
            temperature: 0.3,
        });
        expect(issues).toHaveLength(1);
        expect(issues[0].field).toBe('temperature');
        expect(issues[0].message.toLowerCase()).toContain('does not accept');
    });

    it('claude-opus-5 + no temperature → no issue', () => {
        expect(
            validateModelTuning({
                provider: 'anthropic',
                model: 'claude-opus-5',
            }),
        ).toEqual([]);
    });
});

describe('validateModelTuning — free models and safe fallbacks', () => {
    it('kimi-k2.6 (adjustable) + temperature 0.2 → no issue', () => {
        expect(
            validateModelTuning({
                provider: 'anthropic_compatible',
                model: 'kimi-k2.6',
                temperature: 0.2,
            }),
        ).toEqual([]);
    });

    it('a plain upstream over openai_compatible + any temperature → no issue', () => {
        expect(
            validateModelTuning({
                provider: 'openai_compatible',
                model: 'llama-3-70b',
                temperature: 0.7,
            }),
        ).toEqual([]);
    });

    it('unknown provider → no issue (never throws)', () => {
        expect(
            validateModelTuning({
                provider: 'not-a-provider',
                model: 'x',
                temperature: 0.2,
            }),
        ).toEqual([]);
    });

    it('no provider / no tuning → no issue', () => {
        expect(validateModelTuning({})).toEqual([]);
        expect(
            validateModelTuning({ provider: 'novita', model: 'kimi-k2.7-code' }),
        ).toEqual([]);
    });
});
