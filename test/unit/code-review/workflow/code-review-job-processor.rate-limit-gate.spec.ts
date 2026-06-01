/**
 * Validates the rate-limit gate integration in CodeReviewJobProcessor:
 *   - When the gate is OK, processor reaches the use-case (happy path).
 *   - When the gate throws RateLimitError, processor surfaces it before
 *     entering the byok admission and the inner use-case is never called
 *     (no slot burn, no LLM tokens spent).
 *   - The error carries `resetAt` so the consumer error handler can
 *     compute the smart delay.
 */
import { CodeReviewJobProcessorService } from '@libs/code-review/workflow/code-review-job-processor.service';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { RateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

function makeJob() {
    return {
        id: 'job-rl-1',
        correlationId: 'corr',
        status: JobStatus.PENDING,
        payload: {
            codeManagementPayload: { number: 42 },
            event: 'pull_request',
            platformType: 'GITHUB',
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
            teamAutomationId: 'ta',
        },
        metadata: {},
    };
}

describe('CodeReviewJobProcessorService — rate-limit gate integration', () => {
    let useCaseExecute: jest.Mock;
    let gateCheck: jest.Mock;
    let processor: CodeReviewJobProcessorService;

    const mockJobRepository = {
        findOne: jest.fn(),
        update: jest.fn(),
    } as any;

    const mockByokGate = {
        tryEnter: jest
            .fn()
            .mockResolvedValue({ kind: 'acquired', lock: null }),
        deferJob: jest.fn(),
    };

    beforeEach(() => {
        jest.clearAllMocks();
        useCaseExecute = jest.fn().mockResolvedValue(undefined);
        gateCheck = jest.fn().mockResolvedValue(undefined);

        processor = new CodeReviewJobProcessorService(
            mockJobRepository,
            { execute: useCaseExecute } as any,
            mockByokGate as any,
            { notify: jest.fn() } as any,
            { resolve: jest.fn() } as any,
            { check: gateCheck } as any,
        );

        mockJobRepository.findOne.mockResolvedValue(makeJob());
        mockJobRepository.update.mockResolvedValue(undefined);
    });

    it('happy path: gate ok → use-case executes', async () => {
        await processor.process('job-rl-1');

        expect(gateCheck).toHaveBeenCalledWith(
            { organizationId: 'o', teamId: 't' },
            'GITHUB',
        );
        expect(useCaseExecute).toHaveBeenCalled();
    });

    it('rate-limited: gate throws → use-case is NOT called, error propagates with resetAt', async () => {
        const resetAt = new Date(Date.now() + 47 * 60 * 1000);
        gateCheck.mockRejectedValue(
            new RateLimitError({ resetAt, remaining: 12 }),
        );

        await expect(processor.process('job-rl-1')).rejects.toThrow(
            RateLimitError,
        );
        expect(useCaseExecute).not.toHaveBeenCalled();
        expect(mockByokGate.tryEnter).not.toHaveBeenCalled();

        // The rejected error must carry the resetAt for the consumer
        // error handler to compute its smart delay.
        try {
            await processor.process('job-rl-1');
        } catch (e) {
            expect(e).toBeInstanceOf(RateLimitError);
            expect((e as RateLimitError).resetAt).toEqual(resetAt);
        }
    });
});
