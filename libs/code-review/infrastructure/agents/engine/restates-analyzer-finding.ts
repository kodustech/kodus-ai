import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { isAnalyzerSuggestion } from '@libs/code-review/infrastructure/analyzers/analyzer-findings-to-suggestions';
import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

/**
 * Whether an agent finding is a restatement of a deterministic one.
 *
 * A scanner asserts a fact at a location — "a credential is on line 4". An
 * agent finding whose span covers that line is describing the same thing, and
 * deciding that needs no semantic comparison.
 *
 * Which matters, because the dedup content guard's embedding tier is not
 * available in every deployment, and when it is missing the guard vetoes
 * EVERY merge (`lexical-veto (no-embed)`) — so the duplicate the scanner and
 * the agent both found gets published twice, exactly where we are most
 * confident it is one finding.
 */
export function restatesAnalyzerFinding(
    dup: Partial<CodeSuggestion>,
    keep: Partial<CodeSuggestion>,
): boolean {
    if (!isAnalyzerSuggestion(keep)) {
        return false;
    }

    if (
        !dup.relevantFile ||
        !keep.relevantFile ||
        dup.relevantFile !== keep.relevantFile
    ) {
        return false;
    }

    // A credential on line 4 and a logic bug spanning lines 3-29 share a span
    // without being the same finding. Both scanners report security facts, so
    // only a security finding can be restating one — a `bug` or `performance`
    // finding on the same lines is a different defect and must still go
    // through the content guard.
    //
    // Compared against the DUP's label, not the keep's: the kept finding is
    // the analyzer's and now carries its own `deterministic` category, so the
    // two labels never match by construction.
    if (dup.label !== LabelType.SECURITY) {
        return false;
    }

    const span = (s: Partial<CodeSuggestion>): [number, number] | null => {
        const start = s.relevantLinesStart;
        const end = s.relevantLinesEnd ?? start;
        // A missing range must not be read as an overlap at line 0.
        return typeof start === 'number' && typeof end === 'number'
            ? [start, end]
            : null;
    };

    const a = span(dup);
    const b = span(keep);
    if (!a || !b) {
        return false;
    }

    return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * Whether both sides of a proposed merge are scanner findings.
 *
 * `analyzerFindingsToSuggestions` emits at most one suggestion per tool, so
 * the only pair that can occur is secrets vs dependencies — different
 * categories, published as two comments deliberately. Merging them removes no
 * duplicate: the honored-merge path keeps only the representative's body, so
 * one category's findings would vanish from the review entirely.
 */
export function bothFromAnalyzers(
    a: Partial<CodeSuggestion>,
    b: Partial<CodeSuggestion>,
): boolean {
    return isAnalyzerSuggestion(a) && isAnalyzerSuggestion(b);
}
