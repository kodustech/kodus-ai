import {
    collectModelOverrides,
    clearModelOverrides,
} from './model-overrides.util';

const config = () => ({
    configs: { byokModel: 'global-model', other: 'keep' },
    repositories: [
        {
            id: 'repo-1',
            name: 'acme/api',
            configs: { byokModel: 'repo-model' },
            directories: [
                {
                    id: 'dir-1',
                    name: 'src/pkg',
                    configs: { byokModel: 'dir-model' },
                },
                { id: 'dir-2', name: 'src/empty', configs: { byokModel: '' } },
            ],
        },
        {
            id: 'repo-2',
            name: 'acme/web',
            configs: { byokModel: '  ' }, // whitespace = inherit
            directories: [],
        },
    ],
});

describe('collectModelOverrides', () => {
    it('collects non-empty overrides at every scope with location, skipping inherit', () => {
        const out = collectModelOverrides(config());
        expect(out).toEqual([
            { scope: 'global', model: 'global-model' },
            {
                scope: 'repository',
                repositoryId: 'repo-1',
                repositoryName: 'acme/api',
                model: 'repo-model',
            },
            {
                scope: 'directory',
                repositoryId: 'repo-1',
                repositoryName: 'acme/api',
                directoryId: 'dir-1',
                directoryName: 'src/pkg',
                model: 'dir-model',
            },
        ]);
    });

    it('returns [] for empty/missing config', () => {
        expect(collectModelOverrides(null)).toEqual([]);
        expect(collectModelOverrides({})).toEqual([]);
    });
});

describe('clearModelOverrides', () => {
    it('clears only the targeted scopes and preserves other fields', () => {
        const { configValue, clearedCount } = clearModelOverrides(config(), [
            { repositoryId: 'repo-1' },
            { repositoryId: 'repo-1', directoryId: 'dir-1' },
        ]);
        const c = configValue as any;
        expect(clearedCount).toBe(2);
        expect(c.repositories[0].configs.byokModel).toBe('');
        expect(c.repositories[0].directories[0].configs.byokModel).toBe('');
        // untouched:
        expect(c.configs.byokModel).toBe('global-model');
        expect(c.configs.other).toBe('keep');
    });

    it('clears the global override when target has no repositoryId', () => {
        const { configValue, clearedCount } = clearModelOverrides(config(), [
            {},
        ]);
        expect(clearedCount).toBe(1);
        expect((configValue as any).configs.byokModel).toBe('');
    });

    it('does not count targets that had no override / do not exist', () => {
        const { clearedCount } = clearModelOverrides(config(), [
            { repositoryId: 'repo-2' }, // inherit (whitespace) — nothing to clear
            { repositoryId: 'nope' }, // missing
        ]);
        expect(clearedCount).toBe(0);
    });

    it('does not mutate the input config', () => {
        const input = config();
        clearModelOverrides(input, [{ repositoryId: 'repo-1' }]);
        expect(input.repositories[0].configs.byokModel).toBe('repo-model');
    });
});
