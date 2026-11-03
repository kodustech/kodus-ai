jest.mock(
    '@libs/issues/application/use-cases/generate-issues-from-pr-closed.use-case',
    () => ({
        GenerateIssuesFromPrClosedUseCase: class GenerateIssuesFromPrClosedUseCase {},
    }),
);
jest.mock(
    '@libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case',
    () => ({
        ChatWithKodyFromGitUseCase: class ChatWithKodyFromGitUseCase {},
    }),
);

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { IWebhookEventParams } from '@libs/platform/domain/platformIntegrations/interfaces/webhook-event-handler.interface';
import { BitbucketPullRequestHandler } from './bitbucketPullRequest.handler';

describe('BitbucketPullRequestHandler deterministic logic', () => {
    let handler: BitbucketPullRequestHandler;

    beforeEach(() => {
        jest.clearAllMocks();
        // The two covered methods use no constructor dependency, so inert
        // stubs are sufficient for direct construction.
        handler = new BitbucketPullRequestHandler(
            {} as any, // webhookContextService
            {} as any, // pullRequestsService
            {} as any, // savePullRequestUseCase
            {} as any, // chatWithKodyFromGitUseCase
            {} as any, // codeManagement
            {} as any, // generateIssuesFromPrClosedUseCase
            {} as any, // eventEmitter
            {} as any, // enqueueCodeReviewJobUseCase
            {} as any, // enqueueImplementationCheckUseCase
            {} as any, // outboxRepository
            {} as any, // enqueueAstGraphUpdateOnMergedUseCase (optional)
        );
    });

    describe('canHandle', () => {
        const SUPPORTED_EVENTS = [
            // cloud events
            'pullrequest:created',
            'pullrequest:updated',
            'pullrequest:fulfilled',
            'pullrequest:rejected',
            'pullrequest:comment_created',
            // data center events
            'pr:opened',
            'pr:modified',
            'pr:reviewer:updated',
            'pr:comment:added',
            'pr:merged',
            'pr:declined',
        ];

        it.each(SUPPORTED_EVENTS)(
            'returns true for BITBUCKET event "%s"',
            (event) => {
                const params = {
                    platformType: PlatformType.BITBUCKET,
                    event,
                } as unknown as IWebhookEventParams;

                expect(handler.canHandle(params)).toBe(true);
            },
        );

        it('returns false when platformType is not BITBUCKET but the event is supported', () => {
            const params = {
                platformType: PlatformType.GITHUB,
                event: 'pullrequest:created',
            } as unknown as IWebhookEventParams;

            // Kills the && -> || mutant: a supported event alone must not pass.
            expect(handler.canHandle(params)).toBe(false);
        });

        it('returns false for a BITBUCKET event that is not in the supported list', () => {
            const params = {
                platformType: PlatformType.BITBUCKET,
                event: 'pullrequest:approved',
            } as unknown as IWebhookEventParams;

            expect(handler.canHandle(params)).toBe(false);
        });

        it('returns false for an empty event string on BITBUCKET', () => {
            const params = {
                platformType: PlatformType.BITBUCKET,
                event: '',
            } as unknown as IWebhookEventParams;

            expect(handler.canHandle(params)).toBe(false);
        });

        it('returns false when both platform and event are wrong', () => {
            const params = {
                platformType: PlatformType.GITLAB,
                event: 'merge_request',
            } as unknown as IWebhookEventParams;

            expect(handler.canHandle(params)).toBe(false);
        });

        it('does not treat a GitHub-style pull_request event as supported on BITBUCKET', () => {
            const params = {
                platformType: PlatformType.BITBUCKET,
                event: 'pull_request',
            } as unknown as IWebhookEventParams;

            expect(handler.canHandle(params)).toBe(false);
        });
    });

    describe('isBitbucketPullRequestEvent', () => {
        const call = (event: any): boolean =>
            (handler as any).isBitbucketPullRequestEvent(event);

        it('returns true for a complete Cloud event (pullrequest + actor + repository)', () => {
            const event = {
                pullrequest: { id: 1 },
                actor: { uuid: 'u' },
                repository: { uuid: 'r' },
            };

            expect(call(event)).toBe(true);
        });

        it('returns false for a Cloud event missing the repository', () => {
            const event = {
                pullrequest: { id: 1 },
                actor: { uuid: 'u' },
                // repository undefined
            };

            expect(call(event)).toBe(false);
        });

        it('returns false for a Cloud event missing the pullrequest', () => {
            const event = {
                actor: { uuid: 'u' },
                repository: { uuid: 'r' },
            };

            expect(call(event)).toBe(false);
        });

        it('returns false for a Cloud event missing the actor', () => {
            const event = {
                pullrequest: { id: 1 },
                repository: { uuid: 'r' },
            };

            expect(call(event)).toBe(false);
        });

        it('returns true for a Data Center event without a repository', () => {
            const event = {
                isDataCenterEvent: true,
                pullrequest: { id: 1 },
                actor: { uuid: 'u' },
                // repository intentionally absent - not required for DC
            };

            // Kills mutants that drop the isDataCenterEvent guard on the
            // repository requirement.
            expect(call(event)).toBe(true);
        });

        it('returns false for a Data Center event missing the pullrequest', () => {
            const event = {
                isDataCenterEvent: true,
                actor: { uuid: 'u' },
            };

            expect(call(event)).toBe(false);
        });

        it('returns false for a Data Center event missing the actor', () => {
            const event = {
                isDataCenterEvent: true,
                pullrequest: { id: 1 },
            };

            expect(call(event)).toBe(false);
        });

        it('requires repository when isDataCenterEvent is truthy but not strictly true', () => {
            const event = {
                isDataCenterEvent: 'true', // string, not boolean true
                pullrequest: { id: 1 },
                actor: { uuid: 'u' },
                // repository absent -> must be treated as a Cloud event -> false
            };

            // Kills the === true -> == true / truthiness mutants.
            expect(call(event)).toBe(false);
        });

        it('returns false for null input', () => {
            expect(call(null)).toBe(false);
        });

        it('returns false for undefined input', () => {
            expect(call(undefined)).toBe(false);
        });

        it('returns false for an empty object', () => {
            expect(call({})).toBe(false);
        });

        it('accepts a Cloud event even when repository is falsy-but-defined only if truly defined', () => {
            // repository defined (empty object) counts as present.
            const event = {
                pullrequest: { id: 1 },
                actor: { uuid: 'u' },
                repository: {},
            };

            expect(call(event)).toBe(true);
        });
    });
    // getCommitsForPullRequestForCodeReview returns null when Bitbucket rejects
    // the call (dead credentials, 2FA); reading `.length` on it logged a
    // misleading TypeError on every such webhook (87/day).
    describe('shouldTriggerCodeReview on pullrequest:updated', () => {
        const buildHandler = (commits: unknown) => {
            const codeManagement = {
                getCommitsForPullRequestForCodeReview: jest
                    .fn()
                    .mockResolvedValue(commits),
            };
            const h = new BitbucketPullRequestHandler(
                {
                    getContext: jest.fn().mockResolvedValue({
                        organizationAndTeamData: {
                            organizationId: 'org-1',
                            teamId: 'team-1',
                        },
                    }),
                } as any,
                {
                    findByNumberAndRepositoryName: jest.fn().mockResolvedValue({
                        isDraft: false,
                        commits: [{ sha: 'stored-sha' }],
                    }),
                } as any,
                {} as any,
                {} as any,
                codeManagement as any,
                {} as any,
                {} as any,
                {} as any,
                {} as any,
                {} as any,
            );
            return h as any;
        };

        const params = {
            event: 'pullrequest:updated',
            platformType: PlatformType.BITBUCKET,
            payload: {
                pullrequest: { id: 7, state: 'OPEN', draft: false },
                actor: { uuid: '{actor}' },
                repository: { uuid: '{repo-1}', name: 'repo' },
            },
        } as unknown as IWebhookEventParams;

        it('does not throw when the commit fetch returned null and still reviews the open PR', async () => {
            const h = buildHandler(null);

            await expect(h.shouldTriggerCodeReview(params)).resolves.toBe(true);
            expect(h.logger.error).not.toHaveBeenCalled();
        });

        it('skips the review when the head commit was already analyzed', async () => {
            const h = buildHandler([{ sha: 'stored-sha' }]);

            await expect(h.shouldTriggerCodeReview(params)).resolves.toBe(
                false,
            );
        });
    });

    describe('listMergedPrFiles', () => {
        const params = {
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't' },
            repository: { id: 'r1', name: 'api' },
            prNumber: 7,
        } as any;
        const handlerWith = (getFilesByPullRequestId: jest.Mock) => {
            const handler = Object.create(
                BitbucketPullRequestHandler.prototype,
            ) as any;
            handler.codeManagement = { getFilesByPullRequestId };
            handler.logger = {
                warn: jest.fn(),
                error: jest.fn(),
                log: jest.fn(),
            };
            return handler;
        };
        const files = [{ filename: 'a.ts', status: 'modified' }];

        it('reads the merged PR once more after a network failure', async () => {
            const get = jest
                .fn()
                .mockRejectedValueOnce(new TypeError('fetch failed'))
                .mockResolvedValueOnce(files);
            const handler = handlerWith(get);

            await expect(handler.listMergedPrFiles(params)).resolves.toBe(
                files,
            );
            expect(get).toHaveBeenCalledTimes(2);
            expect(handler.logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    metadata: { organizationId: 'org-1', prNumber: 7 },
                }),
            );
        });

        it.each([
            [
                'a rate limit',
                Object.assign(new Error('Too Many Requests'), { status: 429 }),
            ],
            ['any other failure', new Error('unexpected payload')],
        ])('does not read it again after %s', async (_label, failure) => {
            const get = jest.fn().mockRejectedValue(failure);
            const handler = handlerWith(get);

            await expect(handler.listMergedPrFiles(params)).rejects.toBe(
                failure,
            );
            expect(get).toHaveBeenCalledTimes(1);
        });
    });
});
