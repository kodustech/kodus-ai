import { SimpleLogger } from '@libs/core/log/logger';
import {
    BadRequestException,
    HttpException,
    ServiceUnavailableException,
} from '@nestjs/common';

import { gitServerRefusal } from './git-server-url.guard';

/**
 * Network failures a user fixes by correcting the host URL. octokit reports
 * them as a RequestError with status 500 and the system error further down
 * the cause chain, so these are looked for before the status.
 */
const UNREACHABLE_HOST_CODES = new Set([
    'ENOTFOUND',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Network failures that pass: a slow or flaky host, or our own egress. Not
 * the user's URL to fix, and an outage must show up as an error.
 */
const TRANSIENT_NETWORK_CODES = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNABORTED',
    'EAI_AGAIN',
    'ENETUNREACH',
]);

const MAX_CAUSE_DEPTH = 5;

type Headers = { get?: (name: string) => unknown } & Record<string, unknown>;

type ErrorLike = {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    headers?: Headers;
    request?: unknown;
    config?: unknown;
    response?: { status?: unknown; headers?: Headers };
    cause?: unknown;
};

/** The error and its causes, stopping at a loop or at MAX_CAUSE_DEPTH. */
export function causeChain(err: unknown): ErrorLike[] {
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

/**
 * A network code counts only when an HTTP client reported it (octokit and
 * bitbucket set `request`, axios `config` and `request`): the same code from
 * a database driver is our infrastructure failing, not the git host.
 */
function networkCode(
    chain: ErrorLike[],
    codes: Set<string>,
): string | undefined {
    if (
        !chain.some(
            (link) => link.request !== undefined || link.config !== undefined,
        )
    ) {
        return undefined;
    }
    for (const link of chain) {
        if (typeof link.code === 'string' && codes.has(link.code)) {
            return link.code;
        }
    }
    return undefined;
}

/**
 * The first host response in the chain: octokit and bitbucket set `status`
 * with the `request`, axios `response.status`, gitbeaker a cause with
 * `response.status`. A link with neither `request` nor `response`, or a Nest
 * exception (it keeps its own `status` and `response`), is not the host's
 * answer.
 */
function hostAnswer(
    chain: ErrorLike[],
): { status: number; link: ErrorLike } | undefined {
    for (const link of chain) {
        if (link instanceof HttpException) {
            continue;
        }
        if (link.request === undefined && link.response === undefined) {
            continue;
        }
        for (const status of [link.status, link.response?.status]) {
            if (typeof status === 'number') {
                return { status, link };
            }
        }
    }
    return undefined;
}

/** A header's value, or undefined when absent (fetch's `get` answers null). */
function header(headers: Headers | undefined, name: string): unknown {
    if (!headers) {
        return undefined;
    }
    const value =
        typeof headers.get === 'function' ? headers.get(name) : headers[name];
    return value ?? undefined;
}

/**
 * GitHub answers a spent rate limit with 403, not 429: `x-ratelimit-remaining:
 * 0` for the primary limit, `retry-after` for the secondary one.
 */
function isRateLimited(status: number, link: ErrorLike): boolean {
    if (status === 429) {
        return true;
    }
    if (status !== 403) {
        return false;
    }
    for (const headers of [link.response?.headers, link.headers]) {
        if (
            String(header(headers, 'x-ratelimit-remaining')) === '0' ||
            header(headers, 'retry-after') !== undefined
        ) {
            return true;
        }
    }
    return typeof link.message === 'string' && /rate limit/i.test(link.message);
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
 * unreachable, or an address Kodus refuses to connect to, becomes a worded
 * 400; a rate limit or a transient network
 * failure a worded 503; anything else is returned as is, for the exception
 * filter to answer 500, report and log with its stack, instead of a 400
 * carrying its raw message.
 *
 * `kodusCredentials`: the link authenticates with credentials Kodus holds
 * (the GitHub App), so a 401 is a fault on our side, not the user's to fix.
 */
export function toIntegrationLinkError(
    err: unknown,
    provider: string,
    options: { kodusCredentials?: boolean } = {},
): unknown {
    if (err instanceof HttpException) {
        return err;
    }

    // Kodus refusing the host's address as it connects: the org's URL, worded.
    const addressRefusal = gitServerRefusal(err);
    if (addressRefusal) {
        return addressRefusal;
    }

    const chain = causeChain(err);
    if (chain.length === 0) {
        return err;
    }

    const unreachable = networkCode(chain, UNREACHABLE_HOST_CODES);
    if (unreachable) {
        return new BadRequestException(
            `Kodus could not reach the ${provider} host (${unreachable}). Check the URL and that the host is reachable from Kodus.`,
            { cause: err },
        );
    }

    const transient = networkCode(chain, TRANSIENT_NETWORK_CODES);
    if (transient) {
        return new ServiceUnavailableException(
            `Kodus could not reach the ${provider} host (${transient}). Try again in a few minutes, and check that the host accepts connections from Kodus.`,
            { cause: err },
        );
    }

    const answer = hostAnswer(chain);
    if (!answer) {
        return err;
    }
    if (isRateLimited(answer.status, answer.link)) {
        return new ServiceUnavailableException(
            `${provider} is rate-limiting Kodus (${answer.status}). Try again in a few minutes.`,
            { cause: err },
        );
    }
    if (answer.status === 401 && options.kodusCredentials) {
        return err;
    }
    const message = refusalMessage(provider, answer.status);
    return message ? new BadRequestException(message, { cause: err }) : err;
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
