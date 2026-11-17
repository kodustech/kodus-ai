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
