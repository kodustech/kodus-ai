import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliExitError } from '../../utils/cli-exit.js';

vi.mock('../../services/centralized-config.service.js', () => ({
    centralizedConfigService: {
        getStatus: vi.fn(),
        init: vi.fn(),
        sync: vi.fn(),
        disable: vi.fn(),
        download: vi.fn(),
    },
}));

import { centralizedConfigService } from '../../services/centralized-config.service.js';
import {
    configCentralizedDisableAction,
    configCentralizedDownloadAction,
    configCentralizedInitAction,
    configCentralizedStatusAction,
    configCentralizedSyncAction,
    configCommand,
} from '../config.js';

const mockCentralizedConfigService = vi.mocked(centralizedConfigService);

describe('config centralized command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCentralizedConfigService.getStatus.mockReset();
        mockCentralizedConfigService.init.mockReset();
        mockCentralizedConfigService.sync.mockReset();
        mockCentralizedConfigService.disable.mockReset();
        mockCentralizedConfigService.download.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('exposes centralized subcommands in help', () => {
        const help = configCommand.helpInformation();
        const centralizedHelp = configCommand.commands
            .find((command) => command.name() === 'centralized')
            ?.helpInformation();

        expect(help).toContain('centralized');
        expect(centralizedHelp).toContain('status');
        expect(centralizedHelp).toContain('init');
        expect(centralizedHelp).toContain('sync');
        expect(centralizedHelp).toContain('disable');
        expect(centralizedHelp).toContain('download');
    });

    it('prints enabled centralized config status', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockCentralizedConfigService.getStatus.mockResolvedValue({
            enabled: true,
            repository: { id: 'repo-1', name: 'kodustech/cli' },
        });

        await configCentralizedStatusAction();

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');

        expect(output).toContain('Centralized config is enabled.');
        expect(output).toContain('Repository: kodustech/cli (repo-1)');
    });

    it('prints status as json when requested', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockCentralizedConfigService.getStatus.mockResolvedValue({
            enabled: false,
            repository: null,
        });

        await configCentralizedStatusAction({ json: true });

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');

        expect(JSON.parse(output)).toEqual({
            enabled: false,
            repository: null,
        });
    });

    it('uses default pr sync option on init command', async () => {
        mockCentralizedConfigService.init.mockResolvedValue({
            success: true,
            message: 'Centralized config initialized',
            repository: {
                id: 'repo-1',
                name: 'cli',
                organizationName: 'kodustech',
                full_name: 'kodustech/cli',
            },
        });

        await configCommand.parseAsync(
            ['centralized', 'init', 'kodustech/cli'],
            {
                from: 'user',
            },
        );

        expect(mockCentralizedConfigService.init).toHaveBeenCalledWith({
            repository: 'kodustech/cli',
            syncOption: 'pr',
        });
    });

    it('passes manual sync option on init command', async () => {
        mockCentralizedConfigService.init.mockResolvedValue({
            success: true,
            message: 'Centralized config initialized',
            repository: {
                id: 'repo-1',
                name: 'cli',
                organizationName: 'kodustech',
                full_name: 'kodustech/cli',
            },
        });

        await configCommand.parseAsync(
            ['centralized', 'init', 'kodustech/cli', '--sync-option', 'manual'],
            {
                from: 'user',
            },
        );

        expect(mockCentralizedConfigService.init).toHaveBeenCalledWith({
            repository: 'kodustech/cli',
            syncOption: 'manual',
        });
    });

    it('routes sync and disable actions', async () => {
        mockCentralizedConfigService.sync.mockResolvedValue({
            success: true,
            message: 'Synchronized',
        });
        mockCentralizedConfigService.disable.mockResolvedValue({
            success: true,
            message: 'Disabled',
        });

        await configCentralizedSyncAction();
        await configCentralizedDisableAction();

        expect(mockCentralizedConfigService.sync).toHaveBeenCalledTimes(1);
        expect(mockCentralizedConfigService.disable).toHaveBeenCalledTimes(1);
    });

    it('downloads centralized config with explicit output path', async () => {
        mockCentralizedConfigService.download.mockResolvedValue({
            outputPath: '/tmp/centralized.zip',
            bytes: 123,
        });

        await configCommand.parseAsync(
            ['centralized', 'download', '--out', './centralized.zip'],
            {
                from: 'user',
            },
        );

        expect(mockCentralizedConfigService.download).toHaveBeenCalledWith(
            './centralized.zip',
        );
    });

    it('exits with code 1 on centralized command errors', async () => {
        const errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        mockCentralizedConfigService.sync.mockRejectedValue(new Error('boom'));

        await expect(configCentralizedSyncAction()).rejects.toMatchObject({
            name: 'CliExitError',
            exitCode: 1,
        } satisfies Partial<CliExitError>);

        const output = errorSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain('boom');
    });

    it('prints init output including pull request url', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockCentralizedConfigService.init.mockResolvedValue({
            success: true,
            message: 'Centralized config initialized',
            prUrl: 'https://github.com/kodustech/cli/pull/1',
            repository: {
                id: 'repo-1',
                name: 'cli',
                organizationName: 'kodustech',
                full_name: 'kodustech/cli',
            },
        });

        await configCentralizedInitAction('kodustech/cli', {
            syncOption: 'pr',
        });

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain('Centralized config initialized');
        expect(output).toContain('Repository: kodustech/cli');
        expect(output).toContain(
            'Pull request: https://github.com/kodustech/cli/pull/1',
        );
    });

    it('exits on invalid sync-option', async () => {
        const errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        await expect(
            configCentralizedInitAction('kodustech/cli', {
                syncOption: 'invalid' as 'pr',
            }),
        ).rejects.toMatchObject({
            name: 'CliExitError',
            exitCode: 1,
        } satisfies Partial<CliExitError>);

        const output = errorSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain('Invalid value for --sync-option');
    });

    it('prints download metadata as json', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockCentralizedConfigService.download.mockResolvedValue({
            outputPath: '/tmp/centralized.zip',
            bytes: 456,
        });

        await configCentralizedDownloadAction({
            out: '/tmp/centralized.zip',
            json: true,
        });

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');

        expect(JSON.parse(output)).toEqual({
            outputPath: '/tmp/centralized.zip',
            bytes: 456,
        });
    });
});
