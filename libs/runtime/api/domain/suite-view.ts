import type { ClassifiedTest } from '@libs/runtime/suite';

import type { RuntimeEnvironmentSuiteView, RuntimeSuiteFailureGroup, RuntimeSuiteFailureView, RuntimeSuiteRunView, RuntimeSuiteUsage, RuntimeSuiteUsageLine } from '@libs/runtime/contracts/views/suite';

import type { StoredBaselineSummary, StoredSelectionMiss, StoredSelectionState, StoredSuiteResultRecord, StoredSuiteRun, StoredSuiteSavings, StoredSuiteUsageRow } from './suite';

// The suite's stored rows as the product's views (docs/runtime/e2e-suites.md sections 10 and 13). Pure: no I/O, no clock. Structured
// fields only (the web writes the sentences), and a field the rows do not say is absent, never a default that reads as a fact.

/** What the page shows of an error: the Runtime already redacted it and cut it to the evidence limits. */
export const SUITE_ERROR_VIEW_MAX = 1_000;

const GROUP_OF: Record<ClassifiedTest['class'], RuntimeSuiteFailureGroup> = {
    regression: 'regression',
    pre_existing: 'pre_existing',
    pre_existing_changed: 'pre_existing',
    flaky: 'flaky',
    regression_unconfirmed: 'unclassified',
    regression_probable: 'unclassified',
    failed_unconfirmed: 'unclassified',
    infra: 'unclassified',
    unclassified: 'unclassified',
};
const GROUP_ORDER: RuntimeSuiteFailureGroup[] = ['regression', 'unclassified', 'pre_existing', 'flaky'];
const RED_FIRST_PASS = new Set(['failed', 'infra', 'not_run']);

const lastFailedError = (t: { attempts: Array<{ status: string; error?: string }> } | undefined): string | undefined => {
    const e = [...(t?.attempts ?? [])].reverse().find((a) => a.status === 'failed')?.error;
    return e ? e.slice(0, SUITE_ERROR_VIEW_MAX) : undefined;
};

const testOf = (results: readonly StoredSuiteResultRecord[], phase: StoredSuiteResultRecord['phase'], spec: string, title: string) => results.find((r) => r.phase === phase && r.spec === spec)?.tests.find((t) => t.title === title);

export function runSuiteView(s: StoredSuiteRun): RuntimeSuiteRunView {
    const { run, results } = s;
    const first = new Map(results.filter((r) => r.phase === 'shard').map((r) => [r.spec, r]));
    const totals = { passed: 0, failed: 0, skipped: 0, notRun: 0 };
    for (const r of first.values()) {
        if (r.status === 'passed') totals.passed++;
        else if (r.status === 'failed') totals.failed++;
        else if (r.status === 'skipped') totals.skipped++;
        else totals.notRun++;
    }
    const selection = run.selection ?? { mode: 'full' as const, total: first.size };
    const reachedBy = selection.reachedBy ?? {};
    const reachedOf = (spec: string) => Object.entries(reachedBy).filter(([, specs]) => specs.includes(spec)).map(([file]) => file).sort();

    const failures: RuntimeSuiteFailureView[] = (run.classification?.tests ?? []).map((t) => {
        const prFirst = testOf(results, 'shard', t.spec, t.title);
        const prRerun = testOf(results, 'rerun_pr', t.spec, t.title);
        const mainRerun = testOf(results, 'rerun_main', t.spec, t.title);
        const tries = [...(prFirst?.attempts ?? []), ...(prRerun?.attempts ?? [])];
        const mainRan = results.some((r) => r.phase === 'rerun_main' && r.spec === t.spec);
        const artifacts = [...new Map(results.filter((r) => r.spec === t.spec).flatMap((r) => r.artifacts).map((a) => [a.key, a])).values()];
        const error = lastFailedError(prRerun) ?? lastFailedError(prFirst);
        return {
            spec: t.spec,
            title: t.title,
            group: GROUP_OF[t.class],
            detail: t.class,
            ...(t.reason ? { reason: t.reason } : {}),
            ...(error ? { error } : {}),
            pr: { attempts: tries.length, failed: tries.filter((a) => a.status === 'failed').length },
            ...(mainRan
                ? { main: { sha: run.mainSha, outcome: (mainRerun ? (mainRerun.status === 'failed' ? 'failed' : 'passed') : 'not_run') as 'passed' | 'failed' | 'not_run', sameError: !!t.prSignature && t.prSignature === t.mainSignature } }
                : {}),
            reachedBy: reachedOf(t.spec),
            artifacts: artifacts.map((a) => ({ name: a.name, contentType: a.contentType, bytes: a.bytes })),
        };
    });
    failures.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
    const count = (g: RuntimeSuiteFailureGroup) => failures.filter((f) => f.group === g).length;

    const shards = s.shards
        .filter((sh) => sh.specs.length > 0)
        .map((sh) => {
            const rows = sh.specs.map((spec) => first.get(spec)).filter((r): r is StoredSuiteResultRecord => !!r);
            const ms = rows.reduce((n, r) => n + r.durationMs, 0);
            return {
                shard: sh.shard,
                specs: sh.specs.length,
                passed: rows.filter((r) => r.status === 'passed').length,
                failed: rows.filter((r) => r.status === 'failed').length,
                notRun: sh.specs.length - rows.filter((r) => r.status === 'passed' || r.status === 'failed' || r.status === 'skipped').length,
                specMs: rows.length ? ms : null,
            };
        });
    const ended = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.requestedAt) : NaN;
    return {
        suiteRunId: run.suiteRunId,
        environmentId: run.environmentId,
        mode: run.mode === 'ci' ? 'ci' : 'run',
        state: run.state,
        requestedAt: run.requestedAt,
        ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
        ...(Number.isFinite(ended) && ended >= 0 ? { durationMs: ended } : {}),
        ...(run.prNumber !== undefined ? { prNumber: run.prNumber } : {}),
        ...(run.prSha ? { prSha: run.prSha } : {}),
        mainSha: run.mainSha,
        ...(run.mergeBase ? { mergeBase: run.mergeBase } : {}),
        ...(run.baselineSha ? { baselineSha: run.baselineSha } : {}),
        ...(run.baseDrift !== undefined ? { baseDrift: run.baseDrift } : {}),
        selection,
        specs: { ran: first.size, total: selection.total },
        totals,
        classes: { regression: count('regression'), preExisting: count('pre_existing'), flaky: count('flaky'), unclassified: count('unclassified') },
        ...(run.firstPassMs !== undefined && run.rerunMs !== undefined ? { machine: { firstPassMs: run.firstPassMs, rerunMs: run.rerunMs } } : {}),
        hosts: shards.length,
        shards,
        failures,
        passed: [...first.values()].filter((r) => r.status === 'passed').map((r) => r.spec).sort(),
        canRetry: !!run.finishedAt && [...first.values()].some((r) => RED_FIRST_PASS.has(r.status)),
    };
}

export function environmentSuiteView(i: {
    environmentId: string;
    recipe?: { runner: string; specs: string; command: string; cwd?: string; results?: { junit?: string }; shards?: number; gate: 'default' | 'strict'; baseline: boolean };
    lastBaseline?: StoredBaselineSummary | null;
    selection: StoredSelectionState;
    miss: StoredSelectionMiss | null;
    /** The environment's own switch (null: not set) and the deployment's default. */
    ci: { setting: boolean | null; deployment: boolean };
}): RuntimeEnvironmentSuiteView {
    const byPerson = i.selection.off && i.selection.offBy === 'person';
    const braked = (i.selection.off && !byPerson) || i.selection.fullPrsLeft > 0;
    return {
        environmentId: i.environmentId,
        ...(i.recipe
            ? {
                  recipe: {
                      runner: i.recipe.runner,
                      specs: i.recipe.specs,
                      command: i.recipe.command,
                      ...(i.recipe.cwd ? { cwd: i.recipe.cwd } : {}),
                      ...(i.recipe.results?.junit ? { results: i.recipe.results.junit } : {}),
                      ...(i.recipe.shards !== undefined ? { shards: i.recipe.shards } : {}),
                      gate: i.recipe.gate,
                      baseline: i.recipe.baseline,
                  },
              }
            : {}),
        ...(i.lastBaseline ? { lastBaseline: { ...i.lastBaseline } } : {}),
        selection: {
            enabled: !byPerson,
            ...(braked ? { brake: { off: i.selection.off && !byPerson, fullPrsLeft: i.selection.fullPrsLeft, ...(i.miss ? { miss: { prNumber: i.miss.prNumber, specs: [...i.miss.specs] } } : {}) } } : {}),
        },
        ci: i.ci.setting === null ? { enabled: i.ci.deployment, source: 'deployment' } : { enabled: i.ci.setting, source: 'environment' },
    };
}

const MIN_MS = 60_000;
const minutesOf = (ms: number) => Math.round(ms / MIN_MS);

/**
 * The month's suite lines, one per kind. PR counts the first passes of a Run and of CI mode; a re-run line counts the runs that had one,
 * with the time of their re-runs. A line whose runs never measured machine time says null, never zero.
 */
export function suiteUsageView(i: { rows: readonly StoredSuiteUsageRow[]; savings: StoredSuiteSavings | null }): RuntimeSuiteUsage {
    if (i.rows.length === 0) return { lines: [], unmeasuredRuns: 0 };
    const sum = (modes: readonly string[], pick: (r: StoredSuiteUsageRow) => number) => i.rows.filter((r) => modes.includes(r.mode)).reduce((n, r) => n + pick(r), 0);
    const unmeasured = (modes: readonly string[]) => sum(modes, (r) => r.unmeasured);
    const line = (kind: RuntimeSuiteUsageLine['kind'], modes: readonly string[], runs: number, ms: number): RuntimeSuiteUsageLine | null => {
        const total = sum(modes, (r) => r.runs);
        if (runs === 0 && total === 0) return null;
        const measured = kind === 'rerun' ? true : unmeasured(modes) < total;
        return { kind, runs, minutes: measured ? minutesOf(ms) : null };
    };
    const lines = [
        line('pr', ['run', 'ci'], sum(['run', 'ci'], (r) => r.runs), sum(['run', 'ci'], (r) => r.firstPassMs)),
        line('baseline', ['baseline'], sum(['baseline'], (r) => r.runs), sum(['baseline'], (r) => r.firstPassMs + r.rerunMs)),
        line('rerun', ['run', 'ci'], sum(['run', 'ci'], (r) => r.withRerun), sum(['run', 'ci'], (r) => r.rerunMs)),
        line('shadow', ['shadow'], sum(['shadow'], (r) => r.runs), sum(['shadow'], (r) => r.firstPassMs + r.rerunMs)),
    ].filter((l): l is RuntimeSuiteUsageLine => !!l && (l.runs > 0 || l.kind !== 'rerun'));
    return {
        lines,
        unmeasuredRuns: i.rows.reduce((n, r) => n + r.unmeasured, 0),
        ...(i.savings && i.savings.shadowedRuns > 0 && i.savings.savedMs > 0 ? { saved: { minutes: minutesOf(i.savings.savedMs), shadowedRuns: i.savings.shadowedRuns } } : {}),
    };
}
