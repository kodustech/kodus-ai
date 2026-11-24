import { SimpleLogger } from '@libs/core/log/logger';
import { BadRequestException, HttpException } from '@nestjs/common';

/**
 * Network failures a user fixes by correcting the host URL. octokit reports
 * them as a RequestError with status 500 and the system error further down
 * the cause chain, so these are looked for before the status.
 */
const UNREACHABLE_HOST_CODES = new Set([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNABORTED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const MAX_CAUSE_DEPTH = 5;

type ErrorLike = {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
    cause?: unknown;
};

function causeChain(err: unknown): ErrorLike[] {
    const chain: ErrorLike[] = [];
    let current: unknown = err;
    while (
        current &&
        typeof current === 'object' &&
        chain.length < MAX_CAUSE_DEPTH &&
        !chain.includes(current as ErrorLike)
    ) {
        chain.push(current as ErrorLike);
        current = (current as ErrorLike).cause;
    }
    return chain;
}

function unreachableHostCode(chain: ErrorLike[]): string | undefined {
    for (const link of chain) {
        if (
            typeof link.code === 'string' &&
            UNREACHABLE_HOST_CODES.has(link.code)
        ) {
            return link.code;
        }
    }
    return undefined;
}

/** octokit and bitbucket set `status`, axios `response.status`, gitbeaker `cause.response.status`. */
function hostStatus(err: ErrorLike): number | undefined {
    const candidates = [
        err.status,
        err.response?.status,
        (err.cause as ErrorLike | undefined)?.response?.status,
    ];
    return candidates.find((s): s is number => typeof s === 'number');
}

function refusalMessage(provider: string, status: number): string | undefined {
    switch (status) {
        case 401:
            return `${provider} did not accept the credentials (401). Check the token and try again.`;
        case 403:
            return `${provider} refused access with these credentials (403). Check the token's scopes or the app's permissions.`;
        case 404:
            return `${provider} could not find what the connection points at (404). Check the host, the organization and the installation.`;
        default:
            return undefined;
    }
}

/**
 * What a failed integration link throws to the client. A refusal already
 * worded for the user passes through; a host refusing the credentials or
 * unreachable becomes a worded 400; anything else is returned as is, for the
 * exception filter to answer 500, report and log with its stack, instead of
 * a 400 carrying its raw message.
 */
export function toIntegrationLinkError(
    err: unknown,
    provider: string,
): unknown {
    if (err instanceof HttpException) {
        return err;
    }

    const chain = causeChain(err);
    if (chain.length === 0) {
        return err;
    }

    const code = unreachableHostCode(chain);
    if (code) {
        return new BadRequestException(
            `Kodus could not reach the ${provider} host (${code}). Check the URL and that the host is reachable from Kodus.`,
            { cause: err },
        );
    }

    const status = hostStatus(chain[0]);
    const message = status ? refusalMessage(provider, status) : undefined;
    if (message) {
        return new BadRequestException(message, { cause: err });
    }

    return err;
}

/** A refusal worded for the user (4xx), as opposed to a fault on our side. */
export function isIntegrationLinkRefusal(err: unknown): err is HttpException {
    return err instanceof HttpException && err.getStatus() < 500;
}

/**
 * One log per failed link: a refusal as a warning with the reason the user
 * sees, a fault as an error with the original error. `metadata` must carry
 * named fields only: link params hold tokens.
 */
export function logIntegrationLinkFailure(
    logger: Pick<SimpleLogger, 'warn' | 'error'>,
    params: {
        provider: string;
        context: string;
        err: Error;
        linkError: unknown;
        metadata: Record<string, unknown>;
    },
): void {
    const { provider, context, err, linkError, metadata } = params;
    if (isIntegrationLinkRefusal(linkError)) {
        logger.warn({
            message: `${provider} integration refused`,
            context,
            metadata: { ...metadata, reason: linkError.message },
        });
        return;
    }
    logger.error({
        message: `Failed to create ${provider} integration`,
        context,
        error: err,
        metadata,
    });
}
