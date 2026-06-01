import { ApiError } from '../types/errors.js';
import type { CliConfig } from '../utils/config.js';

export async function withTeamKeyFallback<T>({
    token,
    loadConfig,
    operation,
}: {
    token: string;
    loadConfig: () => Promise<CliConfig | null>;
    operation: (token: string) => Promise<T>;
}): Promise<T> {
    try {
        return await operation(token);
    } catch (error) {
        const canFallbackToTeamKey =
            error instanceof ApiError &&
            error.statusCode === 401 &&
            !token.startsWith('kodus_');

        if (!canFallbackToTeamKey) {
            throw error;
        }

        const config = await loadConfig();
        if (!config?.teamKey) {
            throw error;
        }

        try {
            return await operation(config.teamKey);
        } catch (fallbackError) {
            throw fallbackError;
        }
    }
}
