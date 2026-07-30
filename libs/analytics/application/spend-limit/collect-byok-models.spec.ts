import { collectByokModels } from './collect-byok-models';

describe('collectByokModels', () => {
    it('collects the main and fallback models', () => {
        expect(
            collectByokModels({
                main: { model: 'gpt-x' },
                fallback: { model: 'claude-y' },
            }),
        ).toEqual(['gpt-x', 'claude-y']);
    });

    it('appends extra (per-repo/directory override) models', () => {
        expect(
            collectByokModels({ main: { model: 'gpt-x' } }, ['repo-model']),
        ).toEqual(['gpt-x', 'repo-model']);
    });

    it('de-duplicates and drops blank/missing models', () => {
        expect(
            collectByokModels(
                { main: { model: 'gpt-x' }, fallback: { model: '  ' } },
                ['gpt-x', '', 'repo-model'],
            ),
        ).toEqual(['gpt-x', 'repo-model']);
    });

    it('handles an absent BYOK config', () => {
        expect(collectByokModels(undefined, ['only-model'])).toEqual([
            'only-model',
        ]);
        expect(collectByokModels(null)).toEqual([]);
    });
});
