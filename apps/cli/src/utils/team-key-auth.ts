import { loadConfig } from './config.js';
import { CommandError } from './command-errors.js';

export type TeamKeyAccess = {
    teamKey: string;
};

export async function resolveTeamKeyAccess(
    missingAuthMessage: string,
): Promise<TeamKeyAccess> {
    const envTeamKey = process.env.KODUS_TEAM_KEY?.trim();
    if (envTeamKey) {
        return { teamKey: envTeamKey };
    }

    const config = await loadConfig();
    if (config?.teamKey) {
        return { teamKey: config.teamKey };
    }

    throw new CommandError('AUTH_REQUIRED', missingAuthMessage);
}
