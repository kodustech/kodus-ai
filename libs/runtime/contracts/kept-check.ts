import { z } from 'zod';

import { BrowserProbeSchema, CompareFieldSchema, HttpProbeSchema, type Probe } from '@libs/runtime/probe/probe.schema';

import { ProbeAssertionsSchema } from './probe-assertions';

// A kept check (docs/runtime/kept-checks.md): the probe that proved a
// regression, kept so every later Run of the repository plays it again on base
// and PR through the same gate. The product stores it; a Run receives it as a
// snapshot in RuntimeRunRequested.keptChecks.

/** Active kept checks per environment and repository; a Run plays all of them, so it is also the per-Run cap. */
export const MAX_KEPT_CHECKS_PER_REPOSITORY = 10;
/** Wall time of a Run's kept-check phase: a check the phase has not started by then is `skipped`. */
export const KEPT_CHECKS_BUDGET_MS = 5 * 60_000;
/** How long the Runtime keeps each Run's outcome of a kept check (the metric reads them). */
export const KEPT_CHECK_RESULTS_RETENTION_DAYS = 180;
/** The probe id a kept check plays under in a Run: never one the planner writes (its ids have no colon prefix of this kind). */
export const KEPT_CHECK_PROBE_PREFIX = 'kept:';

/** `ProbeVerdict.source` and the report path's `source` of a probe a kept check played. */
export const KEPT_CHECK_SOURCE = 'kept_check' as const;

/** What a Run made of one kept check (docs/runtime/kept-checks.md §5). */
export const KEPT_CHECK_OUTCOMES = ['passed', 'failed', 'intended', 'stale', 'inconclusive', 'skipped'] as const;
export type KeptCheckOutcomeKind = (typeof KEPT_CHECK_OUTCOMES)[number];

/** Why a kept check cannot run as kept: main no longer has what it guarded. */
export const KEPT_CHECK_STALE_REASONS = ['target_gone', 'route_gone', 'baseline_changed'] as const;
export type KeptCheckStaleReason = (typeof KEPT_CHECK_STALE_REASONS)[number];

/** The probe kinds a kept check can hold: their expectation on main is closed (an HTTP status, every browser step passing). */
export const KEPT_CHECK_KINDS = ['http', 'browser'] as const;

/** Marks the redactor leaves (`[redacted:<rule>]`, `[redacted]`): a probe that carries one cannot be replayed as sent. */
export const REDACTION_MARKER = '[redacted';

export const KeptCheckProbeSchema = z.strictObject({
    spec: z.union([HttpProbeSchema, BrowserProbeSchema]),
    purpose: z.string().min(1).max(512),
    expected: z.string().min(1).max(2_048),
    compare: z.array(CompareFieldSchema).min(1).max(9),
});
export type KeptCheckProbe = z.infer<typeof KeptCheckProbeSchema>;

/** One kept check as a Run receives it. */
export const KeptCheckSchema = z
    .strictObject({
        keptCheckId: z.uuid(),
        /** The entry point it guards, as the finding named it. Shown only: coverage comes from the observer's log. */
        entryPoint: z.string().min(1).max(512),
        probe: KeptCheckProbeSchema,
        /** HTTP: the status main answered when the check was kept. Required for http, absent for browser. */
        assertions: ProbeAssertionsSchema.optional(),
        /** The fields that diverged when it was kept, names only. */
        differingFields: z.array(z.string().min(1).max(128)).max(5),
        /** The PR it was kept from: the metric counts failures on other PRs only. */
        sourcePrNumber: z.number().int().min(1),
    })
    .refine((k) => (k.probe.spec.kind === 'http') === !!k.assertions, { message: 'an http kept check carries the status main answered; a browser one carries none' });
export type KeptCheck = z.infer<typeof KeptCheckSchema>;

export const KeptChecksSchema = z.array(KeptCheckSchema).max(MAX_KEPT_CHECKS_PER_REPOSITORY);

/** The probe a kept check plays as, in a Run: its own id, so its rounds have their own step ids. */
export function keptCheckProbe(k: Pick<KeptCheck, 'keptCheckId' | 'probe'>): Probe {
    return { id: `${KEPT_CHECK_PROBE_PREFIX}${k.keptCheckId}`, spec: k.probe.spec, origin: 'agent', purpose: k.probe.purpose, expected: k.probe.expected, compare: k.probe.compare };
}

/** One Run's outcome of one kept check: in the projection, the report and the results table. Ids and codes only. */
export const KeptCheckOutcomeSchema = z.strictObject({
    keptCheckId: z.uuid(),
    outcome: z.enum(KEPT_CHECK_OUTCOMES),
    staleReason: z.enum(KEPT_CHECK_STALE_REASONS).optional(),
    /** The probe id it played under (`kept:<id>`), absent when it was not played. */
    probeId: z.string().min(1).max(128).optional(),
});
export type KeptCheckOutcome = z.infer<typeof KeptCheckOutcomeSchema>;

/** Outcomes that are not "no regression": a Run that would be green is partly tested (docs/runtime/kept-checks.md §6). */
export const isKeptCheckNotRun = (o: Pick<KeptCheckOutcome, 'outcome'>) => o.outcome === 'stale' || o.outcome === 'skipped' || o.outcome === 'inconclusive';
