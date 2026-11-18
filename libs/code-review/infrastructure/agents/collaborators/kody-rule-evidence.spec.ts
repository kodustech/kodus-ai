import {
    hasRuleEvidence,
    hasSourceRefutation,
    kodyRuleEvidenceVerifier,
} from './kody-rule-evidence';
import { LLM } from '@libs/llm/llm';
import type { ReviewAgentInput } from '../review-agent.contract';

const read = {
    path: 'src/controller.ts',
    content: '18: @route("/export")\n19: exportReports() { return report; }',
};

const violation = {
    rationale: 'The route lacks the required check.',
    existingRegressionPath: '',
    existingRegressionLine: 0,
    verdict: 'violated' as const,
    path: 'src/controller.ts',
    line: 18,
};

describe('Kody Rule evidence', () => {
    it('accepts a refutation only when it cites a decisive line that was read', () => {
        const protectedRoute = {
            path: read.path,
            content: '18: @requirePolicy(Access.ExportReports)',
        };
        const refutation = {
            keep: false,
            confidence: 'high' as const,
            rationale: 'The guard is applied at src/controller.ts:18.',
        };
        expect(hasSourceRefutation(refutation, [protectedRoute])).toBe(true);
        expect(hasSourceRefutation(refutation, [])).toBe(false);
        expect(
            hasSourceRefutation(
                {
                    ...refutation,
                    rationale: 'The guard is at src/controller.ts:29.',
                },
                [protectedRoute],
            ),
        ).toBe(false);
        expect(
            hasSourceRefutation({ ...refutation, confidence: 'low' }, [
                protectedRoute,
            ]),
        ).toBe(false);
    });

    it('rejects a contrast-case complaint when the verifier found an existing test that pins the fix', () => {
        const spec = {
            path: 'record.spec.ts',
            content:
                '4: expect(run(timedOut)).toBe(false);\n7: expect(run(success)).toBe(true);',
        };
        const verdict = {
            ...violation,
            path: spec.path,
            line: 7,
            existingRegressionPath: spec.path,
            existingRegressionLine: 4,
        };
        expect(hasRuleEvidence(verdict, false, [spec])).toBe(false);
        expect(
            hasRuleEvidence({ ...verdict, existingRegressionLine: 99 }, false, [
                spec,
            ]),
        ).toBe(true);
    });
    it.each(['satisfied', 'not_applicable', 'insufficient_evidence'] as const)(
        'withholds a %s candidate even when the cited location was read',
        (verdict) => {
            expect(
                hasRuleEvidence({ ...violation, verdict }, false, [read]),
            ).toBe(false);
        },
    );

    it('requires a violation and a citation to code actually read', () => {
        expect(hasRuleEvidence(violation, false, [read])).toBe(true);
        expect(hasRuleEvidence(violation, false, [])).toBe(false);
        expect(
            hasRuleEvidence({ ...violation, path: 'unread.ts' }, false, [read]),
        ).toBe(false);
        expect(hasRuleEvidence({ ...violation, line: 17 }, false, [read])).toBe(
            false,
        );
        expect(
            hasRuleEvidence(violation, false, [
                { ...read, content: 'Error reading file' },
            ]),
        ).toBe(false);
    });

    it('allows PR metadata for a metadata-only claim, never in place of repository evidence', () => {
        const metadata = {
            ...violation,
            path: 'PR title',
            line: 0,
        };
        expect(hasRuleEvidence(metadata, true, [])).toBe(true);
        expect(hasRuleEvidence(metadata, false, [])).toBe(false);
    });
});

describe('Kody Rule evidence deadline', () => {
    afterEach(() => jest.restoreAllMocks());

    const candidate = {
        ruleId: 1,
        suggestionContent: 'Missing issue in title',
    };
    const shard = {
        filename: null,
        system: '',
        user: '',
        ruleUuids: ['rule'],
        ruleUnits: [{ uuid: 'rule' }],
        verifyRepositoryFacts: true,
    };
    const verify = () =>
        kodyRuleEvidenceVerifier(
            {
                changedFiles: [],
                prTitle: 'Update title',
            } as unknown as ReviewAgentInput,
            undefined,
            false,
        );

    it('withholds a candidate once the deadline expires without asking for a verdict', async () => {
        const judge = jest
            .spyOn(LLM, 'run')
            .mockResolvedValue({ verdict: 'satisfied' });
        const deadline = Date.now() + 50;
        jest.spyOn(Date, 'now').mockReturnValue(deadline);
        await expect(verify()(candidate, shard, deadline)).rejects.toThrow(
            'deadline',
        );
        expect(judge).not.toHaveBeenCalled();
    });

    it.each([
        [700, 700],
        [180_000, 90_000],
    ])(
        'limits the verdict timeout with %i ms remaining',
        async (remaining, expected) => {
            const judge = jest
                .spyOn(LLM, 'run')
                .mockResolvedValue({ verdict: 'satisfied' });
            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);
            await expect(
                verify()(candidate, shard, now + remaining),
            ).resolves.toBe(false);
            expect(judge).toHaveBeenCalledWith(
                expect.objectContaining({ timeoutMs: expected }),
            );
        },
    );
});
