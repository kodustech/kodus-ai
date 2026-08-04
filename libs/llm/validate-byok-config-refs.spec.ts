import {
    validateByokConfigRefs,
    findModelReferences,
} from './validate-byok-config-refs';
import type { BYOKConfig } from './byok-config';

const v2 = (over: Partial<BYOKConfig> = {}): BYOKConfig => ({
    version: 2,
    credentials: [{ id: 'cred-openai', provider: 'openai', apiKey: 'enc(k)' }],
    models: [
        { id: 'model-a', credentialId: 'cred-openai', model: 'gpt-5' },
    ],
    ...over,
});

describe('validateByokConfigRefs', () => {
    describe('valid v2 configs', () => {
        it('passes when every model.credentialId and every routing ref resolves', () => {
            const config = v2({
                credentials: [
                    { id: 'cred-openai', provider: 'openai', apiKey: 'enc(k)' },
                ],
                models: [
                    { id: 'model-a', credentialId: 'cred-openai', model: 'gpt-5' },
                    { id: 'model-b', credentialId: 'cred-openai', model: 'gpt-5-mini' },
                ],
                routing: {
                    mode: 'manual',
                    defaultModelId: 'model-a',
                    fallbackModelId: 'model-b',
                    taskOverrides: {
                        codeReview: 'model-a',
                        prSummary: 'model-b',
                    },
                },
            });

            const result = validateByokConfigRefs(config);

            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
        });

        it('passes a config with no routing block', () => {
            const result = validateByokConfigRefs(v2({ routing: undefined }));
            expect(result).toEqual({ valid: true, errors: [] });
        });
    });

    describe('dangling model.credentialId is rejected', () => {
        it('fails and names the offending model id + missing credentialId', () => {
            const config = v2({
                credentials: [
                    { id: 'cred-openai', provider: 'openai', apiKey: 'enc(k)' },
                ],
                models: [
                    { id: 'model-a', credentialId: 'cred-openai', model: 'gpt-5' },
                    { id: 'model-x', credentialId: 'cred-ghost', model: 'gpt-5' },
                ],
            });

            const result = validateByokConfigRefs(config);

            expect(result.valid).toBe(false);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]).toContain('model-x');
            expect(result.errors[0]).toContain('cred-ghost');
            // never leaks key material
            expect(result.errors[0]).not.toContain('enc(');
        });
    });

    describe('dangling routing refs are rejected', () => {
        it('fails when defaultModelId points at a missing model', () => {
            const config = v2({
                routing: { defaultModelId: 'model-missing' },
            });
            const result = validateByokConfigRefs(config);
            expect(result.valid).toBe(false);
            expect(result.errors[0]).toContain('routing.defaultModelId');
            expect(result.errors[0]).toContain('model-missing');
        });

        it('fails when fallbackModelId points at a missing model', () => {
            const config = v2({
                routing: { fallbackModelId: 'nope' },
            });
            const result = validateByokConfigRefs(config);
            expect(result.valid).toBe(false);
            expect(result.errors[0]).toContain('routing.fallbackModelId');
            expect(result.errors[0]).toContain('nope');
        });

        it('fails when a taskOverride points at a missing model, naming the task', () => {
            const config = v2({
                routing: { taskOverrides: { conversation: 'ghost-model' } },
            });
            const result = validateByokConfigRefs(config);
            expect(result.valid).toBe(false);
            expect(result.errors[0]).toContain('routing.taskOverrides.conversation');
            expect(result.errors[0]).toContain('ghost-model');
        });

        it('collects multiple errors across models and routing', () => {
            const config = v2({
                models: [
                    { id: 'model-a', credentialId: 'cred-ghost', model: 'gpt-5' },
                ],
                routing: {
                    defaultModelId: 'missing-1',
                    taskOverrides: { codeReview: 'missing-2' },
                },
            });
            const result = validateByokConfigRefs(config);
            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThanOrEqual(3);
        });
    });

    describe('legacy / non-v2 is a no-op pass', () => {
        it('passes a legacy {main,fallback} config', () => {
            const legacy = {
                main: { provider: 'openai', apiKey: 'enc(k)', model: 'gpt-5' },
                fallback: { provider: 'anthropic', apiKey: 'enc(k2)', model: 'claude' },
            };
            expect(validateByokConfigRefs(legacy)).toEqual({
                valid: true,
                errors: [],
            });
        });

        it('passes undefined / null / primitives', () => {
            expect(validateByokConfigRefs(undefined).valid).toBe(true);
            expect(validateByokConfigRefs(null).valid).toBe(true);
            expect(validateByokConfigRefs(42).valid).toBe(true);
        });
    });
});

describe('findModelReferences', () => {
    it('returns every routing ref pointing at the given model id', () => {
        const config = v2({
            models: [
                { id: 'model-a', credentialId: 'cred-openai', model: 'gpt-5' },
                { id: 'model-b', credentialId: 'cred-openai', model: 'gpt-5-mini' },
            ],
            routing: {
                defaultModelId: 'model-a',
                fallbackModelId: 'model-a',
                taskOverrides: {
                    codeReview: 'model-a',
                    prSummary: 'model-b',
                },
            },
        });

        const refs = findModelReferences(config, 'model-a');

        expect(refs).toContain('routing.defaultModelId');
        expect(refs).toContain('routing.fallbackModelId');
        expect(refs).toContain('routing.taskOverrides.codeReview');
        expect(refs).not.toContain('routing.taskOverrides.prSummary');
    });

    it('returns [] when no routing ref points at the model', () => {
        const config = v2({ routing: { defaultModelId: 'model-a' } });
        expect(findModelReferences(config, 'model-unused')).toEqual([]);
    });

    it('returns [] for a legacy config or an empty model id', () => {
        expect(findModelReferences({ main: {} }, 'model-a')).toEqual([]);
        expect(findModelReferences(v2(), '')).toEqual([]);
    });
});
