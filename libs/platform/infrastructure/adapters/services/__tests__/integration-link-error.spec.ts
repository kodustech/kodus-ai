import {
    BadRequestException,
    ForbiddenException,
    HttpException,
    InternalServerErrorException,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';

import { GatewayAddressRefusedError } from '@libs/llm/gateway-address-guard';

import { GitServerUrlRefusedException } from '../git-server-url.guard';
import {
    causeChain,
    isIntegrationLinkRefusal,
    logIntegrationLinkFailure,
    toIntegrationLinkError,
} from '../integration-link-error';

const fail = (props: Record<string, unknown>, message = 'host said no') =>
    Object.assign(new Error(message), props);

describe('toIntegrationLinkError', () => {
    it('passes an HttpException through unchanged', () => {
        const refusal = new ForbiddenException('Not yours.');

        expect(toIntegrationLinkError(refusal, 'GitHub')).toBe(refusal);
    });

    it.each([
        ['octokit', fail({ status: 401, request: {} })],
        ['axios', fail({ response: { status: 401 } })],
        ['gitbeaker', fail({ cause: { response: { status: 401 } } })],
    ])(
        'turns a host 401 from %s into a worded 400 that keeps the original',
        (_client, err) => {
            const mapped = toIntegrationLinkError(err, 'GitLab');

            expect(mapped).toBeInstanceOf(BadRequestException);
            expect((mapped as HttpException).message).toBe(
                'GitLab did not accept the credentials (401). Check the token and try again.',
            );
            expect((mapped as HttpException).cause).toBe(err);
        },
    );

    it('words a host 403 as missing access', () => {
        const mapped = toIntegrationLinkError(
            fail({ status: 403, request: {} }),
            'Bitbucket Cloud',
        ) as HttpException;

        expect(mapped).toBeInstanceOf(BadRequestException);
        expect(mapped.message).toBe(
            "Bitbucket Cloud refused access with these credentials (403). Check the token's scopes or the app's permissions.",
        );
    });

    it('words a host 404 as something not found', () => {
        const mapped = toIntegrationLinkError(
            fail({ response: { status: 404 } }),
            'Azure Repos',
        ) as HttpException;

        expect(mapped).toBeInstanceOf(BadRequestException);
        expect(mapped.message).toBe(
            'Azure Repos could not find what the connection points at (404). Check the host, the organization and the installation.',
        );
    });

    it.each([
        [
            'octokit, primary limit',
            fail({
                status: 403,
                request: {},
                response: {
                    status: 403,
                    headers: { 'x-ratelimit-remaining': '0' },
                },
            }),
        ],
        [
            'octokit, secondary limit',
            fail({
                status: 403,
                request: {},
                response: { status: 403, headers: { 'retry-after': '60' } },
            }),
        ],
        [
            'fetch Response headers',
            fail({
                cause: {
                    response: {
                        status: 403,
                        headers: new Headers({ 'x-ratelimit-remaining': '0' }),
                    },
                },
            }),
        ],
        [
            'the message only',
            fail(
                { status: 403, request: {} },
                'API rate limit exceeded for installation ID 1.',
            ),
        ],
        ['a 429', fail({ status: 429, request: {} })],
    ])(
        'answers a rate limit (%s) with a worded 503, not a credentials refusal',
        (_shape, err) => {
            const mapped = toIntegrationLinkError(
                err,
                'GitHub',
            ) as HttpException;

            expect(mapped).toBeInstanceOf(ServiceUnavailableException);
            expect(mapped.message).toMatch(
                /^GitHub is rate-limiting Kodus \((403|429)\)\. Try again in a few minutes\.$/,
            );
            expect(mapped.cause).toBe(err);
        },
    );

    it('keeps a 403 whose fetch Response headers carry no rate limit as a refusal', () => {
        const mapped = toIntegrationLinkError(
            fail({
                cause: {
                    response: {
                        status: 403,
                        headers: new Headers({
                            'content-type': 'application/json',
                        }),
                    },
                },
            }),
            'GitLab',
        );

        expect(mapped).toBeInstanceOf(BadRequestException);
    });

    it('keeps a 403 with rate-limit room left as a refusal', () => {
        const mapped = toIntegrationLinkError(
            fail({
                status: 403,
                request: {},
                response: {
                    status: 403,
                    headers: { 'x-ratelimit-remaining': '4999' },
                },
            }),
            'GitHub',
        );

        expect(mapped).toBeInstanceOf(BadRequestException);
    });

    it.each([
        'ETIMEDOUT',
        'ECONNRESET',
        'ECONNABORTED',
        'EAI_AGAIN',
        'ENETUNREACH',
    ])('answers a transient network failure (%s) with a worded 503', (code) => {
        const err = fail({ code });
        const mapped = toIntegrationLinkError(err, 'GitLab') as HttpException;

        expect(mapped).toBeInstanceOf(ServiceUnavailableException);
        expect(mapped.message).toBe(
            `Kodus could not reach the GitLab host (${code}). Try again in a few minutes, and check that the host accepts connections from Kodus.`,
        );
        expect(mapped.cause).toBe(err);
        expect(isIntegrationLinkRefusal(mapped)).toBe(false);
    });

    it('leaves a 401 to the exception filter when Kodus holds the credentials', () => {
        const err = fail({ status: 401, request: {} });

        expect(
            toIntegrationLinkError(err, 'GitHub', { kodusCredentials: true }),
        ).toBe(err);
    });

    it('still words a 404 when Kodus holds the credentials', () => {
        const mapped = toIntegrationLinkError(
            fail({ status: 404, request: {} }),
            'GitHub',
            { kodusCredentials: true },
        );

        expect(mapped).toBeInstanceOf(BadRequestException);
    });

    it.each(['ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'CERT_HAS_EXPIRED'])(
        'turns an unreachable host (%s) into a worded 400',
        (code) => {
            const err = fail({ code });
            const mapped = toIntegrationLinkError(
                err,
                'Forgejo',
            ) as HttpException;

            expect(mapped).toBeInstanceOf(BadRequestException);
            expect(mapped.message).toBe(
                `Kodus could not reach the Forgejo host (${code}). Check the URL and that the host is reachable from Kodus.`,
            );
            expect(mapped.cause).toBe(err);
        },
    );

    it("answers an address Kodus refuses as it connects in the guard's words", () => {
        // axios's shape: the request was set up, the guard refused the socket.
        const refused = new GatewayAddressRefusedError(
            'git.example.test',
            '10.0.0.7',
            'Git server',
        );
        const err = Object.assign(new Error(refused.message), {
            code: refused.code,
            request: {},
            cause: refused,
        });

        const mapped = toIntegrationLinkError(err, 'GitLab') as HttpException;

        expect(mapped).toBeInstanceOf(GitServerUrlRefusedException);
        expect(mapped.message).toBe(
            'Git server host "git.example.test" resolves to a private or reserved address; the call was not sent.',
        );
        expect(isIntegrationLinkRefusal(mapped)).toBe(true);
    });

    it('finds the network code down the cause chain, even under a 500 status', () => {
        // octokit's shape for a failed fetch: RequestError(500) → TypeError → system error
        const err = fail(
            {
                status: 500,
                cause: fail({ cause: fail({ code: 'ENOTFOUND' }) }),
            },
            'getaddrinfo ENOTFOUND ghes.example.test',
        );

        const mapped = toIntegrationLinkError(err, 'GitHub') as HttpException;

        expect(mapped).toBeInstanceOf(BadRequestException);
        expect(mapped.message).toContain('(ENOTFOUND)');
    });

    it.each([
        [
            'a TypeError',
            new TypeError("Cannot read properties of null (reading 'id')"),
        ],
        ['a host 500', fail({ status: 500 })],
        ['a host 502', fail({ response: { status: 502 } })],
        ['a host 422', fail({ status: 422 })],
        ['a non-Error value', 'boom'],
    ])(
        'returns %s unchanged, for the exception filter to answer 500',
        (_name, err) => {
            expect(toIntegrationLinkError(err, 'GitHub')).toBe(err);
        },
    );

    it('stops walking a cause chain that loops', () => {
        const a: Record<string, unknown> = fail({});
        const b = fail({ cause: a });
        a.cause = b;

        expect(toIntegrationLinkError(a, 'GitHub')).toBe(a);
        // Without the guard the walk would revisit a and b up to the depth cap.
        expect(causeChain(a)).toEqual([a, b]);
    });

    it('finds a host 401 under a wrapper error', () => {
        const refused = fail({ status: 401, request: {} });
        const err = fail({ cause: fail({ cause: refused }) }, 'retry failed');

        const mapped = toIntegrationLinkError(err, 'GitHub') as HttpException;

        expect(mapped).toBeInstanceOf(BadRequestException);
        expect(mapped.message).toBe(
            'GitHub did not accept the credentials (401). Check the token and try again.',
        );
        expect(mapped.cause).toBe(err);
    });

    it('ignores a status on a link that is not a host response', () => {
        const err = fail({ cause: fail({ status: 401 }) }, 'wrapped');

        expect(toIntegrationLinkError(err, 'GitHub')).toBe(err);
    });

    it('ignores a Nest exception nested under a fault', () => {
        const err = fail({ cause: new UnauthorizedException('not here') });

        expect(toIntegrationLinkError(err, 'GitHub')).toBe(err);
    });

    it('takes the first status in the chain, so a 500 over a 401 stays a fault', () => {
        const err = fail({
            status: 500,
            request: {},
            cause: fail({ status: 401, request: {} }),
        });

        expect(toIntegrationLinkError(err, 'GitHub')).toBe(err);
    });
});

describe('isIntegrationLinkRefusal', () => {
    it.each([
        ['a 400', new BadRequestException('no'), true],
        ['a 403', new ForbiddenException('no'), true],
        [
            'a 500 HttpException',
            new InternalServerErrorException('misconfigured'),
            false,
        ],
        ['a plain Error', new Error('boom'), false],
        ['a non-Error value', 'boom', false],
    ])('%s is a refusal: %s', (_name, err, expected) => {
        expect(isIntegrationLinkRefusal(err)).toBe(expected);
    });
});

describe('logIntegrationLinkFailure', () => {
    const logger = () => ({ warn: jest.fn(), error: jest.fn() });
    const metadata = { organizationAndTeamData: { organizationId: 'o1' } };

    it('logs a refusal as a warning with its reason', () => {
        const log = logger();
        const refusal = new BadRequestException('Token refused.');

        logIntegrationLinkFailure(log, {
            provider: 'GitLab',
            context: 'GitlabService',
            err: refusal,
            linkError: refusal,
            metadata,
        });

        expect(log.error).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith({
            message: 'GitLab integration refused',
            context: 'GitlabService',
            metadata: { ...metadata, reason: 'Token refused.' },
        });
    });

    it('logs a fault as an error with the original error', () => {
        const log = logger();
        const fault = new TypeError('boom');

        logIntegrationLinkFailure(log, {
            provider: 'Forgejo',
            context: 'ForgejoService',
            err: fault,
            linkError: fault,
            metadata,
        });

        expect(log.warn).not.toHaveBeenCalled();
        expect(log.error).toHaveBeenCalledWith({
            message: 'Failed to create Forgejo integration',
            context: 'ForgejoService',
            error: fault,
            metadata,
        });
    });
});
