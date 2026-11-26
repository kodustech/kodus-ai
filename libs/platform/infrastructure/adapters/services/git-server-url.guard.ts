import { BadRequestException } from '@nestjs/common';
import {
    assertIntegrationUrlAllowed,
    GatewayAddressRefusedError,
    IntegrationUrlRefusedError,
} from '@libs/llm/gateway-address-guard';

/** The save-time refusal: a BadRequest that is the address, not the request. */
export class GitServerUrlRefusedException extends BadRequestException {}

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
            throw new GitServerUrlRefusedException(error.message);
        }
        throw error;
    }
}

/**
 * The address refusal behind a failed connection to an org's git server, as
 * the BadRequest its caller should answer with, so a catch that turns every
 * failure into "error authenticating" does not tell the org its token is
 * wrong. The save-time check's own, or the socket's (an axios error whose
 * cause is the guard's).
 */
export function gitServerRefusal(
    err: unknown,
): BadRequestException | undefined {
    for (let e = err as any, depth = 0; e && depth < 5; e = e.cause, depth++) {
        if (e instanceof GitServerUrlRefusedException) return e;
        if (e instanceof GatewayAddressRefusedError) {
            return new GitServerUrlRefusedException(e.message);
        }
    }
    return undefined;
}
