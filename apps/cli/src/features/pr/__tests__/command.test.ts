import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/pr-reviews.service.js', () => ({
    pullRequestReviewsService: { list: vi.fn() },
}));

import { pullRequestReviewsService } from '../../../services/pr-reviews.service.js';
import { createPrCommand } from '../command.js';

describe('createPrCommand', () => {
    it('registers the expected pull request subcommands', () => {
        const command = createPrCommand();

        expect(command.name()).toBe('pr');
        expect(command.commands.map((subcommand) => subcommand.name())).toEqual(
            expect.arrayContaining([
                'suggestions',
                'reviews',
                'business-validation',
            ]),
        );
    });

    describe('reviews', () => {
        beforeEach(() => {
            vi.clearAllMocks();
        });

        it('explains the recorded review against the live head and names failed specialists', async () => {
            vi.mocked(pullRequestReviewsService.list).mockResolvedValue({
                prNumber: 42,
                repository: 'acme/api',
                team: 'Platform',
                currentHeadSha: 'new-head',
                truncated: false,
                runs: [
                    {
                        prNumber: 42,
                        title: 'Test',
                        status: 'open',
                        merged: false,
                        url: '',
                        repositoryName: 'api',
                        repositoryId: 'repo-1',
                        recordedReviewedHeadSha: 'old-head',
                        reviewMode: 'heavy',
                        reviewRoutingReason: 'risk-found',
                        approvalDecision: {
                            kind: 'hold',
                            reason: 'The PR changed.',
                        },
                        codeReviewTimeline: [
                            {
                                status: 'error',
                                metadata: {
                                    specialists: [
                                        {
                                            label: 'lens-test',
                                            status: 'failed',
                                        },
                                    ],
                                },
                            },
                            {
                                status: 'error',
                                stageName:
                                    'AgentReview::custom-agent-pr-lifecycle',
                                stageLabel: 'PR lifecycle',
                                message: 'Agent failed.',
                            },
                        ],
                    },
                ],
            });
            const log = vi.spyOn(console, 'log').mockImplementation(() => {});
            await createPrCommand().parseAsync(['reviews', '42', '--explain'], {
                from: 'user',
            });
            expect(pullRequestReviewsService.list).toHaveBeenCalledWith(
                expect.objectContaining({ explain: true }),
            );
            const output = log.mock.calls
                .map((call) => call.join(' '))
                .join('\n');
            expect(output).toContain('old-head (older or different head)');
            expect(output).toContain('heavy (risk found)');
            expect(output).toContain('lens-test: failed');
            expect(output).toContain('PR lifecycle: Agent failed.');
            expect(output).toContain('The PR changed.');
            log.mockRestore();
        });

        it('passes the PR number and repository options to the service', async () => {
            vi.mocked(pullRequestReviewsService.list).mockResolvedValue({
                prNumber: 42,
                repository: 'acme/api',
                team: 'Platform',
                runs: [],
                truncated: false,
            });
            const logSpy = vi
                .spyOn(console, 'log')
                .mockImplementation(() => {});

            await createPrCommand().parseAsync(
                [
                    'reviews',
                    '42',
                    '--repo',
                    'acme/api',
                    '--team',
                    'Platform',
                    '--limit',
                    '5',
                    '--json',
                ],
                { from: 'user' },
            );

            expect(pullRequestReviewsService.list).toHaveBeenCalledWith({
                prNumber: 42,
                repository: 'acme/api',
                repositoryId: undefined,
                team: 'Platform',
                limit: 5,
            });
            const output = logSpy.mock.calls
                .map((call) => call.join(' '))
                .join('\n');
            expect(JSON.parse(output)).toEqual(
                expect.objectContaining({ prNumber: 42, runs: [] }),
            );
        });
    });
});
