import {
    BadRequestException,
    ForbiddenException,
    HttpException,
    InternalServerErrorException,
} from '@nestjs/common';

import {
    isIntegrationLinkRefusal,
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
        ['octokit', fail({ status: 401 })],
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
            fail({ status: 403 }),
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

    it.each(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'CERT_HAS_EXPIRED'])(
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
