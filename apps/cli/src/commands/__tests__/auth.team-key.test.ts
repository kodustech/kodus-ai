import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/config.js', () => ({
    loadConfig: vi.fn(),
    saveConfig: vi.fn(),
    clearConfig: vi.fn(),
}));

vi.mock('../../utils/credentials.js', () => ({
    clearCredentials: vi.fn(),
}));

import { clearConfig, loadConfig, saveConfig } from '../../utils/config.js';
import { clearCredentials } from '../../utils/credentials.js';
import { teamKeyAction, teamStatusAction } from '../auth/team-key.js';
import { CliExitError } from '../../utils/cli-exit.js';

const mockLoadConfig = vi.mocked(loadConfig);
const mockSaveConfig = vi.mocked(saveConfig);
const mockClearConfig = vi.mocked(clearConfig);
const mockClearCredentials = vi.mocked(clearCredentials);

describe('auth team-key command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('exits when key is missing', async () => {
        const errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        await expect(teamKeyAction({})).rejects.toMatchObject({
            name: 'CliExitError',
            exitCode: 1,
        } satisfies Partial<CliExitError>);
        expect(errorSpy).toHaveBeenCalled();
    });

    it('exits when key format is invalid', async () => {
        const errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        await expect(teamKeyAction({ key: 'invalid' })).rejects.toMatchObject({
            name: 'CliExitError',
            exitCode: 1,
        } satisfies Partial<CliExitError>);
        expect(errorSpy).toHaveBeenCalled();
    });

    it('saves config and clears credentials when key is valid', async () => {
        const fetchMock = vi.mocked(fetch);
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: {
                        team: { uuid: 'team-1', name: 'Platform Team' },
                        organization: { uuid: 'org-1', name: 'Kodus' },
                    },
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );
        mockClearCredentials.mockResolvedValue(undefined);

        await teamKeyAction({ key: 'kodus_abc123' });

        expect(mockSaveConfig).toHaveBeenCalledWith({
            teamKey: 'kodus_abc123',
            teamName: 'Platform Team',
            organizationName: 'Kodus',
        });
        expect(mockClearCredentials).toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('/cli/validate-key'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    'X-Team-Key': 'kodus_abc123',
                }),
            }),
        );
    });

    it('fails and rolls back team config when clearing old credentials throws', async () => {
        const fetchMock = vi.mocked(fetch);
        const errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: {
                        teamName: 'Backend Team',
                        organizationName: 'Kodus',
                    },
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );
        mockClearCredentials.mockRejectedValue(new Error('fs error'));

        await expect(
            teamKeyAction({ key: 'kodus_abc123' }),
        ).rejects.toMatchObject({
            name: 'CliExitError',
            exitCode: 1,
        } satisfies Partial<CliExitError>);
        expect(errorSpy).toHaveBeenCalled();
        expect(mockClearConfig).toHaveBeenCalledTimes(1);
        expect(mockSaveConfig).toHaveBeenCalled();
    });

    it('exits when API returns invalid key', async () => {
        const fetchMock = vi.mocked(fetch);
        const errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ message: 'Invalid team key' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
            }),
        );

        await expect(
            teamKeyAction({ key: 'kodus_abc123' }),
        ).rejects.toMatchObject({
            name: 'CliExitError',
            exitCode: 1,
        } satisfies Partial<CliExitError>);
        expect(errorSpy).toHaveBeenCalled();
    });

    it('shows device limit message when API returns DEVICE_LIMIT_REACHED with current count', async () => {
        const fetchMock = vi.mocked(fetch);
        const errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    code: 'DEVICE_LIMIT_REACHED',
                    details: { limit: 2, current: 2 },
                }),
                {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        await expect(
            teamKeyAction({ key: 'kodus_abc123' }),
        ).rejects.toMatchObject({
            name: 'CliExitError',
            exitCode: 1,
        } satisfies Partial<CliExitError>);
        const output = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(output).toContain(
            'Device limit reached (2/2). Remove an old device or contact your admin.',
        );
    });
});

describe('auth team-status command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('shows not-authenticated message when no team config exists', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockLoadConfig.mockResolvedValue(null);

        await teamStatusAction();

        const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(output).toContain('Not authenticated with team key');
    });

    it('shows team details when team config exists', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockLoadConfig.mockResolvedValue({
            teamKey: 'kodus_abc123',
            teamName: 'Platform Team',
            organizationName: 'Kodus',
        } as any);

        await teamStatusAction();

        const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(output).toContain('Authenticated');
        expect(output).toContain('Kodus');
        expect(output).toContain('Platform Team');
    });
});
