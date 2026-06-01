import chalk from 'chalk';
import { clearConfig, loadConfig, saveConfig } from '../../utils/config.js';
import { clearCredentials } from '../../utils/credentials.js';
import {
    resolveApiBaseUrl,
    getCloudflareAccessHeaders,
} from '../../services/api/api.real.js';
import { getDeviceIdentity, updateDeviceToken } from '../../utils/device.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { cliError, cliInfo } from '../../utils/logger.js';

interface TeamKeyErrorPayload {
    message?: string;
    code?: string;
    details?: {
        limit?: number;
        current?: number;
        activeDevices?: number;
    };
}

function getTeamKeyErrorMessage(payload: TeamKeyErrorPayload): string {
    if (payload.code === 'DEVICE_LIMIT_REACHED') {
        const limit = payload.details?.limit;
        const activeDevices =
            payload.details?.current ?? payload.details?.activeDevices;
        if (typeof limit === 'number' && typeof activeDevices === 'number') {
            return `Device limit reached (${activeDevices}/${limit}). Remove an old device or contact your admin.`;
        }
        return 'Device limit reached for this organization. Remove an old device or contact your admin.';
    }

    return payload.message || 'Invalid team key';
}

export async function teamKeyAction(options: { key?: string }): Promise<void> {
    if (!options.key) {
        cliError(chalk.red('Error: --key is required'));
        cliInfo(
            '\nGet your team key from: https://app.kodus.io/organization/cli-keys',
        );
        exitWithCode(1);
    }

    if (!options.key.startsWith('kodus_')) {
        cliError(
            chalk.red(
                'Error: Invalid key format. Key should start with "kodus_"',
            ),
        );
        exitWithCode(1);
    }

    try {
        const device = await getDeviceIdentity().catch(() => undefined);
        const apiUrl = await resolveApiBaseUrl();
        const cfHeaders = await getCloudflareAccessHeaders();
        const response = await fetch(`${apiUrl}/cli/validate-key`, {
            headers: {
                'X-Team-Key': options.key,
                ...cfHeaders,
                ...(device?.deviceId
                    ? { 'X-Kodus-Device-Id': device.deviceId }
                    : {}),
                ...(device?.deviceToken
                    ? { 'X-Kodus-Device-Token': device.deviceToken }
                    : {}),
            },
        });

        const responseDeviceToken = response.headers.get(
            'x-kodus-device-token',
        );
        if (responseDeviceToken) {
            await updateDeviceToken(responseDeviceToken).catch(() => {});
        }

        if (!response.ok) {
            const rawError = await response
                .json()
                .catch(() => ({}) as TeamKeyErrorPayload);
            const payload: TeamKeyErrorPayload =
                rawError &&
                typeof rawError === 'object' &&
                'data' in (rawError as Record<string, unknown>)
                    ? ((rawError as { data?: TeamKeyErrorPayload }).data ?? {})
                    : (rawError as TeamKeyErrorPayload);
            throw new Error(getTeamKeyErrorMessage(payload));
        }

        const rawData = await response.json().catch(() => ({}) as any);
        const payload =
            rawData && typeof rawData === 'object' && 'data' in rawData
                ? (rawData as any).data
                : rawData;

        const teamName = payload?.team?.name ?? payload?.teamName;
        const organizationName =
            payload?.organization?.name ??
            payload?.organizationName ??
            payload?.org?.name;

        if (!teamName || !organizationName) {
            throw new Error(
                'Invalid response from server. Missing organization or team info.',
            );
        }

        // Preserve existing config fields (apiUrl, CF Access credentials, etc.)
        const existingConfig = await loadConfig();
        await saveConfig({
            ...existingConfig,
            teamKey: options.key,
            teamName,
            organizationName,
        });
        // Team-key auth should not compete with a previously stored user session.
        try {
            await clearCredentials();
        } catch {
            await clearConfig().catch(() => {});
            throw new Error(
                'Failed to switch to team-key auth because personal credentials could not be cleared.',
            );
        }

        cliInfo(chalk.green('✓ Authenticated successfully!'));
        cliInfo(chalk.cyan(`  Organization: ${organizationName}`));
        cliInfo(chalk.cyan(`  Team: ${teamName}`));
    } catch (error) {
        cliError(
            chalk.red('✗ Authentication failed:'),
            error instanceof Error ? error.message : 'Unknown error',
        );
        cliInfo('\nMake sure:');
        cliInfo('  1. Your key is correct');
        cliInfo('  2. The key has not been revoked');
        cliInfo('  3. You have internet connection');
        exitWithCode(1);
    }
}

export async function teamStatusAction(): Promise<void> {
    const config = await loadConfig();

    if (!config) {
        cliInfo(chalk.yellow('Not authenticated with team key'));
        cliInfo('\nRun: kodus auth team-key --key <your-key>');
        cliInfo(
            'Get your key from: https://app.kodus.io/organization/cli-keys',
        );
        return;
    }

    cliInfo(chalk.green('✓ Authenticated'));
    cliInfo(chalk.cyan(`  Organization: ${config.organizationName}`));
    cliInfo(chalk.cyan(`  Team: ${config.teamName}`));
}
