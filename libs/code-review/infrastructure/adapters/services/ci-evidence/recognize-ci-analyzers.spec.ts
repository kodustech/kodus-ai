import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    CheckEvidence,
    CheckEvidenceConclusion,
    CheckEvidenceStatus,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/checkEvidence.type';

import {
    ManagedTool,
    isToolCoveredByCi,
    recognizeCiAnalyzers,
} from './recognize-ci-analyzers';

const check = (
    name: string,
    overrides: Partial<CheckEvidence> = {},
): CheckEvidence => ({
    id: 'check-1',
    name,
    status: 'completed' as CheckEvidenceStatus,
    conclusion: 'success' as CheckEvidenceConclusion,
    url: null,
    completedAt: '2026-01-01T00:00:00Z',
    platform: PlatformType.GITHUB,
    ...overrides,
});

describe('recognizeCiAnalyzers', () => {
    it('recognizes an analyzer from an exact check name', () => {
        expect(recognizeCiAnalyzers([check('semgrep')])).toEqual(
            new Set(['semgrep']),
        );
    });

    it('recognizes an analyzer embedded in a matrix job name', () => {
        expect(
            recognizeCiAnalyzers([check('CodeQL / Analyze (javascript)')]),
        ).toEqual(new Set(['codeql']));
    });

    it('recognizes an analyzer from the reporter when the name is generic', () => {
        expect(
            recognizeCiAnalyzers([check('security', { reporter: 'snyk' })]),
        ).toEqual(new Set(['snyk']));
    });

    it('collects every distinct analyzer across checks', () => {
        expect(
            recognizeCiAnalyzers([
                check('semgrep'),
                check('gitleaks scan'),
                check('build'),
            ]),
        ).toEqual(new Set(['semgrep', 'gitleaks']));
    });

    it('ignores checks that are still running', () => {
        expect(
            recognizeCiAnalyzers([
                check('semgrep', { status: 'in_progress', conclusion: null }),
            ]),
        ).toEqual(new Set());
    });

    // A failing analyzer still ran — for most scanners a non-zero exit IS the
    // "found something" signal, so treating failure as "did not run" would
    // make us re-scan exactly the PRs their CI already flagged.
    it('counts a failed analyzer as having run', () => {
        expect(
            recognizeCiAnalyzers([check('semgrep', { conclusion: 'failure' })]),
        ).toEqual(new Set(['semgrep']));
    });

    it.each<CheckEvidenceConclusion>([
        'cancelled',
        'timed_out',
        'skipped',
        'stale',
    ])('ignores a %s analyzer — it produced no result', (conclusion) => {
        expect(
            recognizeCiAnalyzers([check('semgrep', { conclusion })]),
        ).toEqual(new Set());
    });

    it('does not match an analyzer name appearing inside an unrelated word', () => {
        expect(recognizeCiAnalyzers([check('resemgrepped-legacy')])).toEqual(
            new Set(),
        );
    });

    it('returns an empty set for no evidence', () => {
        expect(recognizeCiAnalyzers([])).toEqual(new Set());
    });
});

describe('isToolCoveredByCi', () => {
    it('skips our dependency scan when their CI runs an equivalent', () => {
        expect(
            isToolCoveredByCi(ManagedTool.DEPENDENCIES, [check('osv-scanner')]),
        ).toBe(true);
    });

    /**
     * Standing down needs proof that a dependency scan ran on this commit,
     * and a check NAME is not that. "Dependabot auto-merge" merges a PR and
     * scans nothing; trivy and snyk jobs are as often container or SAST runs
     * as they are SCA. Treating either as coverage silently disabled our own
     * scan on exactly the pull requests that most need it.
     */
    it.each(['Dependabot auto-merge', 'trivy', 'snyk'])(
        'does not let %s stand in for the dependency scan',
        (name) => {
            expect(
                isToolCoveredByCi(ManagedTool.DEPENDENCIES, [check(name)]),
            ).toBe(false);
        },
    );

    it('skips our secret scan when their CI runs an equivalent scanner', () => {
        expect(
            isToolCoveredByCi(ManagedTool.SECRETS, [check('trufflehog')]),
        ).toBe(true);
    });

    // Coverage does not cross categories: a SAST run says nothing about
    // whether secrets were scanned.
    it('does not let a SAST check cover the secret scan', () => {
        expect(isToolCoveredByCi(ManagedTool.SECRETS, [check('semgrep')])).toBe(
            false,
        );
    });

    it('does not let a secret scanner cover the dependency scan', () => {
        expect(
            isToolCoveredByCi(ManagedTool.DEPENDENCIES, [check('gitleaks')]),
        ).toBe(false);
    });

    // Recognition is broader than coverage: we still surface a CodeQL run as
    // evidence, but it no longer stands in for anything we run ourselves.
    it('recognizes a SAST run without it covering either tool', () => {
        expect(recognizeCiAnalyzers([check('codeql')])).toEqual(
            new Set(['codeql']),
        );
        expect(isToolCoveredByCi(ManagedTool.SECRETS, [check('codeql')])).toBe(
            false,
        );
        expect(
            isToolCoveredByCi(ManagedTool.DEPENDENCIES, [check('codeql')]),
        ).toBe(false);
    });

    it('runs our tool when CI has no recognized analyzer', () => {
        expect(
            isToolCoveredByCi(ManagedTool.SECRETS, [
                check('build'),
                check('test'),
            ]),
        ).toBe(false);
    });
});
