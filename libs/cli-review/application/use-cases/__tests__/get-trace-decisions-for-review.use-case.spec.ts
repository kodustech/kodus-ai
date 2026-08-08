import { GetTraceDecisionsForReviewUseCase } from '../get-trace-decisions-for-review.use-case';

describe('GetTraceDecisionsForReviewUseCase', () => {
    const repo = {
        findClassifiedByBranch: jest.fn(),
    };

    const useCase = new GetTraceDecisionsForReviewUseCase(repo as any);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('returns empty when org or branch missing', async () => {
        expect(
            await useCase.execute({ organizationId: '', branch: 'main' }),
        ).toEqual([]);
        expect(repo.findClassifiedByBranch).not.toHaveBeenCalled();
    });

    it('maps classified session_end decisions for the branch', async () => {
        repo.findClassifiedByBranch.mockResolvedValue([
            {
                sessionId: 'sess-abcdef12',
                payload: {
                    filesModified: [{ path: 'src/auth/jwt.ts' }],
                },
                decisions: [
                    {
                        type: 'architectural_decision',
                        decision: 'Use JWT',
                        rationale: 'stateless',
                        confidence: 0.9,
                        evidence: ['src/auth/jwt.ts'],
                    },
                ],
            },
        ]);

        const result = await useCase.execute({
            organizationId: 'org-1',
            branch: 'feat/auth',
        });

        expect(repo.findClassifiedByBranch).toHaveBeenCalledWith(
            'org-1',
            'feat/auth',
        );
        expect(result).toHaveLength(1);
        expect(result[0].decision).toBe('Use JWT');
        expect(result[0].paths).toContain('src/auth/jwt.ts');
        expect(result[0].type).toBe('architectural_decision');
    });

    it('fails open on repository errors', async () => {
        repo.findClassifiedByBranch.mockRejectedValue(new Error('db down'));
        await expect(
            useCase.execute({ organizationId: 'org-1', branch: 'main' }),
        ).resolves.toEqual([]);
    });
});
