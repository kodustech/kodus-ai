import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/user-context.service.js', () => ({
    LOGIN_REQUIRED_HINT: 'Run: kodus auth login.',
    userContextService: {
        resolveCredential: vi.fn(),
    },
}));

vi.mock('../../../services/repo-settings.service.js', () => ({
    repositorySettingsService: {
        getRepositorySettings: vi.fn(),
        updateRepositorySettings: vi.fn(),
    },
}));

vi.mock('../../../services/review-settings.service.js', () => ({
    reviewSettingsService: {
        show: vi.fn(),
        set: vi.fn(),
    },
}));

vi.mock('../../../utils/logger.js', () => ({
    cliInfo: vi.fn(),
    cliError: vi.fn(),
}));

// Throws like the real helper, so a test sees the command abort.
vi.mock('../../../utils/cli-exit.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('../../../utils/cli-exit.js')>();
    return {
        ...actual,
        exitWithCode: vi.fn((code: number) => {
            throw new actual.CliExitError(code, true);
        }),
    };
});

import { repositorySettingsService } from '../../../services/repo-settings.service.js';
import { reviewSettingsService } from '../../../services/review-settings.service.js';
import { userContextService } from '../../../services/user-context.service.js';
import { exitWithCode } from '../../../utils/cli-exit.js';
import { cliError } from '../../../utils/logger.js';
import {
    configRepoPatternAddAction,
    configRepoSetAction,
    configRepoShowAction,
} from '../actions.js';

const credential = vi.mocked(userContextService.resolveCredential);
const legacy = vi.mocked(repositorySettingsService);
const settings = vi.mocked(reviewSettingsService);

const LEGACY_SETTINGS = {
    reviewEnabled: true,
    autoApproveEnabled: false,
    requestChangesMinSeverity: 'medium' as const,
    ignoredFilePatterns: [],
    baseBranchPatterns: [],
    ignoredTitlePatterns: [],
};

describe('repository settings: credential routing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        legacy.getRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'o/r',
            settings: LEGACY_SETTINGS,
        });
        legacy.updateRepositorySettings.mockResolvedValue({
            repositoryId: 'repo-1',
            repositoryFullName: 'o/r',
            settings: LEGACY_SETTINGS,
        });
        settings.show.mockResolvedValue({
            team: 'Core',
            scope: { level: 'repository', repositoryName: 'r' },
            model: { value: '', level: 'default' },
            settings: [
                {
                    key: 'ignorePaths',
                    section: 'general',
                    type: 'string[]',
                    value: ['dist/**'],
                    level: 'repository',
                },
            ],
        } as never);
        settings.set.mockResolvedValue({
            team: 'Core',
            scope: { level: 'repository', repositoryName: 'r' },
            key: 'runOnDraft',
            value: false,
        } as never);
    });

    describe('logged in', () => {
        beforeEach(() => {
            credential.mockResolvedValue({
                kind: 'user',
                accessToken: 'eyJ.user',
            });
        });

        it('shows every setting through the web endpoints', async () => {
            await configRepoShowAction('global', { team: 'Core' });
            expect(settings.show).toHaveBeenCalledWith(
                { repository: 'global', directory: undefined, team: 'Core' },
                { includeFileOverlay: true },
            );
            expect(legacy.getRepositorySettings).not.toHaveBeenCalled();
        });

        it('sets any key through the web endpoints', async () => {
            await configRepoSetAction('.', 'runOnDraft', 'false', {
                directory: 'apps/web',
            });
            expect(settings.set).toHaveBeenCalledWith(
                {
                    repository: '.',
                    directory: 'apps/web',
                    team: undefined,
                    createDirectory: undefined,
                },
                'runOnDraft',
                'false',
            );
            expect(legacy.updateRepositorySettings).not.toHaveBeenCalled();
        });

        it('edits a pattern list from its effective value', async () => {
            await configRepoPatternAddAction('.', 'ignore-files', 'build/**');
            expect(settings.set).toHaveBeenCalledWith(
                expect.objectContaining({ repository: '.' }),
                'ignorePaths',
                JSON.stringify(['dist/**', 'build/**']),
            );
        });
    });

    describe('team key', () => {
        beforeEach(() => {
            credential.mockResolvedValue({
                kind: 'team-key',
                accessToken: 'kodus_key',
            });
        });

        it('keeps the /cli settings path for a legacy key', async () => {
            await configRepoSetAction('.', 'review.enabled', 'false');
            expect(legacy.updateRepositorySettings).toHaveBeenCalledWith('.', {
                ...LEGACY_SETTINGS,
                reviewEnabled: false,
            });
            expect(settings.set).not.toHaveBeenCalled();
        });

        it('accepts the config path of a legacy key too', async () => {
            await configRepoSetAction('.', 'ignorePaths', 'a, b');
            expect(legacy.updateRepositorySettings).toHaveBeenCalledWith('.', {
                ...LEGACY_SETTINGS,
                ignoredFilePatterns: ['a', 'b'],
            });
        });

        it('asks for a login for any other key', async () => {
            await expect(
                configRepoSetAction('.', 'runOnDraft', 'false'),
            ).rejects.toMatchObject({ name: 'CliExitError' });
            expect(legacy.updateRepositorySettings).not.toHaveBeenCalled();
            expect(vi.mocked(cliError).mock.calls[0][0]).toMatch(
                /requires a logged-in user/,
            );
            expect(exitWithCode).toHaveBeenCalledWith(1);
        });

        it('asks for a login for global, directory and --team', async () => {
            const aborted = { name: 'CliExitError' };
            await expect(configRepoShowAction('global')).rejects.toMatchObject(
                aborted,
            );
            await expect(
                configRepoShowAction('.', { directory: 'apps' }),
            ).rejects.toMatchObject(aborted);
            await expect(
                configRepoSetAction('.', 'review.enabled', 'true', {
                    team: 'Core',
                }),
            ).rejects.toMatchObject(aborted);
            expect(legacy.getRepositorySettings).not.toHaveBeenCalled();
            expect(vi.mocked(cliError)).toHaveBeenCalledTimes(3);
            for (const call of vi.mocked(cliError).mock.calls) {
                expect(call[0]).toMatch(/logged-in user/);
            }
        });

        it('shows the legacy settings for a repository', async () => {
            await configRepoShowAction('.');
            expect(legacy.getRepositorySettings).toHaveBeenCalledWith('.');
            expect(settings.show).not.toHaveBeenCalled();
        });
    });
});
