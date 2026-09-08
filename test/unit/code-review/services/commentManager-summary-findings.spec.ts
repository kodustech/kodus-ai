import { Test, TestingModule } from '@nestjs/testing';
import { CommentManagerService } from '@libs/code-review/infrastructure/adapters/services/commentManager.service';
import { PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { MessageTemplateProcessor } from '@libs/code-review/infrastructure/adapters/services/messageTemplateProcessor.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { CommentResult } from '@libs/core/infrastructure/config/types/general/codeReview.type';

// Mock logger
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

function finding(
    severity: string,
    relevantFile: string,
    relevantLinesStart: number,
    oneSentenceSummary: string,
): CommentResult {
    return {
        comment: {
            suggestion: {
                severity,
                relevantFile,
                relevantLinesStart,
                oneSentenceSummary,
            },
        },
    } as unknown as CommentResult;
}

// ---------------------------------------------------------------------------
// buildReviewFindingsBlock (private method, tested via `any`)
//
// The PR summary is generated after the review has aggregated its findings.
// Before this block existed the summary model only ever saw the diff, so any
// custom instruction asking it to reason about the review had nothing to
// reason about and invented an answer.
// ---------------------------------------------------------------------------

describe('CommentManagerService – buildReviewFindingsBlock', () => {
    let serviceAny: any;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CommentManagerService,
                { provide: PARAMETERS_SERVICE_TOKEN, useValue: {} },
                { provide: MessageTemplateProcessor, useValue: {} },
                { provide: ObservabilityService, useValue: {} },
                { provide: PermissionValidationService, useValue: {} },
                { provide: CodeManagementService, useValue: {} },
            ],
        }).compile();

        serviceAny = module.get<CommentManagerService>(
            CommentManagerService,
        ) as any;
    });

    it('returns nothing when no findings are supplied', () => {
        // The preview use case generates a summary before any review has run.
        // It must not claim the review found nothing — it has no review at all.
        expect(serviceAny.buildReviewFindingsBlock(undefined)).toBe('');
        expect(serviceAny.buildReviewFindingsBlock(undefined, undefined)).toBe(
            '',
        );
    });

    // PR-level findings are carried in their own array on the pipeline
    // context. Reading only the file-level one made a review whose findings
    // were all PR-level report "no issues" while its comments were visible
    // on the PR.
    it('counts PR-level findings, not just file-level ones', () => {
        const block: string = serviceAny.buildReviewFindingsBlock(
            [],
            [finding('high', 'src/a.ts', 1, 'PR-level finding')],
        );

        expect(block).toContain('produced 1 finding(s)');
        expect(block).toContain('PR-level finding');
        expect(block).not.toContain('found no issues');
    });

    it('merges file-level and PR-level findings into one tally', () => {
        const block: string = serviceAny.buildReviewFindingsBlock(
            [finding('high', 'src/a.ts', 1, 'File-level')],
            [finding('critical', 'src/b.ts', 2, 'PR-level')],
        );

        expect(block).toContain('produced 2 finding(s)');
        expect(block).toContain('critical: 1');
        expect(block).toContain('high: 1');
        // Ordering still holds across the merged set.
        expect(block.indexOf('[critical]')).toBeLessThan(
            block.indexOf('[high]'),
        );
    });

    it('caps the listed findings so the block cannot blow the token budget', () => {
        const many = Array.from({ length: 40 }, (_, i) =>
            finding('medium', `src/f${i}.ts`, i + 1, `Finding number ${i}`),
        );

        const block: string = serviceAny.buildReviewFindingsBlock(many);

        // Full count is still reported honestly...
        expect(block).toContain('produced 40 finding(s)');
        // ...but only 25 are listed, with the remainder acknowledged.
        expect((block.match(/^- \[/gm) || []).length).toBe(25);
        expect(block).toContain('...and 15 more finding(s)');
    });

    it('states explicitly that the review found nothing for an empty list', () => {
        const block = serviceAny.buildReviewFindingsBlock([]);

        expect(block).toContain('found no issues');
        // "review found nothing" must be distinguishable from "no findings
        // were given to me" — otherwise a clean PR and an unwired pipeline
        // produce the same summary.
        expect(block).not.toBe('');
    });

    it('lists findings worst-first regardless of input order', () => {
        const block: string = serviceAny.buildReviewFindingsBlock([
            finding('medium', 'src/b.ts', 12, 'Duplicated coercion logic'),
            finding('critical', 'src/a.ts', 40, 'Unauthenticated delete endpoint'),
            finding('low', 'src/c.ts', 3, 'Unused import'),
            finding('high', 'src/d.ts', 88, 'Null deref on absent record'),
        ]);

        const order = ['critical', 'high', 'medium', 'low'].map((s) =>
            block.indexOf(`[${s}]`),
        );

        expect(order.every((i) => i > -1)).toBe(true);
        expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('reports an accurate per-severity tally', () => {
        const block: string = serviceAny.buildReviewFindingsBlock([
            finding('high', 'src/a.ts', 1, 'One'),
            finding('medium', 'src/b.ts', 2, 'Two'),
            finding('medium', 'src/c.ts', 3, 'Three'),
        ]);

        expect(block).toContain('produced 3 finding(s)');
        expect(block).toContain('high: 1');
        expect(block).toContain('medium: 2');
        // Severities with no findings are omitted rather than reported as zero.
        expect(block).not.toContain('critical:');
        expect(block).not.toContain('low:');
    });

    it('includes the file and line of each finding', () => {
        const block: string = serviceAny.buildReviewFindingsBlock([
            finding('high', 'src/d.ts', 88, 'Null deref on absent record'),
        ]);

        expect(block).toContain('src/d.ts:88');
        expect(block).toContain('Null deref on absent record');
    });

    it('defaults a finding with no severity to medium instead of dropping it', () => {
        const block: string = serviceAny.buildReviewFindingsBlock([
            {
                comment: {
                    suggestion: {
                        relevantFile: 'src/x.ts',
                        oneSentenceSummary: 'Severity absent',
                    },
                },
            } as unknown as CommentResult,
        ]);

        expect(block).toContain('produced 1 finding(s)');
        expect(block).toContain('[medium]');
    });

    it('ignores entries that carry no suggestion payload', () => {
        const block: string = serviceAny.buildReviewFindingsBlock([
            { comment: {} } as unknown as CommentResult,
            finding('high', 'src/a.ts', 1, 'Real finding'),
        ]);

        expect(block).toContain('produced 1 finding(s)');
        expect(block).toContain('Real finding');
    });
});
