import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/index.js', () => ({
    api: {
        config: {
            getTeams: vi.fn(),
        },
    },
}));

vi.mock('../auth.service.js', () => ({
    authService: {
        getValidToken: vi.fn(),
    },
}));

import { api } from '../api/index.js';
import { authService } from '../auth.service.js';
import {
    buildAuthHeaders,
    buildQuery,
    readOrganizationId,
    userContextService,
} from '../user-context.service.js';

const mockGetTeams = vi.mocked(api.config.getTeams);
const mockGetValidToken = vi.mocked(authService.getValidToken);

function jwtFor(payload: Record<string, unknown>): string {
    const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'HS256' })}.${encode(payload)}.signature`;
}

const USER_TOKEN = jwtFor({ sub: 'user-1', organizationId: 'org-1' });

describe('userContextService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetValidToken.mockResolvedValue(USER_TOKEN);
    });

    it('rejects a team key with a login hint', async () => {
        mockGetValidToken.mockResolvedValue('kodus_team_key');

        await expect(userContextService.resolve('Cockpit')).rejects.toEqual(
            expect.objectContaining({
                code: 'AUTH_REQUIRED',
                message: expect.stringContaining('kodus auth login'),
            }),
        );
        expect(mockGetTeams).not.toHaveBeenCalled();
    });

    it('uses the only active team when none is requested', async () => {
        mockGetTeams.mockResolvedValue([
            { uuid: 'team-old', name: 'Old', status: 'removed' },
            { uuid: 'team-1', name: 'Platform', status: 'active' },
        ]);

        await expect(userContextService.resolve('Cockpit')).resolves.toEqual({
            accessToken: USER_TOKEN,
            organizationId: 'org-1',
            teamId: 'team-1',
            teamName: 'Platform',
        });
    });

    it('matches --team by name or id, case-insensitively', async () => {
        mockGetTeams.mockResolvedValue([
            { uuid: 'team-1', name: 'Platform', status: 'active' },
            { uuid: 'team-2', name: 'Mobile', status: 'active' },
        ]);

        const byName = await userContextService.resolve('Cockpit', {
            team: 'mobile',
        });
        const byId = await userContextService.resolve('Cockpit', {
            team: 'team-1',
        });

        expect(byName.teamId).toBe('team-2');
        expect(byId.teamId).toBe('team-1');
    });

    it('asks for --team when the organization has several teams', async () => {
        mockGetTeams.mockResolvedValue([
            { uuid: 'team-1', name: 'Platform', status: 'active' },
            { uuid: 'team-2', name: 'Mobile', status: 'active' },
        ]);

        await expect(userContextService.resolve('Cockpit')).rejects.toEqual(
            expect.objectContaining({
                code: 'INVALID_INPUT',
                message: expect.stringContaining('Platform, Mobile'),
            }),
        );
    });

    it('fails when the token carries no organization', async () => {
        mockGetValidToken.mockResolvedValue(jwtFor({ sub: 'user-1' }));

        await expect(userContextService.resolve('Cockpit')).rejects.toEqual(
            expect.objectContaining({ code: 'AUTH_REQUIRED' }),
        );
    });

    it('lets a team key set in the environment win for the dual-path commands', async () => {
        // CI: KODUS_TOKEN for `kodus review`, KODUS_TEAM_KEY for rules.
        process.env.KODUS_TEAM_KEY = 'kodus_ci_key';
        try {
            await expect(
                userContextService.resolveCredential(),
            ).resolves.toEqual({
                kind: 'team-key',
                accessToken: 'kodus_ci_key',
            });
            // The logged-in-only commands still get the user token.
            await expect(
                userContextService.requireUserToken('Cockpit'),
            ).resolves.toBe(USER_TOKEN);
        } finally {
            delete process.env.KODUS_TEAM_KEY;
        }
    });

    it('reports the credential kind', async () => {
        await expect(userContextService.resolveCredential()).resolves.toEqual({
            kind: 'user',
            accessToken: USER_TOKEN,
        });

        mockGetValidToken.mockResolvedValue('kodus_team_key');
        await expect(userContextService.resolveCredential()).resolves.toEqual({
            kind: 'team-key',
            accessToken: 'kodus_team_key',
        });
    });
});

describe('helpers', () => {
    it('reads the organization claim and tolerates malformed tokens', () => {
        expect(readOrganizationId(USER_TOKEN)).toBe('org-1');
        expect(readOrganizationId('not-a-jwt')).toBeNull();
        expect(readOrganizationId('a.%%%.c')).toBeNull();
    });

    it('builds headers per credential kind', () => {
        expect(buildAuthHeaders('kodus_x')).toEqual({
            'X-Team-Key': 'kodus_x',
        });
        expect(buildAuthHeaders(USER_TOKEN)).toEqual({
            Authorization: `Bearer ${USER_TOKEN}`,
        });
    });

    it('drops empty query values', () => {
        expect(
            buildQuery({ a: 'x', b: undefined, c: '', d: 0, e: false }),
        ).toBe('?a=x&d=0&e=false');
        expect(buildQuery({})).toBe('');
    });
});
