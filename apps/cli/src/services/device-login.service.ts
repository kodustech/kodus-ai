import open from 'open';

import { cliAuthApi, type CliLoginPollResponse } from './api/cli-auth.api.js';

const POLL_FALLBACK_INTERVAL_MS = 5_000;
const POLL_BACKOFF_MAX_MS = 15_000;

export interface DeviceLoginResult {
    accessToken: string;
    refreshToken: string;
    userEmail?: string;
}

export interface DeviceLoginPrompt {
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresIn: number;
}

/**
 * Device-code flow (RFC 8628). Used when there is no usable browser on this
 * machine (CI, SSH, docker exec).
 *
 * Caller is responsible for printing the user_code + verification_uri so the
 * user can complete authorization on another device. We try to open the URL
 * automatically as a courtesy but do not require it.
 */
export async function loginViaDeviceCode({
    onPrompt,
}: {
    onPrompt: (prompt: DeviceLoginPrompt) => void | Promise<void>;
}): Promise<DeviceLoginResult> {
    const init = await cliAuthApi.initDevice();

    await onPrompt({
        userCode: init.userCode,
        verificationUri: init.verificationUri,
        verificationUriComplete: init.verificationUriComplete,
        expiresIn: init.expiresIn,
    });

    try {
        await open(init.verificationUriComplete);
    } catch {
        // Headless: user opens the URL on another device.
    }

    return pollUntilTerminal(init.deviceCode, init.interval, init.expiresIn);
}

async function pollUntilTerminal(
    deviceCode: string,
    intervalSec: number,
    expiresInSec: number,
): Promise<DeviceLoginResult> {
    const startedAt = Date.now();
    const totalTimeoutMs = expiresInSec * 1000;
    let delay = Math.max(intervalSec, 1) * 1000;

    while (Date.now() - startedAt < totalTimeoutMs) {
        await sleep(delay);

        let response: CliLoginPollResponse;
        try {
            response = await cliAuthApi.poll({ deviceCode });
        } catch {
            // Transient network error; back off and try again.
            delay = Math.min(delay * 2, POLL_BACKOFF_MAX_MS);
            continue;
        }

        if (response.status === 'completed') {
            if (!response.accessToken || !response.refreshToken) {
                throw new Error(
                    'Authorization completed but the server returned no tokens',
                );
            }
            return {
                accessToken: response.accessToken,
                refreshToken: response.refreshToken,
                userEmail: response.userEmail,
            };
        }

        if (
            response.status === 'expired' ||
            response.status === 'denied' ||
            response.status === 'consumed' ||
            response.status === 'not_found'
        ) {
            throw new Error(
                `Authorization ${response.status}. Run \`kodus auth login --device-code\` again.`,
            );
        }

        // Pending: keep the requested interval, no backoff.
        delay = Math.max(intervalSec, 1) * 1000;
        if (delay < POLL_FALLBACK_INTERVAL_MS) {delay = POLL_FALLBACK_INTERVAL_MS;}
    }

    throw new Error('Authorization timed out before the user approved it');
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
