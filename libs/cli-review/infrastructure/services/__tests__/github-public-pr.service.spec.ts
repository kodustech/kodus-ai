import { ConfigService } from '@nestjs/config';
import {
    GitHubPublicPrService,
    PublicPrFetchError,
} from '../github-public-pr.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('GitHubPublicPrService', () => {
    const configService = {
        get: jest.fn(() => undefined),
    } as unknown as ConfigService;

    const service = new GitHubPublicPrService(configService);

    describe('parseUrl', () => {
        it.each([
            [
                'https://github.com/sgl-project/sglang/pull/12668',
                { owner: 'sgl-project', repo: 'sglang', prNumber: 12668 },
            ],
            [
                'https://www.github.com/openai/codex/pull/8961',
                { owner: 'openai', repo: 'codex', prNumber: 8961 },
            ],
            [
                'https://github.com/microsoft/vscode/pull/240128/files',
                { owner: 'microsoft', repo: 'vscode', prNumber: 240128 },
            ],
            [
                '  https://github.com/kodus-ai/kodus-ai/pull/123  ',
                { owner: 'kodus-ai', repo: 'kodus-ai', prNumber: 123 },
            ],
            [
                'https://github.com/kodus-ai/kodus-ai.git/pull/42',
                { owner: 'kodus-ai', repo: 'kodus-ai', prNumber: 42 },
            ],
        ])('parses %s', (input, expected) => {
            expect(service.parseUrl(input)).toEqual(expected);
        });

        it.each([
            'not a url',
            'https://github.com/kodus-ai/kodus-ai',
            'https://github.com/kodus-ai/kodus-ai/pull/abc',
            'https://github.com/kodus-ai/kodus-ai/issues/1',
            'https://github.com/onlyone/pull/1',
            'https://github.com/kodus-ai/kodus-ai/pull/0',
        ])('rejects %s', (input) => {
            expect(() => service.parseUrl(input)).toThrow(PublicPrFetchError);
        });

        it.each([
            ['https://gitlab.com/kodus/kodus-ai/-/merge_requests/1', 'GitLab'],
            [
                'https://gitlab.com/group/sub/repo/-/merge_requests/42',
                'GitLab',
            ],
            [
                'https://bitbucket.org/kodus/kodus-ai/pull-requests/7',
                'Bitbucket',
            ],
            [
                'https://dev.azure.com/kodus/proj/_git/repo/pullrequest/9',
                'Azure DevOps',
            ],
            [
                'https://kodus.visualstudio.com/proj/_git/repo/pullrequest/9',
                'Azure DevOps',
            ],
            [
                'https://github.acme-corp.com/owner/repo/pull/123',
                'GitHub Enterprise',
            ],
        ])(
            'routes %s to requires_auth with %s mention',
            (input, providerName) => {
                try {
                    service.parseUrl(input);
                    fail('expected throw');
                } catch (err) {
                    expect(err).toBeInstanceOf(PublicPrFetchError);
                    const e = err as PublicPrFetchError;
                    expect(e.code).toBe('requires_auth');
                    expect(e.statusCode).toBe(403);
                    expect(e.message).toContain(providerName);
                }
            },
        );
    });

    describe('fetch', () => {
        const realFetch = global.fetch;

        afterEach(() => {
            global.fetch = realFetch;
            jest.restoreAllMocks();
        });

        function mockFetchOnce(
            metadataResponse: Partial<Response>,
            diffResponse: Partial<Response>,
        ) {
            global.fetch = jest
                .fn()
                .mockImplementationOnce(async () => metadataResponse as Response)
                .mockImplementationOnce(async () => diffResponse as Response);
        }

        function metaOk(body: any): Partial<Response> {
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => body,
                text: async () => JSON.stringify(body),
            };
        }

        function diffOk(diff: string): Partial<Response> {
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                text: async () => diff,
                json: async () => ({}),
            };
        }

        function err(status: number): Partial<Response> {
            return {
                ok: false,
                status,
                headers: new Headers(),
                json: async () => ({ message: 'err' }),
                text: async () => 'err',
            };
        }

        it('returns metadata and diff for a public PR', async () => {
            mockFetchOnce(
                metaOk({
                    title: 'add feature',
                    state: 'open',
                    draft: false,
                    head: { sha: 'aaa', ref: 'feat/x' },
                    base: { sha: 'bbb', ref: 'main' },
                    additions: 10,
                    deletions: 2,
                    changed_files: 3,
                    html_url: 'https://github.com/o/r/pull/1',
                }),
                diffOk('diff --git a/x b/x\n+hello'),
            );

            const result = await service.fetch(
                'https://github.com/o/r/pull/1',
            );

            expect(result.title).toBe('add feature');
            expect(result.headSha).toBe('aaa');
            expect(result.baseSha).toBe('bbb');
            expect(result.cloneUrl).toBe('https://github.com/o/r.git');
            expect(result.diff).toContain('diff --git');
        });

        it('throws requires_auth on 404', async () => {
            mockFetchOnce(err(404), diffOk(''));
            await expect(
                service.fetch('https://github.com/o/r/pull/1'),
            ).rejects.toMatchObject({
                code: 'requires_auth',
                statusCode: 403,
            });
        });

        it('throws too_large when additions+deletions exceed cap', async () => {
            mockFetchOnce(
                metaOk({
                    title: 't',
                    state: 'open',
                    head: { sha: 'a', ref: 'x' },
                    base: { sha: 'b', ref: 'main' },
                    additions: 11000,
                    deletions: 0,
                    changed_files: 5,
                }),
                diffOk(''),
            );
            await expect(
                service.fetch('https://github.com/o/r/pull/1'),
            ).rejects.toMatchObject({ code: 'too_large' });
        });

        it('throws rate_limited when x-ratelimit-remaining=0', async () => {
            const headers = new Headers();
            headers.set('x-ratelimit-remaining', '0');
            global.fetch = jest.fn().mockResolvedValue({
                ok: false,
                status: 403,
                headers,
                json: async () => ({}),
                text: async () => '',
            } as Partial<Response> as Response);

            await expect(
                service.fetch('https://github.com/o/r/pull/1'),
            ).rejects.toMatchObject({ code: 'requires_auth' });
        });
    });
});
