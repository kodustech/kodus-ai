import { loadConfig } from './config.js';
import { loadCredentials } from './credentials.js';

export type AuthModeSummary = {
    mode: 'token' | 'team-key' | 'logged-in' | 'trial';
    source: 'env' | 'stored' | 'none';
    label: string;
};

export async function getAuthModeSummary(): Promise<AuthModeSummary> {
    const envToken = process.env.KODUS_TOKEN?.trim();
    if (envToken) {
        return {
            mode: 'token',
            source: 'env',
            label: 'token (env)',
        };
    }

    const envTeamKey = process.env.KODUS_TEAM_KEY?.trim();
    if (envTeamKey) {
        return {
            mode: 'team-key',
            source: 'env',
            label: 'team key (env)',
        };
    }

    const credentials = await loadCredentials();
    if (credentials?.accessToken || credentials?.refreshToken) {
        return {
            mode: 'logged-in',
            source: 'stored',
            label: 'logged in',
        };
    }

    const config = await loadConfig();
    if (config?.teamKey) {
        return {
            mode: 'team-key',
            source: 'stored',
            label: 'team key',
        };
    }

    return {
        mode: 'trial',
        source: 'none',
        label: 'trial',
    };
}
