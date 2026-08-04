import { collectByokModels } from './collect-byok-models';
import type { BYOKConfig } from '@libs/llm/byok-config';

/** Build a minimal config carrying only the model ids under test. */
const v2 = (models: string[]): BYOKConfig => ({
    version: 2,
    credentials: [{ id: 'c1', provider: 'openai' }],
    models: models.map((model, i) => ({
        id: `m${i}`,
        credentialId: 'c1',
        model,
    })),
    routing: {},
});

describe('collectByokModels', () => {
    it('enumerates every configured v2 model', () => {
        expect(collectByokModels(v2(['gpt-x', 'claude-y']))).toEqual([
            'gpt-x',
            'claude-y',
        ]);
    });

    it('reflects ALL configured v2 models, not just two slots', () => {
        expect(
            collectByokModels(v2(['gpt-x', 'claude-y', 'gemini-z'])),
        ).toEqual(['gpt-x', 'claude-y', 'gemini-z']);
    });

    it('appends extra (per-repo/directory override) models', () => {
        expect(collectByokModels(v2(['gpt-x']), ['repo-model'])).toEqual([
            'gpt-x',
            'repo-model',
        ]);
    });

    it('de-duplicates and drops blank/missing models', () => {
        expect(
            collectByokModels(v2(['gpt-x', '  ']), [
                'gpt-x',
                '',
                'repo-model',
            ]),
        ).toEqual(['gpt-x', 'repo-model']);
    });

    it('treats a legacy / absent / non-config blob as having no configured models', () => {
        expect(collectByokModels(undefined, ['only-model'])).toEqual([
            'only-model',
        ]);
        expect(collectByokModels(null)).toEqual([]);
        // A legacy {main,fallback} blob is NOT v2 → contributes nothing.
        expect(
            collectByokModels({ main: { model: 'legacy' } } as any),
        ).toEqual([]);
    });
});
