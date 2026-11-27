import { RuntimeEnvironmentSetupRequestedSchema } from './runtime-commands';

const SHA = 'c'.repeat(40);
const FILES = [{ path: '.kodus/compose.yaml', content: 'services: {}\n' }];
const command = (recipe: Record<string, unknown>) => ({
    environmentId: 'env-1',
    organizationId: 'org-1',
    teamId: 'team-1',
    repositoryId: 'repo-1',
    repositoryName: 'shop',
    requestedBy: { userId: 'u-1' },
    requestedAt: '2026-11-25T12:00:00.000Z',
    key: 'env-1:k',
    ref: { sha: SHA, branch: 'main' },
    recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: 'version: 1\n', ...recipe },
});
const accepted = (recipe: Record<string, unknown>) => RuntimeEnvironmentSetupRequestedSchema.safeParse(command(recipe)).success;

describe('the setup command recipe buildFiles', () => {
    it('are taken with a committed recipe, bounded like the authored files', () => {
        expect(accepted({ buildFiles: FILES })).toBe(true);
        expect(accepted({ buildFiles: [] })).toBe(false);
        expect(accepted({ buildFiles: [{ path: '.kodus/workspace.yaml', content: 'x' }] })).toBe(false);
        expect(accepted({ buildFiles: [...FILES, ...FILES] })).toBe(false);
    });

    it('are refused with no recipe text, an inferred or a submitted recipe, or beside authored files', () => {
        expect(accepted({ content: null, buildFiles: FILES })).toBe(false);
        expect(accepted({ origin: 'inferred', buildFiles: FILES })).toBe(false);
        expect(accepted({ origin: 'submitted', buildFiles: FILES })).toBe(false);
        expect(accepted({ origin: 'submitted', files: FILES, buildFiles: FILES })).toBe(false);
    });
});
