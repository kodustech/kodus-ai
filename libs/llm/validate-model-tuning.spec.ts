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

    // The save-time answer follows the same source as the runtime one, and it
    // had to change with it: platform.kimi.ai documents k2.7-code's temperature
    // as not modifiable, so the form must say "clear this field", not "set it to
    // 1". Telling a user to type a value the model never reads is the same
    // failure as sending it — it just costs them a save first.
    it.each(TRANSPORTS)(
        '%s / kimi-k2.7-code + ANY temperature → told to clear the field',
        (provider) => {
            // 1 is included on purpose. Under the pin it was the one value that
            // passed validation, which meant the form actively taught the value
            // it should have been rejecting.
            for (const temperature of [0.2, 1]) {
                const issues = validateModelTuning({
                    provider,
                    model: 'kimi-k2.7-code',
                    temperature,
                });
                expect(issues).toHaveLength(1);
                expect(issues[0].field).toBe('temperature');
                expect(issues[0].message.toLowerCase()).toContain(
                    'kimi-k2.7-code',
                );
                expect(issues[0].message.toLowerCase()).toContain(
                    'does not accept a temperature',
                );
            }
        },
    );

    it.each(TRANSPORTS)(
        '%s / kimi-k2.6 + a temperature → told to clear it, on every transport',
        (provider) => {
            // k2.6 passed validation on all four transports before, because it
            // can disable thinking and that was read as "ordinary adjustable
            // model". The two facts are independent.
            const issues = validateModelTuning({
                provider,
                model: 'kimi-k2.6',
                temperature: 0.2,
            });
            expect(issues).toHaveLength(1);
            expect(issues[0].field).toBe('temperature');
            expect(issues[0].message.toLowerCase()).toContain(
                'does not accept a temperature',
            );
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

describe('validateModelTuning — a constraint scoped to thinking, not to the model', () => {
    // DeepSeek: "Thinking mode does not support the temperature, top_p,
    // presence_penalty, or frequency_penalty parameters". The form must warn
    // while reasoning is on and stay quiet once it is off — warning either way
    // would be wrong in one of the two states.
    it('warns about a temperature on DeepSeek while reasoning is on', () => {
        const issues = validateModelTuning({
            provider: 'openai_compatible',
            model: 'deepseek-v4-pro',
            temperature: 0.2,
            reasoningEffort: 'high',
        });
        expect(issues.map((i) => i.field)).toContain('temperature');
    });

    it('does NOT warn once reasoning is explicitly off', () => {
        const issues = validateModelTuning({
            provider: 'openai_compatible',
            model: 'deepseek-v4-pro',
            temperature: 0.2,
            reasoningEffort: 'none',
        });
        expect(issues.map((i) => i.field)).not.toContain('temperature');
    });

    it('warns when no effort is given — the family default is thinking ON', () => {
        const issues = validateModelTuning({
            provider: 'openai_compatible',
            model: 'deepseek-v4-pro',
            temperature: 0.2,
        });
        expect(issues.map((i) => i.field)).toContain('temperature');
    });
});

describe('validateModelTuning — free models and safe fallbacks', () => {
    it('kimi-k2.5 (no vendor constraint) + temperature 0.2 → no issue', () => {
        // This case used to name k2.6, which the vendor documents as having an
        // unmodifiable temperature — it now belongs with the flagged models
        // above. Re-pointed at k2.5 rather than deleted, because the thing being
        // guarded here is still needed: a Kimi with no documented constraint must
        // NOT inherit its siblings' restriction and lose a setting that works.
        expect(
            validateModelTuning({
                provider: 'anthropic_compatible',
                model: 'kimi-k2.5',
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
