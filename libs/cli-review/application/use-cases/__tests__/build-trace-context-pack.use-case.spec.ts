import {
    applyBudget,
    BuildTraceContextPackUseCase,
    matchesAnyPath,
    renderTraceContextPack,
} from '../build-trace-context-pack.use-case';
import { SessionEventRepository } from '@libs/cli-review/infrastructure/repositories/session-event.repository';
import {
    estimateTokens,
    TRACE_CONTEXT_PACK_TOKEN_BUDGET,
    TraceContextDecision,
} from '@libs/cli-review/domain/types/trace-context.types';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

const ORG = {
    organizationId: 'org-1',
    teamId: 'team-1',
};

function decision(
    overrides: Partial<TraceContextDecision> = {},
): TraceContextDecision {
    return {
        type: 'architectural_decision',
        decision: 'Invoice totals are cached on the row',
        confidence: 0.8,
        scope: ['src/billing'],
        ...overrides,
    };
}

describe('BuildTraceContextPackUseCase', () => {
    let repository: jest.Mocked<Pick<
        SessionEventRepository,
        'findClassifiedDecisions'
    >>;
    let useCase: BuildTraceContextPackUseCase;

    beforeEach(() => {
        repository = {
            findClassifiedDecisions: jest.fn().mockResolvedValue([]),
        };
        useCase = new BuildTraceContextPackUseCase(repository as any);
    });

    it('returns an empty pack when nothing has been recorded', async () => {
        const result = await useCase.execute({
            organizationAndTeamData: ORG,
            changedFilePaths: ['src/billing/invoice.ts'],
        });

        expect(result.decisions).toEqual([]);
        expect(result.estimatedTokens).toBe(0);
        // Rendering an empty pack produces no text at all, which is what keeps
        // the review prompt byte-identical.
        expect(renderTraceContextPack(result.decisions)).toBe('');
    });

    it('returns an empty pack when the diff touches nothing', async () => {
        repository.findClassifiedDecisions.mockResolvedValue([decision()]);

        const result = await useCase.execute({
            organizationAndTeamData: ORG,
            changedFilePaths: [],
        });

        expect(result.decisions).toEqual([]);
        expect(repository.findClassifiedDecisions).not.toHaveBeenCalled();
    });

    it('includes decisions for the changed area and none from unrelated ones', async () => {
        repository.findClassifiedDecisions.mockResolvedValue([
            decision({
                decision: 'billing decision',
                scope: ['src/billing'],
            }),
            decision({
                decision: 'auth decision',
                scope: ['src/auth/login.ts'],
            }),
            decision({
                decision: 'infra decision',
                scope: ['infra/terraform'],
            }),
        ]);

        const result = await useCase.execute({
            organizationAndTeamData: ORG,
            changedFilePaths: ['src/billing/invoice.ts'],
        });

        expect(result.decisions.map((d) => d.decision)).toEqual([
            'billing decision',
        ]);

        const rendered = renderTraceContextPack(result.decisions);
        expect(rendered).toContain('billing decision');
        expect(rendered).not.toContain('auth decision');
        expect(rendered).not.toContain('infra decision');
    });

    it('scopes the query to the branch when one is given', async () => {
        await useCase.execute({
            organizationAndTeamData: ORG,
            changedFilePaths: ['src/billing/invoice.ts'],
            branch: 'feat/billing',
        });

        expect(repository.findClassifiedDecisions).toHaveBeenCalledWith({
            organizationId: 'org-1',
            branch: 'feat/billing',
        });
    });

    it('deduplicates the same decision recorded across sessions', async () => {
        repository.findClassifiedDecisions.mockResolvedValue([
            decision({ confidence: 0.4 }),
            decision({ confidence: 0.9 }),
        ]);

        const result = await useCase.execute({
            organizationAndTeamData: ORG,
            changedFilePaths: ['src/billing/invoice.ts'],
        });

        expect(result.decisions).toHaveLength(1);
        expect(result.decisions[0].confidence).toBe(0.9);
    });

    it('returns an empty pack rather than failing when the store is unavailable', async () => {
        repository.findClassifiedDecisions.mockRejectedValue(
            new Error('database is down'),
        );

        const result = await useCase.execute({
            organizationAndTeamData: ORG,
            changedFilePaths: ['src/billing/invoice.ts'],
        });

        expect(result.decisions).toEqual([]);
    });
});

describe('matchesAnyPath', () => {
    it('matches a directory scope against a file inside it', () => {
        expect(
            matchesAnyPath(decision({ scope: ['src/billing'] }), [
                'src/billing/invoice.ts',
            ]),
        ).toBe(true);
    });

    it('matches a file scope against a changed directory', () => {
        expect(
            matchesAnyPath(decision({ scope: ['src/billing/invoice.ts'] }), [
                'src/billing',
            ]),
        ).toBe(true);
    });

    it('does not match a sibling prefix', () => {
        expect(
            matchesAnyPath(decision({ scope: ['src/billing'] }), [
                'src/billing-legacy/invoice.ts',
            ]),
        ).toBe(false);
    });

    it('normalizes leading ./ and backslashes', () => {
        expect(
            matchesAnyPath(decision({ scope: ['./src\\billing'] }), [
                'src/billing/invoice.ts',
            ]),
        ).toBe(true);
    });

    it('never matches a decision with no scope', () => {
        expect(
            matchesAnyPath(decision({ scope: [] }), ['src/billing/invoice.ts']),
        ).toBe(false);
        expect(
            matchesAnyPath(decision({ scope: undefined }), [
                'src/billing/invoice.ts',
            ]),
        ).toBe(false);
    });
});

describe('the 2000-token budget', () => {
    function bulky(
        id: string,
        confidence: number,
        pinned = false,
    ): TraceContextDecision {
        return decision({
            decision: `${id} ${'x'.repeat(4000)}`,
            confidence,
            pinned,
        });
    }

    it('defaults to 2000 tokens', () => {
        expect(TRACE_CONTEXT_PACK_TOKEN_BUDGET).toBe(2000);
    });

    it('keeps the pack within budget', () => {
        const result = applyBudget(
            [bulky('a', 0.9), bulky('b', 0.8), bulky('c', 0.7)],
            TRACE_CONTEXT_PACK_TOKEN_BUDGET,
        );

        expect(result.estimatedTokens).toBeLessThanOrEqual(
            TRACE_CONTEXT_PACK_TOKEN_BUDGET,
        );
        expect(result.droppedForBudget).toBeGreaterThan(0);
    });

    it('drops the lowest confidence first', () => {
        const result = applyBudget(
            [bulky('low', 0.1), bulky('high', 0.95), bulky('mid', 0.5)],
            estimateTokens(`- high ${'x'.repeat(4000)}`) + 200,
        );

        expect(result.decisions.map((d) => d.decision.split(' ')[0])).toEqual([
            'high',
        ]);
        expect(result.droppedForBudget).toBe(2);
    });

    it('never drops a pinned decision, even the lowest confidence one', () => {
        const result = applyBudget(
            [bulky('low-but-pinned', 0.01, true), bulky('high', 0.95)],
            10,
        );

        const kept = result.decisions.map((d) => d.decision.split(' ')[0]);
        expect(kept).toContain('low-but-pinned');
        expect(kept).not.toContain('high');
    });

    it('keeps everything when it all fits', () => {
        const result = applyBudget(
            [decision({ decision: 'a' }), decision({ decision: 'b' })],
            TRACE_CONTEXT_PACK_TOKEN_BUDGET,
        );

        expect(result.decisions).toHaveLength(2);
        expect(result.droppedForBudget).toBe(0);
    });
});
