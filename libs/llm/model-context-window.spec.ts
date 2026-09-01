import {
    getModelContextWindow,
    resolveContextWindow,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
} from './model-context-window';

describe('model-context-window', () => {
    describe('DEFAULT_CONTEXT_WINDOW_TOKENS', () => {
        it('pins the conservative default literal', () => {
            expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(128_000);
        });
    });

    describe('getModelContextWindow — input guards', () => {
        it('returns the default for undefined', () => {
            expect(getModelContextWindow(undefined)).toBe(128_000);
        });

        it('returns the default for missing argument', () => {
            expect(getModelContextWindow()).toBe(128_000);
        });

        it('returns the default for empty string (falsy guard)', () => {
            expect(getModelContextWindow('')).toBe(128_000);
        });

        it('returns the default for null', () => {
            expect(getModelContextWindow(null as any)).toBe(128_000);
        });

        it('returns the default for a non-string value (typeof guard)', () => {
            // A number is truthy, so this only returns the default if the
            // `typeof !== 'string'` half of the guard is honored.
            expect(getModelContextWindow(123 as any)).toBe(128_000);
        });
    });

    describe('getModelContextWindow — manual overrides are a LAST resort', () => {
        // These used to run first and match by substring, so a hand-typed number
        // for an older model silently overruled real data for a newer sibling
        // that merely shared its prefix. Precision decides precedence now.

        it('real data beats a hand-typed number for the same model', () => {
            // 'gpt-5' had an override of 400k. The mirror says 272k, and the
            // mirror is the sourced answer.
            expect(getModelContextWindow('gpt-5')).toBe(272_000);
        });

        it('a prefix sibling no longer inherits the older model\'s window', () => {
            // THE BUG: 'claudeopus47'.includes('claudeopus4') was true, so
            // claude-opus-4-7 and -4-8 — both live in production, both rated at
            // 1M upstream — were pinned to the 4.x override of 200k. An
            // eightfold under-chunk that never raised an error.
            expect(getModelContextWindow('claude-opus-4-7')).toBe(1_000_000);
            expect(getModelContextWindow('deepseek-v4-flash')).toBe(1_000_000);
            expect(getModelContextWindow('gpt-5-4')).toBe(1_050_000);
        });

        it('an override still answers for a model the mirror does not carry', () => {
            // This is the only job left for the table: Moonshot and Z.ai ids are
            // genuinely absent upstream, so the stopgap still applies — just
            // after the mirror has been asked.
            expect(getModelContextWindow('moonshot/kimi-k2')).toBe(262_144);
            expect(getModelContextWindow('glm-4-7')).toBe(202_752);
        });

        it('an override that agrees with the mirror is simply redundant', () => {
            // claude-sonnet-4-5 was in both, with the same number. Deleting the
            // duplicate changes nothing, which is the point of deleting it.
            expect(getModelContextWindow('claude-sonnet-4-5')).toBe(200_000);
        });
    });

    describe('getModelContextWindow — LiteLLM database resolution', () => {
        it('resolves an exact key from the LiteLLM database', () => {
            expect(getModelContextWindow('ai21.jamba-instruct-v1:0')).toBe(70_000);
        });

        it('prefers the exact direct match over the normalized index on collision', () => {
            // 'azure/gpt-3.5-turbo' direct value is 4097; the normalized index
            // for 'gpt35turbo' resolves to 16385 (a later key overwrote it).
            // The direct-match branch must win here.
            expect(getModelContextWindow('azure/gpt-3.5-turbo')).toBe(4097);
        });

        it('resolves via the normalized index when the raw key does not match', () => {
            // Differently-cased/punctuated form: direct MODELS lookup misses,
            // normalized index for 'ai21jambainstructv10' hits -> 70000.
            expect(getModelContextWindow('AI21_Jamba-Instruct-V1:0')).toBe(70_000);
        });

        it('resolves gpt-3.5-turbo to its exact database value', () => {
            expect(getModelContextWindow('gpt-3.5-turbo')).toBe(16_385);
        });

        it('resolves gpt-4 to its exact database value', () => {
            expect(getModelContextWindow('gpt-4')).toBe(8_192);
        });

        it('resolves via the longest substring match when nothing else hits', () => {
            // 'jamba-instruct' -> 'jambainstruct' is not an exact key nor a
            // normalized-index key. Substring match picks the LONGEST key that
            // contains it: 'snowflake/jamba-instruct' -> 256000.
            expect(getModelContextWindow('jamba-instruct')).toBe(256_000);
        });
    });

    describe('getModelContextWindow — normalize behavior (observable)', () => {
        it('lowercases and strips dash separators before matching', () => {
            // 'GPT-5' must normalize to 'gpt5' to hit the mirror. If either
            // lowercasing or separator removal is dropped, this falls to default.
            expect(getModelContextWindow('GPT-5')).toBe(272_000);
        });

        it('strips underscore separators before matching', () => {
            expect(getModelContextWindow('GPT_5')).toBe(272_000);
        });

        it('falls back to default for a genuinely unknown model', () => {
            expect(getModelContextWindow('totally-unknown-xyz-model')).toBe(
                128_000,
            );
        });
    });

    describe('resolveContextWindow', () => {
        it('returns the explicit BYOK maxInputTokens when positive', () => {
            expect(
                resolveContextWindow({
                    byokMaxInputTokens: 999,
                    modelName: 'gpt-5',
                }),
            ).toBe(999);
        });

        it('honors a BYOK value of exactly 1 (boundary just above 0)', () => {
            expect(
                resolveContextWindow({
                    byokMaxInputTokens: 1,
                    modelName: 'gpt-5',
                }),
            ).toBe(1);
        });

        it('falls through model lookup when BYOK is exactly 0 (boundary)', () => {
            // 0 is a number but not > 0, so the guard must NOT fire.
            expect(
                resolveContextWindow({
                    byokMaxInputTokens: 0,
                    modelName: 'gpt-5',
                }),
            ).toBe(272_000);
        });

        it('falls through model lookup when BYOK is negative', () => {
            expect(
                resolveContextWindow({
                    byokMaxInputTokens: -5,
                    modelName: 'gpt-5',
                }),
            ).toBe(272_000);
        });

        it('falls through model lookup when BYOK is undefined', () => {
            expect(resolveContextWindow({ modelName: 'gpt-5' })).toBe(272_000);
        });

        it('falls through when BYOK is NaN (not > 0)', () => {
            expect(
                resolveContextWindow({
                    byokMaxInputTokens: NaN,
                    modelName: 'gpt-5',
                }),
            ).toBe(272_000);
        });

        it('ignores a non-number BYOK value (typeof guard) and uses the model', () => {
            expect(
                resolveContextWindow({
                    byokMaxInputTokens: '999' as any,
                    modelName: 'gpt-5',
                }),
            ).toBe(272_000);
        });

        it('returns the default when both BYOK and model are absent', () => {
            expect(resolveContextWindow({})).toBe(128_000);
        });
    });
});
