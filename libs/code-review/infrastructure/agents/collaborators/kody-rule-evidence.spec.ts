import { hasRuleEvidence } from './kody-rule-evidence';

const read = {
    path: 'src/controller.ts',
    content: '18: @route("/export")\n19: exportReports() { return report; }',
};

const confirmed = {
    rationale: 'The route lacks the required check.',
    existingRegressionPath: '',
    existingRegressionLine: 0,
    applies: true,
    confirmed: true,
    path: 'src/controller.ts',
    line: 18,
};

describe('Kody Rule evidence', () => {
    it('rejects a contrast-case complaint when the verifier found an existing test that pins the fix', () => {
        const spec = {
            path: 'record.spec.ts',
            content:
                '4: expect(run(timedOut)).toBe(false);\n7: expect(run(success)).toBe(true);',
        };
        const verdict = {
            ...confirmed,
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
    it('requires both an applicable rule and a citation to code actually read', () => {
        expect(hasRuleEvidence(confirmed, false, [read])).toBe(true);
        expect(
            hasRuleEvidence({ ...confirmed, applies: false }, false, [read]),
        ).toBe(false);
        expect(
            hasRuleEvidence({ ...confirmed, confirmed: false }, false, [read]),
        ).toBe(false);
        expect(hasRuleEvidence(confirmed, false, [])).toBe(false);
        expect(
            hasRuleEvidence({ ...confirmed, path: 'unread.ts' }, false, [read]),
        ).toBe(false);
        expect(hasRuleEvidence({ ...confirmed, line: 17 }, false, [read])).toBe(
            false,
        );
        expect(
            hasRuleEvidence(confirmed, false, [
                { ...read, content: 'Error reading file' },
            ]),
        ).toBe(false);
    });

    it('allows PR metadata for a metadata-only claim, never in place of repository evidence', () => {
        const metadata = {
            ...confirmed,
            path: 'PR title',
            line: 0,
        };
        expect(hasRuleEvidence(metadata, true, [])).toBe(true);
        expect(hasRuleEvidence(metadata, false, [])).toBe(false);
    });
});
