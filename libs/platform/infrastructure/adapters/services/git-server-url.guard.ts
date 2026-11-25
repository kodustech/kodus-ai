import { BadRequestException } from '@nestjs/common';
import {
    assertIntegrationUrlAllowed,
    IntegrationUrlRefusedError,
} from '@libs/llm/gateway-address-guard';

/**
 * A self-hosted git server URL an org typed, checked when it is saved: on cloud
 * it may not resolve to the platform's private network, and nowhere to the
 * cloud metadata service (gateway-address-guard.ts, `integrationAddressRefusal`).
 * Every later call to it is judged again when it connects. Nothing to check
 * when no host was given (the provider's public SaaS).
 */
export async function assertGitServerUrlAllowed(
    url: string | undefined,
): Promise<void> {
    if (!url?.trim()) return;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim())
        ? url.trim()
        : `https://${url.trim()}`;
    try {
        await assertIntegrationUrlAllowed(
            withScheme,
            undefined,
            'The git server URL',
        );
    } catch (error) {
        if (error instanceof IntegrationUrlRefusedError) {
            throw new BadRequestException(error.message);
        }
        throw error;
    }
}
