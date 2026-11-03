import { api } from './api/index.js';
import { authService } from './auth.service.js';
import type { ConfigTeam } from '../types/config.js';
import { CommandError } from '../utils/command-errors.js';

export type CredentialKind = 'user' | 'team-key';

export type ResolvedCredential = {
    kind: CredentialKind;
    accessToken: string;
};

export type UserContext = {
    accessToken: string;
    organizationId: string;
    teamId: string;
    teamName: string;
};

export const LOGIN_REQUIRED_HINT =
    'Run: kodus auth login (team keys do not cover this command yet).';

export function isTeamKey(token: string): boolean {
    return token.startsWith('kodus_');
}

/** Bearer for a user token, X-Team-Key for a team key — same split the API makes. */
export function buildAuthHeaders(accessToken: string): Record<string, string> {
    return isTeamKey(accessToken)
        ? { 'X-Team-Key': accessToken }
        : { Authorization: `Bearer ${accessToken}` };
}

export function buildQuery(
    params: Record<string, string | number | boolean | undefined | null>,
): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') {
            continue;
        }
        search.set(key, String(value));
    }
    const query = search.toString();
    return query ? `?${query}` : '';
}

/**
 * The organization a user token belongs to. The API signs it into the JWT
 * (`organizationId` claim, libs/identity/.../auth.service.ts createToken), and
 * the web app reads the same value from its session.
 */
export function readOrganizationId(accessToken: string): string | null {
    const [, payload] = accessToken.split('.');
    if (!payload) {
        return null;
    }
    try {
        const decoded = JSON.parse(
            Buffer.from(payload, 'base64url').toString('utf-8'),
        ) as { organizationId?: unknown };
        return typeof decoded.organizationId === 'string'
            ? decoded.organizationId
            : null;
    } catch {
        return null;
    }
}

function pickTeam(teams: ConfigTeam[], requested?: string): ConfigTeam {
    const active = teams.filter((team) => team.status !== 'removed');

    if (requested) {
        const wanted = requested.trim().toLowerCase();
        const match = active.find(
            (team) =>
                team.uuid.toLowerCase() === wanted ||
                team.name.toLowerCase() === wanted,
        );
        if (!match) {
            throw new CommandError(
                'INVALID_INPUT',
                `Team '${requested}' not found. Available teams: ${active.map((team) => team.name).join(', ') || 'none'}.`,
            );
        }
        return match;
    }

    if (active.length === 1) {
        return active[0];
    }

    if (active.length === 0) {
        throw new CommandError(
            'INVALID_INPUT',
            'Your organization has no teams yet. Finish setup at https://app.kodus.io.',
        );
    }

    throw new CommandError(
        'INVALID_INPUT',
        `Your organization has more than one team. Pass --team <name|id>. Available teams: ${active.map((team) => team.name).join(', ')}.`,
    );
}

class UserContextService {
    /**
     * For the commands that take either credential (rules, config remote):
     * a team key set in the environment is explicit intent and wins, as it
     * did before these commands gained a logged-in path. A CI job that sets
     * KODUS_TOKEN for `kodus review` and KODUS_TEAM_KEY for rules keeps its
     * team-key flow. Otherwise a stored login wins over a stored team key.
     */
    async resolveCredential(): Promise<ResolvedCredential> {
        const envTeamKey = process.env.KODUS_TEAM_KEY?.trim();
        if (envTeamKey && isTeamKey(envTeamKey)) {
            return { kind: 'team-key', accessToken: envTeamKey };
        }
        const accessToken = await authService.getValidToken();
        return {
            kind: isTeamKey(accessToken) ? 'team-key' : 'user',
            accessToken,
        };
    }

    /** For the logged-in-only commands: the user's token, whatever else is set. */
    async requireUserToken(feature: string): Promise<string> {
        const accessToken = await authService.getValidToken();
        if (isTeamKey(accessToken)) {
            throw new CommandError(
                'AUTH_REQUIRED',
                `${feature} requires a logged-in user. ${LOGIN_REQUIRED_HINT}`,
            );
        }
        return accessToken;
    }

    async resolve(
        feature: string,
        options: { team?: string } = {},
    ): Promise<UserContext> {
        const accessToken = await this.requireUserToken(feature);
        const organizationId = readOrganizationId(accessToken);
        if (!organizationId) {
            throw new CommandError(
                'AUTH_REQUIRED',
                'Your session does not carry an organization. Run: kodus auth login.',
            );
        }

        const teams = await api.config.getTeams(accessToken);
        const team = pickTeam(teams ?? [], options.team);

        return {
            accessToken,
            organizationId,
            teamId: team.uuid,
            teamName: team.name,
        };
    }
}

export const userContextService = new UserContextService();
