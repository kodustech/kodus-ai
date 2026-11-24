import { type FullReason, type SuiteCheckConclusion, type SuiteReport, type SuiteUnavailableReason, suiteConclusionOf } from '@libs/runtime/suite';

import type { PublishEnvironment } from './publish-environment';
import type { RuntimeLinks } from './render-runtime-comment';

// The suite's own check (docs/runtime/e2e-suites.md section 10.1): `Kody Runtime e2e`, beside the Run's `Kody Runtime`. Every
// sentence is the product's, written from the structured report; nothing of the Runtime's own text reaches the PR except the
// bounded error of an annotation.

export const KODY_RUNTIME_E2E_CHECK_NAME = 'Kody Runtime e2e';

/** One check per environment the PR runs in, named with it, as the Run's check is. */
export const suiteCheckNameOf = (env: PublishEnvironment): string => (env.key && env.name ? `${KODY_RUNTIME_E2E_CHECK_NAME} (${env.name})` : KODY_RUNTIME_E2E_CHECK_NAME);

const FULL_REASON_TEXT: Record<FullReason, string> = {
    manifest: 'a dependency manifest changed',
    lockfile: 'a lockfile changed',
    config: 'a runner, build or compose configuration changed',
    shared_routing: 'shared routing or setup code changed',
    uncovered_file: 'a changed file is covered by no spec, so nothing is skipped on a guess',
    map_missing: 'no coverage map is stored for this environment yet',
    map_stale: 'the stored coverage map is too old to trust',
    map_digest: 'the suite changed since the coverage map was made',
    noise_file: 'a changed file is exercised by most specs',
    ready_for_review: 'the pull request is ready for review',
    baseline: 'this is the baseline on main',
};

const UNAVAILABLE_TEXT: Record<SuiteUnavailableReason, string> = {
    template_missing: 'There is no ready environment template yet, so the suite cannot be listed or run. A build is requested; push again once it is ready.',
    no_host: 'No host could be started for the suite. Push again, or run it again from the Run page.',
    list_failed: 'The spec files of the suite could not be listed.',
    no_repository: 'The repository of this suite run is not known to the Runtime.',
    no_specs: 'The recipe names no spec file this run can execute.',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

function selectionLine(r: SuiteReport): string {
    const s = r.selection;
    if (s.mode === 'selected') return `Ran ${s.selected ?? 0} of ${s.total} specs the change can reach.`;
    if (s.mode === 'none') return 'No spec is reached by this change: none ran.';
    return s.reason ? `Ran the whole suite: ${FULL_REASON_TEXT[s.reason]}.` : 'Ran the whole suite.';
}

function titleOf(r: SuiteReport): string {
    if (r.state === 'running' || r.state === 'requested') return 'Running';
    if (r.unavailable) return 'Could not run';
    if (r.state === 'timed_out') return 'Timed out';
    if (r.state === 'cancelled') return 'Cancelled';
    if (r.state === 'errored') return 'Could not finish';
    const c = r.classes;
    if (c.regression > 0) return `${plural(c.regression, 'regression')} · ${plural(r.totals.passed, 'spec')} passed`;
    if (c.unclassified > 0) return `${plural(c.unclassified, 'failure')} not classified`;
    if (r.state === 'failed') return `${plural(r.totals.failed, 'spec')} failed`;
    if (r.state === 'neutral') return 'Not everything could be run';
    return `No regressions · ${plural(r.totals.passed, 'spec')} passed`;
}

export interface SuiteCheckOutput {
    title: string;
    summary: string;
    /** Absent while the suite runs. */
    conclusion?: SuiteCheckConclusion;
}

export function renderSuiteCheckOutput(r: SuiteReport, links: RuntimeLinks): SuiteCheckOutput {
    const open = r.state === 'running' || r.state === 'requested';
    const lines: string[] = [];
    if (open) {
        lines.push('Kody is running the end-to-end suite of this repository.');
    } else if (r.unavailable) {
        lines.push(UNAVAILABLE_TEXT[r.unavailable]);
    } else {
        lines.push('| | Specs |', '|---|---|', `| Passed | ${r.totals.passed} |`, `| Failed | ${r.totals.failed} |`, `| Skipped | ${r.totals.skipped} |`);
        if (r.totals.notRun > 0) lines.push(`| Not run | ${r.totals.notRun} |`);
        const c = r.classes;
        const classRows: Array<[string, number]> = [['Regression', c.regression], ['Pre-existing', c.preExisting], ['Flaky', c.flaky], ['Unclassified', c.unclassified], ['Infrastructure', c.infra]];
        if (classRows.some(([, n]) => n > 0)) {
            lines.push('', '| Failed test | Count |', '|---|---|', ...classRows.filter(([, n]) => n > 0).map(([k, n]) => `| ${k} | ${n} |`));
            if (c.preExisting > 0 || c.flaky > 0) lines.push('', 'Pre-existing and flaky failures do not fail this check.');
        }
    }
    lines.push('', selectionLine(r));
    if (r.baseline) lines.push(`Baseline: \`${r.baseline.sha.slice(0, 7)}\` on main.`);
    if (r.baseDrift) lines.push(`main has moved ${plural(r.baseDrift, 'commit')} since this branch started: update the branch to confirm.`);
    if (r.durationMs !== undefined && !open) lines.push(`Time to result: ${minutes(r.durationMs)}.`);
    if (r.annotationsOmitted > 0) lines.push(`${r.annotationsOmitted} more failures are not annotated.`);
    if (links.run) lines.push('', `[Open the Run](${links.run})`);
    return { title: titleOf(r), summary: lines.join('\n'), ...(open ? {} : { conclusion: suiteConclusionOf(r.state) }) };
}
