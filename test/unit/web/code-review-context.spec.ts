import { resolveCodeReviewConfigForScope } from '../../../apps/web/src/app/(app)/settings/_components/code-review-config-scope';

const buildConfig = () => ({
    configs: {
        automatedReviewActive: { value: true, level: 'GLOBAL' },
    },
    repositories: [
        {
            id: 'repo-1',
            name: 'repo-1',
            isSelected: true,
            configs: {
                automatedReviewActive: { value: false, level: 'REPOSITORY' },
            },
            directories: [
                {
                    id: 'dir-1',
                    folders: [{ id: 'f-1', name: 'src', path: '/src' }],
                    configs: {
                        automatedReviewActive: {
                            value: true,
                            level: 'DIRECTORY',
                        },
                    },
                },
            ],
        },
    ],
});

describe('resolveCodeReviewConfigForScope', () => {
    it('returns the global config for the global scope', () => {
        expect(
            resolveCodeReviewConfigForScope(buildConfig() as any, 'global'),
        ).toMatchObject({
            id: 'global',
            displayName: 'Global',
            automatedReviewActive: { value: true, level: 'GLOBAL' },
        });
    });

    it('returns the repository config for repository scope', () => {
        expect(
            resolveCodeReviewConfigForScope(buildConfig() as any, 'repo-1'),
        ).toMatchObject({
            id: 'repo-1',
            displayName: 'repo-1',
            automatedReviewActive: { value: false, level: 'REPOSITORY' },
        });
    });

    it('returns the directory config for directory scope', () => {
        expect(
            resolveCodeReviewConfigForScope(
                buildConfig() as any,
                'repo-1',
                'dir-1',
            ),
        ).toMatchObject({
            id: 'dir-1',
            displayName: 'repo-1/src',
            automatedReviewActive: { value: true, level: 'DIRECTORY' },
        });
    });

    it('returns undefined when the repository does not exist', () => {
        expect(
            resolveCodeReviewConfigForScope(
                buildConfig() as any,
                'missing-repo',
            ),
        ).toBeUndefined();
    });
});
