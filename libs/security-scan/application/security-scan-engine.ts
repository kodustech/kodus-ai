/**
 * The security scan itself, with no database: map the repository, audit each
 * unit with one lens per vulnerability class on the code-review harness (the
 * same finder, tools and verify a review runs), and turn what survives verify
 * into findings. The job processor persists what this returns; the eval runs
 * this same engine and scores its findings, so both see one code path.
 */
import { z } from 'zod';

import { LLM } from '@libs/llm/llm';
import { redactSecrets } from '@libs/llm/review-error-diagnostics';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { runWithUsageMeter } from '@libs/llm/usage-meter';
import { cweFamily, cweId } from '@libs/issues/domain/scan-fingerprint';
import { runAgentLoopViaCore } from '@libs/code-review/infrastructure/agents/core/core-agent-loop.adapter';
import type {
    AgentLoopInput,
    AgentLoopOutput,
    AgentLoopSecrets,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';
import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';
import { createLogger } from '@libs/core/log/logger';
import {
    createFindingDedupDeps,
    deduplicateFindings,
} from '@libs/code-review/infrastructure/agents/engine/finding-dedup';

import type { ScanBudgetMeter } from '../domain/budget-meter';
import { enclosingSymbol } from '../domain/enclosing-symbol';
import {
    DEFAULT_CWE,
    FINALIZE_SYSTEM_PROMPT,
    MAP_SYSTEM_PROMPT,
    REPRO_SYSTEM_PROMPT,
    buildFinalizeUserPrompt,
    buildLensFocus,
    buildLensSystemPrompt,
    buildLensUserPrompt,
    buildMapUserPrompt,
    buildReproUserPrompt,
} from '../domain/scan-prompts';
import {
    heuristicUnits,
    mergeMapPlan,
    rankCandidates,
    withRevisits,
} from '../domain/scan-units';
import { admitFindingPath } from '../domain/finding-path';
import {
    SCAN_CHECKOUT_TAMPERED_MESSAGE,
    SCAN_CHECKOUT_UNVERIFIED_MESSAGE,
    SCAN_MAP_FAILED_MESSAGE,
    ScanFailure,
} from '../domain/scan-failure';
import type {
    ScanExaminedClass,
    ScanFinding,
    ScanReportedFinding,
    ScanUnit,
    ScanUnitProgress,
} from '../domain/security-scan.types';
import type {
    GrepFn,
    SurfaceHit,
    SurfaceMap,
    VulnClass,
} from '../domain/surface/surface.types';
import {
    collectSurface,
    detectLanguages,
} from '../domain/surface/collect-surface';

const logger = createLogger('SecurityScanEngine');

export const SCAN_RUN_NAME = 'security-scan';
const LENS_MAX_STEPS = 30;
/**
 * How many times each lens reads a unit. A second reading, told what the
 * first reported, finds more in a file with many bugs (RealVuln dev slice:
 * F3 50.0 -> 55.3) at twice the lens cost; one until that cost is decided.
 */
const LENS_PASSES = 1;
/**
 * Units audited at once. Each holds one lens loop, so this is also how many
 * model requests can be in flight; the budget reserve scales with it.
 */
export const UNIT_CONCURRENCY = 4;
const MAP_LISTING_SAMPLE = 600;

export interface SecurityScanModel {
    slot?: NormalizedModel;
    modelName: string;
    contextWindowTokens?: number;
    reasoningEffort?: AgentLoopInput['reasoningEffort'];
    reasoningConfigOverride?: string;
    byokProvider?: string;
    openrouterProviderOrder?: string[];
    openrouterAllowFallbacks?: boolean;
}

export interface SecurityScanEngineDeps {
    runLens?: (
        input: AgentLoopInput,
        secrets: AgentLoopSecrets,
    ) => Promise<AgentLoopOutput>;
    llm?: typeof LLM.run;
    collectSurface?: typeof collectSurface;
    /** The review's own dedup (finding-dedup.ts), run on each unit's findings. */
    dedup?: typeof deduplicateFindings;
    now?: () => number;
}

export interface SecurityScanEngineParams {
    organizationId: string;
    teamId?: string;
    repositoryId: string;
    repositoryFullName: string;
    sandbox: SandboxInstance;
    model: SecurityScanModel;
    meter: ScanBudgetMeter;
    /** The job's signal; aborting it stops the scan at once. */
    signal?: AbortSignal;
    /** Stop starting new units after this time (epoch ms); the rest resumes later. */
    deadlineAt?: number;
    maxUnits: number;
    /** A plan from an earlier run of the same scan: skip mapping. */
    units?: ScanUnit[];
    progress?: ScanUnitProgress[];
    /** What earlier runs of the same scan reported: not reported again. */
    reported?: ScanReportedFinding[];
    /**
     * The repository's open findings of earlier scans. A fresh finding of
     * the same bug is sighted as the one stored, never stored beside it:
     * which of two places the dedup keeps follows the order units run in,
     * and a new identity would open a second issue and resolve the first.
     */
    known?: ScanReportedFinding[];
    /**
     * Where the repository's open findings of earlier scans sit: read again
     * whatever the pattern scan draws, so a fix can resolve them.
     */
    revisit?: Array<{ filePath: string; vulnerabilityClass: string }>;
    /** Write and run a reproduction test for each finding (needs E2B). */
    reproduce: boolean;
    onPlanned?: (units: ScanUnit[], languages: string[]) => Promise<void>;
    onUnitDone?: (
        progress: ScanUnitProgress,
        findings: ScanFinding[],
        /**
         * Stored findings a fresh one was dropped as a duplicate of: found
         * again, so seen by this scan (once each, by fingerprint).
         */
        sighted?: ScanReportedFinding[],
    ) => Promise<void>;
}

export interface SecurityScanEngineResult {
    units: ScanUnit[];
    progress: ScanUnitProgress[];
    findings: ScanFinding[];
    languages: string[];
    /** Every unit is done or failed; nothing is left for a later run. */
    finished: boolean;
    stoppedByBudget: boolean;
    examinedFiles: string[];
    /** Per class, the files a lens of that class read to the end. */
    examinedByClass: ScanExaminedClass[];
    /**
     * Every file the scanned commit tracks, when the whole list was read; a
     * finding in a file outside it is gone with the file.
     */
    trackedFiles?: string[];
    /**
     * Set by the run that made the plan. Languages a pattern search failed
     * for: their files may be missing from the plan.
     */
    mapFailedLanguages?: string[];
    /** Candidate files the plan's limit left out: this scan never reads them. */
    filesBeyondPlan?: number;
}

const MAP_SCHEMA = z.object({
    units: z.array(
        z.object({
            file: z.string(),
            relatedFiles: z.array(z.string()),
            classes: z.array(z.string()),
            priority: z.number(),
            reason: z.string(),
        }),
    ),
});

const FINALIZE_SCHEMA = z.object({
    title: z.string(),
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    cwe: z.string(),
    attackPath: z.array(
        z.object({ file: z.string(), line: z.number(), note: z.string() }),
    ),
    fix: z.string(),
    appWide: z.boolean(),
});

const REPRO_SCHEMA = z.object({
    path: z.string(),
    content: z.string(),
    command: z.string(),
});

/** A finding whose identity (its CWE, its function) could not be read. */
const UNIDENTIFIED = Symbol('unidentified finding');

export class SecurityScanEngine {
    private readonly runLens: NonNullable<SecurityScanEngineDeps['runLens']>;
    private readonly llm: typeof LLM.run;
    private readonly collect: typeof collectSurface;
    private readonly dedup: typeof deduplicateFindings;
    private readonly now: () => number;

    constructor(deps: SecurityScanEngineDeps = {}) {
        this.runLens = deps.runLens ?? runAgentLoopViaCore;
        this.llm = deps.llm ?? LLM.run.bind(LLM);
        this.collect = deps.collectSurface ?? collectSurface;
        this.dedup = deps.dedup ?? deduplicateFindings;
        this.now = deps.now ?? Date.now;
    }

    async run(
        params: SecurityScanEngineParams,
    ): Promise<SecurityScanEngineResult> {
        // Every model request below is metered; reaching the cap aborts the
        // lens that is running and no new one starts.
        const budgetAbort = new AbortController();
        params.meter.onExhausted(() => budgetAbort.abort(new Error('budget')));
        // A unit that could not be stored fails the scan: the lenses still
        // running stop too, instead of spending on work nothing will keep.
        const failureAbort = new AbortController();
        const signal = anySignal([
            params.signal,
            budgetAbort.signal,
            failureAbort.signal,
        ]);

        return runWithUsageMeter(
            params.meter,
            () =>
                this.runMetered(params, signal, budgetAbort.signal, () =>
                    failureAbort.abort(new Error('a unit could not be stored')),
                ),
            {
                organizationId: params.organizationId,
                teamId: params.teamId,
                repositoryId: params.repositoryId,
            },
        );
    }

    private async runMetered(
        params: SecurityScanEngineParams,
        signal: AbortSignal,
        budgetSignal: AbortSignal,
        abortAll: () => void,
    ): Promise<SecurityScanEngineResult> {
        const { files: listing, complete } = await this.listFiles(
            params.sandbox,
        );
        const existingFiles = new Set(listing);
        const languages = detectLanguages(listing);

        // Collected on every run, a continuation too: the lenses read its
        // hits as leads, and a resumed plan would audit without them.
        const surface = await this.collect(
            params.sandbox.remoteCommands.grep as GrepFn,
            { languages },
        );
        // Every search that ran failed: an empty map is a broken sandbox, not
        // a clean repository, and a scan of nothing must not end "completed".
        const searchFailures = surface.errors.filter(
            (e) => !e.message.startsWith('truncated'),
        );
        if (searchFailures.length && !surface.hits.length) {
            logger.error({
                message: 'Security scan could not map the repository',
                context: SecurityScanEngine.name,
                metadata: {
                    organizationId: params.organizationId,
                    teamId: params.teamId,
                    repositoryId: params.repositoryId,
                    failures: searchFailures.length,
                    languages: searchFailures.map((e) => e.language),
                },
            });
            throw new ScanFailure(SCAN_MAP_FAILED_MESSAGE);
        }
        const hitsByFile = new Map<string, SurfaceHit[]>();
        for (const hit of surface.hits) {
            const list = hitsByFile.get(hit.file);
            if (list) list.push(hit);
            else hitsByFile.set(hit.file, [hit]);
        }

        let units = params.units;
        let planGaps:
            | { mapFailedLanguages: string[]; filesBeyondPlan: number }
            | undefined;
        if (!units?.length) {
            // A search that failed beside others that worked leaves a map
            // with holes: the scan runs on what it has and says which.
            planGaps = {
                mapFailedLanguages: [
                    ...new Set(searchFailures.map((e) => e.language)),
                ],
                // Counted once the plan is made, below.
                filesBeyondPlan: 0,
            };
            if (planGaps.mapFailedLanguages.length) {
                logger.warn({
                    message:
                        'Security scan mapped the repository with failed searches',
                    context: SecurityScanEngine.name,
                    metadata: {
                        organizationId: params.organizationId,
                        teamId: params.teamId,
                        repositoryId: params.repositoryId,
                        languages: planGaps.mapFailedLanguages,
                    },
                });
            }
            units = withRevisits(
                await this.plan(
                    params,
                    surface,
                    listing,
                    existingFiles,
                    languages,
                ),
                params.revisit ?? [],
                existingFiles,
            );
            // Candidates the plan does not hold: past its limit, or crowded
            // out by files the planner added. Only files a lens would read
            // count; an auth check alone is no candidate.
            const planned = new Set(units.map((u) => u.file));
            planGaps.filesBeyondPlan = rankCandidates(surface).filter(
                (c) => !planned.has(c.file),
            ).length;
            await params.onPlanned?.(units, languages);
        }

        const progress = new Map<string, ScanUnitProgress>(
            (params.progress ?? []).map((p) => [p.unitId, p]),
        );
        if (params.units?.length && params.revisit?.length) {
            // A plan carried on from an earlier scan: findings opened since
            // it was made are read again too. An area it finished stays
            // finished; the classes it lacks run in an area of their own.
            const finished = new Set(
                [...progress.values()]
                    .filter((p) => p.state === 'done')
                    .map((p) => p.unitId),
            );
            const before = units;
            units = withRevisits(
                units,
                params.revisit,
                existingFiles,
                finished,
            );
            const changed =
                units.length !== before.length ||
                units.some(
                    (u, i) => u.classes.length !== before[i].classes.length,
                );
            if (changed) {
                await params.onPlanned?.(units, languages);
            }
        }
        // The open findings of earlier scans not already this scan's.
        const ours = new Set(
            (params.reported ?? []).map((r) => r.fingerprint).filter(Boolean),
        );
        const known = (params.known ?? []).filter(
            (k) => k.fingerprint && !ours.has(k.fingerprint),
        );
        this.known = new Set(known);
        const findings: ScanFinding[] = [];
        const examined = new Set<string>();
        const examinedByClass = new Map<VulnClass, Set<string>>();
        let stoppedByBudget = false;
        let stopped = false;

        const queue = units.filter((unit) => {
            const state = progress.get(unit.id)?.state;
            return state !== 'done' && state !== 'failed';
        });
        const mayStart = (): boolean => {
            if (stopped) return false;
            if (signal.aborted && !budgetSignal.aborted) {
                stopped = true;
            } else if (budgetSignal.aborted || params.meter.isExhausted()) {
                stoppedByBudget = true;
                stopped = true;
            } else if (params.deadlineAt && this.now() >= params.deadlineAt) {
                stopped = true;
            }
            return !stopped;
        };
        const reproduceOneAtATime = serially();
        // Units are audited at once but folded in one at a time, in the order
        // they started (the plan's priority): the dedup compares a unit with
        // everything folded before it, so two units cannot both report one
        // bug, and of two reports of one bug the higher-priority unit's stays.
        let folded: Promise<void> = Promise.resolve();

        const fold = async (unit: ScanUnit, result: AuditResult) => {
            if (result.aborted) {
                // What the unit found before it stopped is kept, but
                // the unit is not counted as examined: its files were
                // only partly read, so nothing there may be resolved
                // as gone.
                stopped = true;
                // Compared with what was folded before it, as a finished
                // unit is (the model's dedup needs a request the stop may no
                // longer allow): a bug another unit reported is sighted, not
                // stored twice.
                const reportedSoFar = [
                    ...known,
                    ...(params.reported ?? []),
                    ...findings,
                ];
                result.sighted = [...(result.sighted ?? [])];
                result.findings = result.findings.filter((f) => {
                    const repeats = duplicatesOf(reportedSoFar, f);
                    if (this.refreshes(f, repeats)) return true;
                    result.sighted!.push(...repeats);
                    return !repeats.length;
                });
                findings.push(...result.findings);
                if (budgetSignal.aborted || params.meter.isExhausted()) {
                    stoppedByBudget = true;
                    progress.set(unit.id, {
                        unitId: unit.id,
                        state: 'skipped_budget',
                        findings: result.findings.length,
                    });
                    await params.onUnitDone?.(
                        progress.get(unit.id),
                        result.findings,
                        withFingerprint(result.sighted),
                    );
                } else {
                    // The slice ended mid-unit: the unit runs again in the
                    // next one, from the lenses it has not run yet. Its
                    // findings so far are stored now so none is lost.
                    const pending: ScanUnitProgress = {
                        unitId: unit.id,
                        state: 'pending',
                        findings: 0,
                        lensesRun: result.lensesRun,
                        lensesExamined: result.lensesExamined,
                    };
                    progress.set(unit.id, pending);
                    if (result.findings.length || result.sighted?.length) {
                        await params.onUnitDone?.(
                            pending,
                            result.findings,
                            withFingerprint(result.sighted),
                        );
                    }
                }
                return;
            }

            // The unit ran beside units folded in after it started: what they
            // reported was not in its view yet. Past the cap the meter refuses
            // the dedup's request, and every finding is kept.
            const reported = [
                ...known,
                ...(params.reported ?? []),
                ...findings,
            ];
            // Earlier findings a fresh one turns out to repeat: found again.
            const sighted = [...(result.sighted ?? [])];
            const fresh = result.findings.filter((f) => {
                const repeats = duplicatesOf(reported, f);
                if (this.refreshes(f, repeats)) return true;
                sighted.push(...repeats);
                return !repeats.length;
            });
            result.findings = await this.withoutDuplicates(
                params,
                fresh,
                nearby(reported, unit, result.findings),
                sighted,
            );

            const unitProgress: ScanUnitProgress = {
                unitId: unit.id,
                state: result.error ? 'failed' : 'done',
                findings: result.findings.length,
                ...(result.error ? { error: result.error } : {}),
            };
            progress.set(unit.id, unitProgress);
            // A class counts as examined only where its lens ran to the end,
            // and only in the unit's own file: a related file was followed
            // for this unit's flow, never audited whole, and its findings are
            // resolved only by its own unit.
            for (const vulnClass of result.examinedClasses ?? []) {
                const files = examinedByClass.get(vulnClass) ?? new Set();
                files.add(unit.file);
                examinedByClass.set(vulnClass, files);
                // Shown as read; never used to resolve a finding.
                [unit.file, ...unit.relatedFiles].forEach((f) =>
                    examined.add(f),
                );
            }
            findings.push(...result.findings);
            await params.onUnitDone?.(
                unitProgress,
                result.findings,
                withFingerprint(sighted),
            );
        };

        const worker = async () => {
            while (queue.length && mayStart()) {
                const unit = queue.shift()!;
                const unitHits = [unit.file, ...unit.relatedFiles].flatMap(
                    (file) => hitsByFile.get(file) ?? [],
                );
                const audit = this.auditUnit(
                    params,
                    unit,
                    unitHits,
                    existingFiles,
                    signal,
                    [...known, ...(params.reported ?? []), ...findings],
                    reproduceOneAtATime,
                    progress.get(unit.id),
                ).catch((error) => {
                    // A unit that throws (a checkout a reproduction changed
                    // and could not be put back) stops every unit: none may
                    // go on reading what it would read.
                    stopped = true;
                    abortAll();
                    throw error;
                });
                const turn = folded;
                folded = audit.then(async (result) => {
                    await turn;
                    try {
                        await fold(unit, result);
                    } catch (error) {
                        // A unit that could not be stored fails the scan: no
                        // new unit starts, the ones running stop, and nothing
                        // is resolved.
                        stopped = true;
                        abortAll();
                        throw error;
                    }
                });
                // The next unit's fold awaits this one only once its own
                // audit ends; until then a failure here has no handler. The
                // error still reaches the run through the last fold.
                folded.catch(() => undefined);
                // The worker takes its next unit once this one's audit ends,
                // without waiting for earlier units to be folded in.
                await audit;
            }
        };
        await Promise.all(Array.from({ length: UNIT_CONCURRENCY }, worker));
        await folded;

        if (stoppedByBudget) {
            for (const unit of units) {
                if (!progress.has(unit.id)) {
                    progress.set(unit.id, {
                        unitId: unit.id,
                        state: 'skipped_budget',
                        findings: 0,
                    });
                }
            }
        }

        const progressList = units.map(
            (u) =>
                progress.get(u.id) ?? {
                    unitId: u.id,
                    state: 'pending' as const,
                    findings: 0,
                },
        );
        const finished = progressList.every(
            (p) => p.state === 'done' || p.state === 'failed',
        );

        return {
            units,
            progress: progressList,
            findings,
            languages,
            finished,
            stoppedByBudget,
            ...planGaps,
            examinedFiles: [...examined],
            examinedByClass: [...examinedByClass].map(
                ([vulnerabilityClass, files]) => ({
                    vulnerabilityClass,
                    filePaths: [...files],
                }),
            ),
            ...(complete ? { trackedFiles: listing } : {}),
        };
    }

    /**
     * The same bug reached from two entry points (the route, the controller
     * and the DAO of one missing check) is one finding. The review's dedup
     * decides it, comparing the unit's findings with everything the scan
     * already reported; a unit finding it folds into another is dropped. A
     * dedup failure keeps every finding: a duplicate costs less than a miss.
     */
    /** This run's open issues of earlier scans (SecurityScanEngineParams.known). */
    private known: ReadonlySet<ScanReportedFinding> = new Set();

    /**
     * A fresh finding that repeats only open issues of earlier scans is
     * stored as the first of them (`storedAs`): the issue keeps its identity
     * and takes this scan's commit, lines, evidence and owner, and the
     * sighting is on record as this scan's finding. One that repeats
     * anything of this scan's own is a duplicate as before.
     */
    private refreshes(
        finding: ScanFinding,
        repeats: ScanReportedFinding[],
    ): boolean {
        const [first] = repeats;
        if (!first?.fingerprint || !repeats.every((r) => this.known.has(r))) {
            return false;
        }
        finding.storedAs = first.fingerprint;
        return true;
    }

    private async withoutDuplicates(
        params: SecurityScanEngineParams,
        fresh: ScanFinding[],
        earlier: ScanReportedFinding[],
        /** Receives the earlier findings a dropped fresh one repeated. */
        sighted: ScanReportedFinding[] = [],
    ): Promise<ScanFinding[]> {
        if (!fresh.length || fresh.length + earlier.length < 2) {
            return fresh;
        }
        const all = [...earlier, ...fresh];
        const asSuggestion = (f: ScanReportedFinding, i: number) => ({
            id: `scan-${i}`,
            relevantFile: f.filePath,
            relevantLinesStart: f.startLine,
            relevantLinesEnd: f.endLine,
            label: 'security',
            severity: f.severity,
            oneSentenceSummary: f.title,
            suggestionContent: f.description,
        });
        try {
            const { suggestions, trace } = await this.dedup(
                // Findings go to the client's own model alone (#2451): never
                // embedded on the platform key, the BYOK tiebreak decides.
                (this.dedupDeps ??= createFindingDedupDeps({
                    logger,
                    context: SecurityScanEngine.name,
                    platformEmbeddings: false,
                })),
                all.map(asSuggestion) as any,
                0,
                params.model.slot,
                { organizationId: params.organizationId } as any,
            );
            const kept = new Set(suggestions.map((s) => s.id));
            // An earlier finding is already stored: when the dedup kept a
            // fresh one in its place, the fresh one is the duplicate, so the
            // bug keeps the one identity it has.
            const indicesOf = new Map<string, number[]>();
            all.forEach((f, i) => {
                const key = dedupKey(asSuggestion(f, i));
                indicesOf.set(key, [...(indicesOf.get(key) ?? []), i]);
            });
            for (const group of trace?.groups ?? []) {
                const replacesEarlier = group.duplicates.some((d) =>
                    (indicesOf.get(dedupKey(d)) ?? []).some(
                        (i) => i < earlier.length,
                    ),
                );
                if (replacesEarlier) {
                    for (const i of indicesOf.get(dedupKey(group.keep)) ?? []) {
                        if (i >= earlier.length) kept.delete(`scan-${i}`);
                    }
                }
            }
            // An earlier finding grouped with a fresh one dropped here was
            // found again.
            const named = new Set<number>();
            for (const group of trace?.groups ?? []) {
                const members = [group.keep, ...group.duplicates].flatMap(
                    (m) => indicesOf.get(dedupKey(m)) ?? [],
                );
                members.forEach((i) => named.add(i));
                const droppedFresh = members.filter(
                    (i) => i >= earlier.length && !kept.has(`scan-${i}`),
                );
                const earlierMembers = members.filter(
                    (i) => i < earlier.length,
                );
                const keptFresh = members.some(
                    (i) => i >= earlier.length && kept.has(`scan-${i}`),
                );
                // Grouped only with open issues of earlier scans: the fresh
                // one is stored as the first, which keeps its identity and
                // takes this scan's data.
                if (
                    droppedFresh.length &&
                    !keptFresh &&
                    this.refreshes(
                        fresh[droppedFresh[0] - earlier.length],
                        earlierMembers.map((i) => earlier[i]),
                    )
                ) {
                    kept.add(`scan-${droppedFresh[0]}`);
                } else if (droppedFresh.length) {
                    for (const i of earlierMembers) sighted.push(earlier[i]);
                }
            }
            // A merge the trace does not name (a keep the model repeated
            // across groups): the kept finding lists where the absorbed one
            // was. Read from there; without it, a dropped fresh finding is
            // kept, a duplicate costing less than a miss.
            const locationOf = (i: number) => {
                const s = asSuggestion(all[i], i);
                return `${s.relevantFile}:${s.relevantLinesStart}-${s.relevantLinesEnd}`;
            };
            // Each listed location, to the kept finding that lists it.
            const holderAt = new Map<string, number>();
            for (const s of suggestions as Array<{
                id?: string;
                alsoFoundIn?: string[];
            }>) {
                const at = Number(s.id?.replace(/^scan-/, ''));
                if (!Number.isInteger(at)) continue;
                for (const location of s.alsoFoundIn ?? []) {
                    if (!holderAt.has(location)) holderAt.set(location, at);
                }
            }
            const holderOf = (i: number) => holderAt.get(locationOf(i));
            for (let i = 0; i < all.length; i++) {
                if (named.has(i) || kept.has(`scan-${i}`)) continue;
                const holder = holderOf(i);
                if (i >= earlier.length) {
                    if (holder === undefined) {
                        kept.add(`scan-${i}`);
                    } else if (holder < earlier.length) {
                        if (
                            this.refreshes(fresh[i - earlier.length], [
                                earlier[holder],
                            ])
                        ) {
                            kept.add(`scan-${i}`);
                        } else {
                            sighted.push(earlier[holder]);
                        }
                    }
                } else if (holder !== undefined && holder >= earlier.length) {
                    // An earlier finding absorbed into a fresh one: the bug
                    // keeps the identity it has.
                    if (
                        !this.refreshes(fresh[holder - earlier.length], [
                            earlier[i],
                        ])
                    ) {
                        kept.delete(`scan-${holder}`);
                        sighted.push(earlier[i]);
                    }
                }
            }
            return fresh.filter((_, i) =>
                kept.has(`scan-${earlier.length + i}`),
            );
        } catch (error) {
            logger.warn({
                message: 'Security scan dedup failed; keeping every finding',
                context: SecurityScanEngine.name,
                error,
                metadata: {
                    organizationId: params.organizationId,
                    teamId: params.teamId,
                    repositoryId: params.repositoryId,
                },
            });
            return fresh;
        }
    }

    private dedupDeps: ReturnType<typeof createFindingDedupDeps> | undefined;

    /**
     * Every file, never cut: a finding is kept only when its file is listed,
     * so a cut would drop real findings in the files past it, mark them
     * examined, and let the scan resolve their issues. `complete`: git listed
     * the tracked files.
     */
    private async listFiles(
        sandbox: SandboxInstance,
    ): Promise<{ files: string[]; complete: boolean }> {
        // NUL-separated: a plain listing quotes and escapes any path with
        // a non-ASCII byte (core.quotePath), and `src/ação.ts` would then
        // match no file a finding names.
        const fromGit = await sandbox
            .run(`git -C ${sandbox.repoDir} ls-files -z`, { timeoutMs: 60_000 })
            .catch(() => undefined);
        const tracked = fromGit?.exitCode === 0 && !!fromGit.stdout;
        const files = (
            tracked
                ? fromGit.stdout.split('\0')
                : (await sandbox.remoteCommands.listDir('.', 25))
                      .split('\n')
                      .map((l) => l.trim())
        )
            .map((l) => l.replace(/^\.\//, ''))
            .filter((l) => l && !l.startsWith('Error:'));
        return { files, complete: tracked };
    }

    private async plan(
        params: SecurityScanEngineParams,
        surface: SurfaceMap,
        listing: string[],
        existingFiles: Set<string>,
        languages: string[],
    ): Promise<ScanUnit[]> {
        // As many candidates as the plan may hold: a cut below it would drop
        // files from the plan, and from every scan run after it.
        const candidates = rankCandidates(surface, params.maxUnits);
        if (Object.keys(surface.files).length > params.maxUnits) {
            logger.warn({
                message: `Security scan plan holds ${params.maxUnits} of the repository's candidate files`,
                context: SecurityScanEngine.name,
                metadata: {
                    organizationId: params.organizationId,
                    teamId: params.teamId,
                    repositoryId: params.repositoryId,
                    candidates: Object.keys(surface.files).length,
                },
            });
        }
        if (!candidates.length) {
            return [];
        }

        try {
            const plan = await this.llm({
                byokConfig: params.model.slot,
                schema: MAP_SCHEMA,
                system: MAP_SYSTEM_PROMPT,
                user: buildMapUserPrompt({
                    repositoryFullName: params.repositoryFullName,
                    languages,
                    candidates: candidates.slice(0, 150),
                    listing: sampleListing(listing, MAP_LISTING_SAMPLE),
                    maxUnits: params.maxUnits,
                }),
                runName: `${SCAN_RUN_NAME}-map`,
                organizationId: params.organizationId,
            });
            return mergeMapPlan({
                plan: plan?.units ?? [],
                candidates,
                existingFiles,
                maxUnits: params.maxUnits,
            });
        } catch (error) {
            // The map is a ranking aid; without it the scan still runs on the
            // pattern scan's own order.
            logger.warn({
                message:
                    'Security scan planner failed; using the pattern ranking',
                context: SecurityScanEngine.name,
                error,
                metadata: {
                    organizationId: params.organizationId,
                    teamId: params.teamId,
                    repositoryId: params.repositoryId,
                },
            });
            return heuristicUnits(candidates, params.maxUnits);
        }
    }

    private async auditUnit(
        params: SecurityScanEngineParams,
        unit: ScanUnit,
        hits: SurfaceHit[],
        files: ReadonlySet<string>,
        signal: AbortSignal,
        /** What earlier units of this scan already reported. */
        earlier: ScanReportedFinding[] = [],
        /** Units share one sandbox: reproduction tests run one at a time. */
        oneAtATime: Serial = serially(),
        /** Where an earlier slice left this unit, if it did. */
        resume?: ScanUnitProgress,
    ): Promise<AuditResult> {
        const findings: ScanFinding[] = [];
        let failures = 0;
        // Classes a lens did not read to the end: failed, or stopped short.
        const unfinished = new Set<VulnClass>();
        // Classes whose lens ended, in this slice or an earlier one.
        const ran = new Set<VulnClass>(resume?.lensesRun ?? []);
        const examinedBefore = resume?.lensesExamined ?? [];
        // Earlier findings one of this unit's repeated.
        const sighted: ScanReportedFinding[] = [];
        const progressSoFar = () => ({
            sighted,
            lensesRun: [...ran],
            lensesExamined: [
                ...new Set([
                    ...examinedBefore,
                    ...[...ran].filter(
                        (c) =>
                            !unfinished.has(c) &&
                            !resume?.lensesRun?.includes(c),
                    ),
                ]),
            ],
        });

        const runs = unit.classes
            .filter((vulnClass) => !ran.has(vulnClass))
            .flatMap((vulnClass) =>
                Array.from({ length: LENS_PASSES }, (_, pass) => ({
                    vulnClass,
                    pass,
                })),
            );
        for (const { vulnClass, pass } of runs) {
            // Past the slice's deadline a lens could run into the job's hard
            // cut, which fails the scan: stop here, and the unit resumes in
            // the next slice from the lenses it has not run.
            if (
                signal.aborted ||
                (params.deadlineAt && this.now() >= params.deadlineAt)
            ) {
                return { findings, aborted: true, ...progressSoFar() };
            }
            try {
                const input = this.lensInput(
                    params,
                    unit,
                    vulnClass,
                    hits,
                    signal,
                );
                const already = findings.filter(
                    (f) => f.vulnerabilityClass === vulnClass,
                );
                if (pass > 0 && already.length) {
                    input.userPrompt += `\n\nAlready reported in these files by an earlier reading (do not report these again; look for the others):\n${already
                        .map((f) => `- ${f.filePath}:${f.startLine} ${f.title}`)
                        .join('\n')}`;
                }
                const output = await this.runLens(input, {
                    remoteCommands: params.sandbox.remoteCommands,
                    byokConfig: params.model.slot,
                });
                if (signal.aborted) {
                    return { findings, aborted: true, ...progressSoFar() };
                }
                // The harness reports a provider error or a run out of steps
                // in the result, not by throwing. What such a lens found is
                // kept; its class was not looked at to the end.
                if (output.finishReason === 'error') {
                    failures++;
                    unfinished.add(vulnClass);
                    logger.warn({
                        message: `Security lens ${vulnClass} ended in an error on ${unit.file}`,
                        context: SecurityScanEngine.name,
                        metadata: {
                            organizationId: params.organizationId,
                            teamId: params.teamId,
                            repositoryId: params.repositoryId,
                            unit: unit.id,
                            errorName: output.errorName,
                        },
                    });
                } else if (
                    output.finishReason !== 'completed' ||
                    output.incompleteReason ||
                    output.submittedResult === false ||
                    // The verifier failed on some of them: neither confirmed
                    // nor refuted, so the class was not looked at to the end.
                    output.unverifiedByVerify?.length
                ) {
                    unfinished.add(vulnClass);
                }
                const kept = (output.findings?.suggestions ?? []) as any[];
                for (const suggestion of kept) {
                    // The cap aborts the lens, not the finalize calls after
                    // it: each one is a request.
                    if (signal.aborted) {
                        return { findings, aborted: true, ...progressSoFar() };
                    }
                    const path = admitFindingPath(
                        suggestion.relevantFile,
                        files,
                    );
                    if ('rejected' in path) {
                        logger.log({
                            message: `Security finding dropped: ${path.rejected === 'missing' ? 'names no file in the repository' : 'is in a test, fixture or vendored file'}`,
                            context: SecurityScanEngine.name,
                            metadata: {
                                organizationId: params.organizationId,
                                teamId: params.teamId,
                                repositoryId: params.repositoryId,
                                unit: unit.id,
                                vulnClass,
                                relevantFile: suggestion.relevantFile,
                            },
                        });
                        continue;
                    }
                    const finding = await this.finalize(
                        params,
                        unit,
                        vulnClass,
                        { ...suggestion, relevantFile: path.file },
                        files,
                    );
                    // Its CWE or its function could not be read, and both
                    // are its identity: stored now, it would open a second
                    // issue beside the one it is, and the class counted as
                    // read would resolve that one as gone. The class was
                    // not read to the end; it runs again.
                    if (finding === UNIDENTIFIED) {
                        unfinished.add(vulnClass);
                        continue;
                    }
                    const repeats = finding
                        ? duplicatesOf(earlier, finding)
                        : [];
                    const refreshing =
                        !!finding && this.refreshes(finding, repeats);
                    if (!refreshing) {
                        sighted.push(...repeats);
                    }
                    if (
                        finding &&
                        (refreshing || !repeats.length) &&
                        !isDuplicate(findings, finding)
                    ) {
                        findings.push(finding);
                    }
                }
            } catch (error) {
                if (signal.aborted) {
                    return { findings, aborted: true, ...progressSoFar() };
                }
                failures++;
                unfinished.add(vulnClass);
                logger.warn({
                    message: `Security lens ${vulnClass} failed on ${unit.file}`,
                    context: SecurityScanEngine.name,
                    error,
                    metadata: {
                        organizationId: params.organizationId,
                        teamId: params.teamId,
                        repositoryId: params.repositoryId,
                        unit: unit.id,
                    },
                });
            }
            if (pass === LENS_PASSES - 1) {
                ran.add(vulnClass);
            }
        }

        if (params.reproduce) {
            // Past the slice's deadline a test install could outlive the
            // sandbox: the finding ships with its attack path, no test.
            // Checked again once its turn comes: other units' tests may have
            // held the sandbox until past the deadline.
            const pastDeadline = () =>
                signal.aborted ||
                (!!params.deadlineAt && this.now() >= params.deadlineAt);
            for (const finding of findings) {
                if (pastDeadline()) {
                    break;
                }
                await oneAtATime(async () => {
                    if (!pastDeadline()) {
                        await this.reproduce(params, finding);
                    }
                });
            }
        }

        // Not one class read to the end (lenses failed, ran out of steps or
        // could not verify): the unit failed, so it runs again rather than
        // passing for a clean area.
        // A class no lens read to the end (failed, cut short, unverified)
        // fails the unit: it is shown and runs again, while the classes that
        // were read still count as examined.
        const { lensesExamined: examinedClasses } = progressSoFar();
        const examinedSet = new Set(examinedClasses);
        const missing = unit.classes.filter((c) => !examinedSet.has(c));
        if (missing.length) {
            return {
                findings,
                error: examinedClasses.length
                    ? `not read to the end: ${missing.join(', ')}`
                    : runs.length > 0 && failures === runs.length
                      ? 'every lens failed'
                      : 'no lens read the area to the end',
                examinedClasses,
                sighted,
            };
        }
        return { findings, examinedClasses, sighted };
    }

    private lensInput(
        params: SecurityScanEngineParams,
        unit: ScanUnit,
        vulnClass: VulnClass,
        hits: SurfaceHit[],
        signal: AbortSignal,
    ): AgentLoopInput {
        const m = params.model;
        return {
            systemPrompt: buildLensSystemPrompt(vulnClass),
            userPrompt: buildLensUserPrompt({
                repositoryFullName: params.repositoryFullName,
                unit,
                vulnClass,
                hits,
            }),
            agentName: `security-scan-${vulnClass}`,
            usageRunName: `${SCAN_RUN_NAME}-${vulnClass}`,
            telemetryMetadata: {
                organizationId: params.organizationId,
                teamId: params.teamId,
                repositoryId: params.repositoryId,
                provider: m.modelName,
            } as any,
            repositoryFullName: params.repositoryFullName,
            maxSteps: LENS_MAX_STEPS,
            // No diff: the lens follows the data with the tools, and the
            // recovery passes that chase uncovered diff hunks have nothing
            // to chase.
            skipHeavyPasses: true,
            skipSynthesisRescue: true,
            allowedLabels: ['security'],
            laneFocus: buildLensFocus(vulnClass),
            contextWindowTokens: m.contextWindowTokens,
            reasoningEffort: m.reasoningEffort,
            reasoningConfigOverride: m.reasoningConfigOverride,
            byokProvider: m.byokProvider,
            modelName: m.modelName,
            openrouterProviderOrder: m.openrouterProviderOrder,
            openrouterAllowFallbacks: m.openrouterAllowFallbacks,
            parentSignal: signal,
        };
    }

    private async readAround(
        sandbox: SandboxInstance,
        file: string,
        start: number,
        end: number,
        pad = 25,
    ): Promise<{ snippet: string; whole?: string; error?: unknown }> {
        try {
            const whole = await sandbox.remoteCommands.read(file, 0, 0);
            const lines = whole.split('\n');
            const from = Math.max(1, start - pad);
            const to = Math.min(lines.length, end + pad);
            const snippet = lines
                .slice(from - 1, to)
                .map((l, i) => `${from + i}: ${l}`)
                .join('\n');
            return { snippet, whole };
        } catch (error) {
            return { snippet: '', error };
        }
    }

    private async finalize(
        params: SecurityScanEngineParams,
        unit: ScanUnit,
        vulnClass: VulnClass,
        suggestion: {
            relevantFile?: string;
            relevantLinesStart?: number;
            relevantLinesEnd?: number;
            suggestionContent?: string;
            language?: string;
        },
        /** The tracked files, to spell the attack path's steps as they are. */
        files: ReadonlySet<string> = new Set(),
    ): Promise<ScanFinding | typeof UNIDENTIFIED | null> {
        const filePath = (suggestion.relevantFile ?? '').replace(/^\.?\//, '');
        if (!filePath || !suggestion.suggestionContent) {
            return null;
        }
        const startLine = Math.max(1, suggestion.relevantLinesStart ?? 1);
        const endLine = Math.max(
            startLine,
            suggestion.relevantLinesEnd ?? startLine,
        );
        const {
            snippet,
            whole,
            error: unread,
        } = await this.readAround(params.sandbox, filePath, startLine, endLine);
        // Without the file there is no function to name, and the function
        // is half the finding's identity.
        if (whole === undefined) {
            logger.warn({
                message:
                    'Security finding dropped: its file could not be read; its class runs again',
                context: SecurityScanEngine.name,
                error:
                    unread instanceof Error
                        ? unread
                        : new Error(String(unread)),
                metadata: {
                    organizationId: params.organizationId,
                    teamId: params.teamId,
                    repositoryId: params.repositoryId,
                    filePath,
                    unit: unit.id,
                    vulnClass,
                },
            });
            return UNIDENTIFIED;
        }

        let structured: z.infer<typeof FINALIZE_SCHEMA> | undefined;
        try {
            structured = await this.llm({
                byokConfig: params.model.slot,
                schema: FINALIZE_SCHEMA,
                system: FINALIZE_SYSTEM_PROMPT,
                user: buildFinalizeUserPrompt({
                    vulnClass,
                    filePath,
                    startLine,
                    endLine,
                    finding: suggestion.suggestionContent,
                    code: snippet,
                }),
                runName: `${SCAN_RUN_NAME}-finalize`,
                organizationId: params.organizationId,
            });
        } catch (error) {
            logger.warn({
                message:
                    'Security finding could not be structured; its class runs again',
                context: SecurityScanEngine.name,
                error,
                metadata: {
                    organizationId: params.organizationId,
                    teamId: params.teamId,
                    repositoryId: params.repositoryId,
                    filePath,
                    unit: unit.id,
                    vulnClass,
                },
            });
        }
        // Without the structured answer there is no CWE: the finding's
        // identity is unknown.
        if (!structured) {
            return UNIDENTIFIED;
        }

        const firstLine = suggestion.suggestionContent
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l && !/^entry:/i.test(l));

        return {
            unitId: unit.id,
            vulnerabilityClass: vulnClass,
            cwe: normalizeCwe(structured.cwe) ?? DEFAULT_CWE[vulnClass],
            title:
                structured?.title?.trim() ||
                (firstLine ?? 'Security vulnerability').slice(0, 120),
            description: suggestion.suggestionContent.trim(),
            severity: structured?.severity ?? 'high',
            filePath,
            startLine,
            endLine,
            language: unit.language,
            symbol: enclosingSymbol(whole, startLine),
            // Spelled as the listing spells them: the dedup matches a finding
            // against another's steps by file.
            attackPath: (structured?.attackPath ?? [])
                .filter((s) => s?.file && Number.isFinite(s.line))
                .slice(0, 12)
                .map((step) => {
                    const admitted = admitFindingPath(step.file, files);
                    return {
                        ...step,
                        file:
                            'file' in admitted
                                ? admitted.file
                                : step.file
                                      .trim()
                                      .replace(/\\/g, '/')
                                      .replace(/^(?:\.\/)+/, ''),
                    };
                }),
            suggestedFix: structured?.fix,
            appWide: structured?.appWide === true,
        };
    }

    private async reproduce(
        params: SecurityScanEngineParams,
        finding: ScanFinding,
    ): Promise<void> {
        const sandbox = params.sandbox;
        try {
            const { snippet } = await this.readAround(
                sandbox,
                finding.filePath,
                finding.startLine,
                finding.endLine,
                60,
            );
            const repro = await this.llm({
                byokConfig: params.model.slot,
                schema: REPRO_SCHEMA,
                system: REPRO_SYSTEM_PROMPT,
                user: buildReproUserPrompt({
                    language: finding.language,
                    finding: finding.description,
                    filePath: finding.filePath,
                    code: snippet,
                    testHints: await this.testHints(sandbox, finding.language),
                }),
                runName: `${SCAN_RUN_NAME}-repro`,
                organizationId: params.organizationId,
            });
            const path = repro.path.replace(/^\.?\//, '');
            if (!path || path.includes('..') || !repro.command.trim()) {
                return;
            }
            const record: NonNullable<ScanFinding['reproduction']> = {
                path,
                content: repro.content,
                command: repro.command.trim(),
                executed: false,
            };
            finding.reproduction = record;

            if (sandbox.type !== 'e2b') {
                return;
            }
            await this.runReproduction(params, finding.language, record);
        } catch (error) {
            // A checkout that could not be put back stops the scan.
            if (error instanceof ScanFailure) {
                throw error;
            }
            logger.warn({
                message: 'Reproduction test could not be produced',
                context: SecurityScanEngine.name,
                error,
                metadata: {
                    organizationId: params.organizationId,
                    teamId: params.teamId,
                    repositoryId: params.repositoryId,
                    filePath: finding.filePath,
                },
            });
        }
    }

    /**
     * Runs a reproduction test where it cannot touch what the lenses read.
     * The test, its command and the dependency install are model output or
     * repository code: all of it runs as a user of its own (REPRO_USER), in
     * a clone of the scanned commit in that user's home, kept for the job
     * (so dependencies install once) and reset to that commit before each
     * test. That user cannot write the review user's home, whose git config
     * and shell profile every lens command reads (a global gitignore hides
     * files from rg), nor the checkout the lenses read, which only ever has
     * its state checked: anything changed there anyway is put back, and if
     * it cannot be, the scan stops rather than read changed code.
     */
    private async runReproduction(
        params: SecurityScanEngineParams,
        language: string,
        record: NonNullable<ScanFinding['reproduction']>,
    ): Promise<void> {
        const sandbox = params.sandbox;
        const repo = shellQuote(sandbox.repoDir);
        const workdir = REPRO_WORKDIR;
        const work = shellQuote(workdir);
        const target = `${workdir}/${record.path}`;
        const quoted = shellQuote(target);
        const run = (command: string, timeoutMs: number) =>
            asReproUser(sandbox, command, timeoutMs);

        // Without the scanned commit and the checkout's state, nothing could
        // be checked afterwards: no test runs.
        const scanned = await this.headOf(sandbox);
        const before = scanned ? await this.checkoutState(sandbox) : null;
        if (!scanned || !before) {
            return;
        }
        // The checkout the lenses read, and its git metadata, are made
        // read-only to the user the test runs as; without that no test runs.
        if (
            !(await this.lockAuditCheckout(sandbox)) ||
            !(await this.prepareReproUser(sandbox))
        ) {
            return;
        }

        // A clone of its own, sharing the checkout's objects read-only: the
        // command can write its index, files and branches, never the audit's.
        const ready = this.reproClone
            ? await run(
                  `git -C ${work} reset -q --hard ${shellQuote(scanned)} && git -C ${work} clean -fdq -e node_modules -e .venv -e vendor`,
                  60_000,
              )
            : await run(
                  `rm -rf ${work} && git clone -q --shared --no-checkout ${repo} ${work} && git -C ${work} checkout -q --detach ${shellQuote(scanned)}`,
                  120_000,
              );
        if (ready.exitCode !== 0) {
            return;
        }
        this.reproClone = true;

        try {
            await this.ensureDependencies(sandbox, language, workdir);
            // A file (or link) already there is the repository's own: never
            // written over. The test stays on the issue, not run.
            // Free only on test's own "no" (exit 1): a probe that failed or
            // timed out says nothing, and nothing is written over.
            const free = await run(
                `test -e ${quoted} || test -L ${quoted}`,
                10_000,
            ).then((r) => r.exitCode === 1);
            if (!free) {
                return;
            }
            // Written by that user, never over a file already there.
            const dir = target.slice(0, target.lastIndexOf('/'));
            const written = await run(
                `mkdir -p ${shellQuote(dir)} && (set -C; printf '%s' ${shellQuote(Buffer.from(record.content).toString('base64'))} | base64 -d > ${quoted})`,
                30_000,
            );
            if (written.exitCode !== 0) {
                return;
            }
            const result = await run(
                `cd ${work} && ${record.command}`,
                180_000,
            );
            Object.assign(record, {
                executed: true,
                exitCode: result.exitCode,
                reproduced: result.exitCode === 0,
                // Shown to whoever reads the issue. The sandbox holds no
                // credential the command can read (the clone token lives only
                // in the fetch's environment, the proxy's config is root-only),
                // so this is a floor under what a repository could plant.
                output: redactSecrets(
                    `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim(),
                ).slice(-4000),
            });
        } finally {
            // Nothing it started outlives the test: a process left behind
            // could still be writing while the lenses read.
            await runCommand(
                sandbox,
                `pkill -KILL -u ${REPRO_USER}; true`,
                10_000,
                { asRoot: true },
            );
            await this.restoreCheckout(params, scanned, before, record);
        }
    }

    /** Whether REPRO_USER exists and is ready to clone the checkout. */
    private reproUserReady = false;

    /**
     * Creates the user reproduction tests run as, through the root channel,
     * and checks as that user that it is not root, cannot write the review
     * user's home nor the checkout, and that git reads the checkout.
     */
    private async prepareReproUser(sandbox: SandboxInstance): Promise<boolean> {
        if (this.reproUserReady) {
            return true;
        }
        const repo = shellQuote(sandbox.repoDir);
        // The review user's home: crossed to reach the checkout, never
        // listed or written.
        const home = shellQuote(
            sandbox.repoDir.slice(0, sandbox.repoDir.lastIndexOf('/')) || '/',
        );
        const created = await runCommand(
            sandbox,
            `(id -u ${REPRO_USER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${REPRO_USER}) && chmod o+x ${home}`,
            30_000,
            { asRoot: true },
        );
        this.reproUserReady =
            created.exitCode === 0 &&
            (
                await asReproUser(
                    sandbox,
                    `[ "$(id -u)" != 0 ] && ! sudo -n true 2>/dev/null && [ ! -w ${home} ] && [ ! -w ${repo} ] && git config --global --add safe.directory ${repo} && git config --global --add safe.directory ${repo}/.git && git -C ${repo} rev-parse -q HEAD >/dev/null`,
                    30_000,
                )
            ).exitCode === 0;
        return this.reproUserReady;
    }

    /** Created once per job: the clone reproduction tests run in. */
    private reproClone = false;

    /** Whether the audit checkout is read-only to the review user. */
    private auditCheckoutLocked = false;

    /**
     * Makes the checkout the lenses read, and its .git, read-only to the
     * review user: owned by root, writable by nobody else. And pinned to its
     * path: its parent is the review user's home, so a command could move
     * the checkout aside, put another tree at its path while other units
     * read, and move it back before any check. A bind mount of the checkout
     * onto itself makes it a mount point, which nobody but root can rename
     * or remove (EBUSY). Only possible in a sandbox whose review user cannot
     * become root (privileges dropped) and through the provider's root
     * channel; anywhere else, false. The sandbox is the slice's own (its
     * lease key is unique), so it stays locked.
     */
    private async lockAuditCheckout(
        sandbox: SandboxInstance,
    ): Promise<boolean> {
        if (this.auditCheckoutLocked) {
            return true;
        }
        if (sandbox.type !== 'e2b' || sandbox.privilegesDropped !== true) {
            return false;
        }
        const repo = shellQuote(sandbox.repoDir);
        // git refuses a repository another user owns unless told it is safe.
        const trusted = await runCommand(
            sandbox,
            `git config --global --add safe.directory ${repo}`,
            10_000,
        );
        const locked =
            trusted.exitCode === 0 &&
            (
                await runCommand(
                    sandbox,
                    `chown -R root:root ${repo} && chmod -R a+rX,go-w ${repo}`,
                    120_000,
                    { asRoot: true },
                )
            ).exitCode === 0;
        const pinned =
            locked &&
            (
                await runCommand(
                    sandbox,
                    `mountpoint -q ${repo} || mount --bind ${repo} ${repo}`,
                    30_000,
                    { asRoot: true },
                )
            ).exitCode === 0;
        // Checked as the review user: neither the files nor .git writable,
        // the checkout a mount point, and git still reads it.
        const verified =
            pinned &&
            (
                await runCommand(
                    sandbox,
                    `[ ! -w ${repo} ] && [ ! -w ${repo}/.git ] && [ ! -w ${repo}/.git/index ] && mountpoint -q ${repo} && git -C ${repo} rev-parse -q HEAD >/dev/null`,
                    30_000,
                )
            ).exitCode === 0;
        // Which directory was locked, checked again after each test.
        this.auditIdentity = verified
            ? await this.identityOf(sandbox)
            : undefined;
        this.auditCheckoutLocked = verified && !!this.auditIdentity;
        return this.auditCheckoutLocked;
    }

    /** Device and inode of the checkout and of its .git. */
    private auditIdentity: string | undefined;

    private async identityOf(
        sandbox: SandboxInstance,
    ): Promise<string | undefined> {
        const repo = shellQuote(sandbox.repoDir);
        const r = await runCommand(
            sandbox,
            `stat -c '%d:%i' ${repo} ${repo}/.git`,
            10_000,
            { asRoot: true },
        );
        const id = r.stdout.trim();
        return r.exitCode === 0 && id ? id : undefined;
    }

    private async headOf(
        sandbox: SandboxInstance,
    ): Promise<string | undefined> {
        return sandbox
            .run(`git -C ${shellQuote(sandbox.repoDir)} rev-parse HEAD`, {
                timeoutMs: 10_000,
            })
            .then((r) =>
                r.exitCode === 0 ? r.stdout?.trim() || undefined : undefined,
            )
            .catch(() => undefined);
    }

    /**
     * What git sees in the checkout: changed tracked files, and files it does
     * not track (an untracked directory as one entry). Null when unread.
     */
    private async checkoutState(
        sandbox: SandboxInstance,
    ): Promise<Set<string> | null> {
        return sandbox
            .run(
                `git -C ${shellQuote(sandbox.repoDir)} status --porcelain -z --untracked-files=normal`,
                { timeoutMs: 30_000 },
            )
            .then((r) =>
                r.exitCode === 0
                    ? new Set((r.stdout ?? '').split('\0').filter(Boolean))
                    : null,
            )
            .catch(() => null);
    }

    /**
     * The checkout as it was before the test: index, files and branch back
     * to the scanned commit, files it planted removed. A checkout that cannot
     * be read, or put back, stops the scan: the lenses would read changed code.
     */
    private async restoreCheckout(
        params: SecurityScanEngineParams,
        scanned: string,
        before: Set<string>,
        record: NonNullable<ScanFinding['reproduction']>,
    ): Promise<void> {
        const sandbox = params.sandbox;
        const repo = shellQuote(sandbox.repoDir);
        const unchanged = async () => {
            const [state, head] = await Promise.all([
                this.checkoutState(sandbox),
                this.headOf(sandbox),
            ]);
            if (!state || !head) {
                return null;
            }
            const appeared = [...state].filter((e) => !before.has(e));
            return { appeared, moved: head !== scanned };
        };

        // The path still leads to the locked checkout, not to a tree put in
        // its place; nothing at it can be trusted, or put back, otherwise.
        // Unread, it could not be verified; read and different, it was
        // swapped. Either way nothing there is read on.
        const identity = this.auditIdentity
            ? await this.identityOf(sandbox)
            : undefined;
        if (identity === undefined) {
            throw new ScanFailure(SCAN_CHECKOUT_UNVERIFIED_MESSAGE);
        }
        if (identity !== this.auditIdentity) {
            throw new ScanFailure(SCAN_CHECKOUT_TAMPERED_MESSAGE);
        }
        const found = await unchanged();
        if (found && !found.appeared.length && !found.moved) {
            return;
        }
        logger.warn({
            message:
                'A reproduction command changed the checkout; putting it back',
            context: SecurityScanEngine.name,
            metadata: {
                organizationId: params.organizationId,
                teamId: params.teamId,
                repositoryId: params.repositoryId,
                command: record.command.slice(0, 200),
            },
        });
        const planted = (found?.appeared ?? [])
            .filter((e) => e.startsWith('?? '))
            .map((e) => shellQuote(`${sandbox.repoDir}/${e.slice(3)}`));
        const commands = [
            `rm -f ${repo}/.git/index.lock`,
            `git -C ${repo} reset -q --hard ${shellQuote(scanned)}`,
            ...(planted.length ? [`rm -rf -- ${planted.join(' ')}`] : []),
        ];
        for (const command of commands) {
            // Through the root channel: the checkout is root's now.
            const result = await runCommand(sandbox, command, 30_000, {
                asRoot: true,
            });
            if (result.exitCode !== 0) {
                throw new ScanFailure(SCAN_CHECKOUT_TAMPERED_MESSAGE);
            }
        }
        const after = await unchanged();
        if (!after || after.appeared.length || after.moved) {
            throw new ScanFailure(SCAN_CHECKOUT_TAMPERED_MESSAGE);
        }
    }

    private readonly installed = new Set<string>();

    /** One dependency install per language per sandbox, best effort. */
    /** Installed in the reproduction worktree, never in the checkout. */
    private async ensureDependencies(
        sandbox: SandboxInstance,
        language: string,
        workdir: string,
    ): Promise<void> {
        if (this.installed.has(language)) {
            return;
        }
        this.installed.add(language);
        const command = INSTALL_COMMANDS[language];
        if (!command) {
            return;
        }
        await asReproUser(
            sandbox,
            `cd ${shellQuote(workdir)} && (${command})`,
            300_000,
        );
    }

    private async testHints(
        sandbox: SandboxInstance,
        language: string,
    ): Promise<string> {
        const manifests: Record<string, string[]> = {
            typescript: ['package.json'],
            python: ['pyproject.toml', 'pytest.ini', 'setup.cfg'],
            go: ['go.mod'],
            java: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
            kotlin: ['build.gradle.kts', 'build.gradle'],
            ruby: ['Gemfile'],
            php: ['composer.json', 'phpunit.xml'],
            rust: ['Cargo.toml'],
            csharp: [],
        };
        const parts: string[] = [];
        for (const file of manifests[language] ?? []) {
            const content = await sandbox.remoteCommands
                .read(file, 1, 80)
                .catch(() => '');
            if (content) {
                parts.push(`${file}:\n${content}`);
            }
        }
        const tests = await sandbox.remoteCommands
            .exec?.(
                `git ls-files | grep -E '(\\.spec\\.|\\.test\\.|_test\\.|test_|Test\\.)' | head -5`,
            )
            .catch(() => undefined);
        if (tests?.stdout) {
            parts.push(`Existing test files:\n${tests.stdout}`);
        }
        return parts.join('\n\n').slice(0, 6000);
    }
}

const INSTALL_COMMANDS: Record<string, string> = {
    typescript:
        '[ -f pnpm-lock.yaml ] && (corepack enable >/dev/null 2>&1; pnpm install --frozen-lockfile --ignore-scripts) || ([ -f yarn.lock ] && yarn install --frozen-lockfile --ignore-scripts) || npm ci --ignore-scripts || npm install --ignore-scripts',
    python: '([ -f requirements.txt ] && pip install -q -r requirements.txt); ([ -f pyproject.toml ] && pip install -q -e .); pip install -q pytest',
    go: 'go mod download',
    ruby: 'bundle install --quiet',
    php: 'composer install --no-interaction --quiet',
};

/** "OWASP A03:2021 / CWE-89" is CWE-89: the number after "CWE", not the first. */
function normalizeCwe(value?: string): string | undefined {
    const id = cweId(value);
    return id ? `CWE-${id}` : undefined;
}

/**
 * A command's result, whatever its exit: E2B throws on any exit but 0
 * (CommandExitError, which carries the exit code and output); that is read
 * back as the result it is. A throw with no exit code (a timeout, a lost
 * sandbox) is 124, never success.
 */
async function runCommand(
    sandbox: SandboxInstance,
    command: string,
    timeoutMs: number,
    opts: { asRoot?: boolean } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
        const r = await sandbox.run(command, {
            timeoutMs,
            ...(opts.asRoot ? { asRoot: true } : {}),
        });
        return {
            exitCode: r.exitCode,
            stdout: r.stdout ?? '',
            stderr: r.stderr ?? '',
        };
    } catch (error) {
        const e = error as {
            exitCode?: unknown;
            stdout?: unknown;
            stderr?: unknown;
            message?: unknown;
        };
        return typeof e?.exitCode === 'number'
            ? {
                  exitCode: e.exitCode,
                  stdout: typeof e.stdout === 'string' ? e.stdout : '',
                  stderr: typeof e.stderr === 'string' ? e.stderr : '',
              }
            : {
                  exitCode: 124,
                  stdout: '',
                  stderr: String(e?.message ?? error),
              };
    }
}

/**
 * The user reproduction tests and their installs run as. Not the review
 * user: every lens command reads that user's home (git config, shell
 * profile), which a build hook or a test could otherwise rewrite.
 */
const REPRO_USER = 'kodus-repro';
const REPRO_WORKDIR = `/home/${REPRO_USER}/repo`;

/** A command run as REPRO_USER, in its own login environment. */
function asReproUser(
    sandbox: SandboxInstance,
    command: string,
    timeoutMs: number,
) {
    return runCommand(
        sandbox,
        `runuser -l ${REPRO_USER} -c ${shellQuote(command)}`,
        timeoutMs,
        { asRoot: true },
    );
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Two lenses, two passes or two units reporting the same weakness on the same
 * lines are one finding, and so are the route, the handler and the query of
 * one missing check (one sits on the other's attack path). Two different
 * weaknesses on neighbouring lines, a SQL injection and an XSS in one handler,
 * stay two: the review's dedup that runs next judges what text alone shows
 * is one bug.
 */
function isDuplicate(
    existing: ScanReportedFinding[],
    candidate: ScanReportedFinding,
): boolean {
    return duplicatesOf(existing, candidate).length > 0;
}

/** The existing findings `candidate` repeats. */
function duplicatesOf(
    existing: ScanReportedFinding[],
    candidate: ScanReportedFinding,
): ScanReportedFinding[] {
    return existing.filter(
        (f) =>
            sameKind(f, candidate) &&
            ((f.filePath === candidate.filePath &&
                candidate.startLine <= f.endLine &&
                f.startLine <= candidate.endLine) ||
                onAttackPath(f, candidate) ||
                onAttackPath(candidate, f)),
    );
}

/** Same kind of weakness: the CWE's family when both have one, else the lens. */
function sameKind(a: ScanReportedFinding, b: ScanReportedFinding): boolean {
    const fa = cweFamily(a.cwe);
    const fb = cweFamily(b.cwe);
    return fa && fb ? fa === fb : a.vulnerabilityClass === b.vulnerabilityClass;
}

/** Whether `finding`'s location is a step of `path`'s attack path. */
function onAttackPath(
    path: ScanReportedFinding,
    finding: ScanReportedFinding,
): boolean {
    return (path.attackPath ?? []).some(
        (step) =>
            step.file === finding.filePath &&
            step.line >= finding.startLine - 2 &&
            step.line <= finding.endLine + 2,
    );
}

/** How a dedup trace entry is matched back to the finding it summarizes. */
function dedupKey(s: {
    relevantFile?: string;
    relevantLinesStart?: number;
    relevantLinesEnd?: number;
    oneSentenceSummary?: string;
}): string {
    return [
        s.relevantFile,
        s.relevantLinesStart,
        s.relevantLinesEnd,
        s.oneSentenceSummary,
    ].join('\u0000');
}

/** At most this many earlier findings go to one unit's dedup call. */
const DEDUP_EARLIER_LIMIT = 40;

/**
 * The earlier findings a unit's findings could duplicate: those in a file the
 * unit read or one of its findings' attack paths crosses, newest first. The
 * dedup call's size stays bounded however long the scan runs.
 */
/** The stored identities of the findings, where they have one. */
/** The stored findings among these, once each by fingerprint. */
function withFingerprint(
    findings: ScanReportedFinding[] = [],
): ScanReportedFinding[] {
    const byFingerprint = new Map<string, ScanReportedFinding>();
    for (const f of findings) {
        if (f.fingerprint && !byFingerprint.has(f.fingerprint)) {
            byFingerprint.set(f.fingerprint, f);
        }
    }
    return [...byFingerprint.values()];
}

function nearby(
    earlier: ScanReportedFinding[],
    unit: ScanUnit,
    fresh: ScanFinding[],
): ScanReportedFinding[] {
    const files = new Set([unit.file, ...unit.relatedFiles]);
    for (const finding of fresh) {
        files.add(finding.filePath);
        for (const step of finding.attackPath) files.add(step.file);
    }
    return earlier
        .filter((f) => files.has(f.filePath))
        .slice(-DEDUP_EARLIER_LIMIT);
}

function sampleListing(listing: string[], limit: number): string[] {
    if (listing.length <= limit) {
        return listing;
    }
    const step = listing.length / limit;
    return Array.from(
        { length: limit },
        (_, i) => listing[Math.floor(i * step)],
    );
}

interface AuditResult {
    findings: ScanFinding[];
    /** Earlier findings one of the unit's repeated, so dropped. */
    sighted?: ScanReportedFinding[];
    /** The classes whose every lens ran to the end. */
    examinedClasses?: VulnClass[];
    /** On a unit that stopped halfway, where to pick it up. */
    lensesRun?: VulnClass[];
    lensesExamined?: VulnClass[];
    error?: string;
    /** The unit stopped halfway: the cap, or the job ended. */
    aborted?: boolean;
}

type Serial = <T>(task: () => Promise<T>) => Promise<T>;

/** Runs the tasks handed to it one at a time, in the order handed. */
function serially(): Serial {
    let tail: Promise<unknown> = Promise.resolve();
    return (task) => {
        const run = tail.then(task, task);
        tail = run.catch(() => undefined);
        return run;
    };
}

function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
    const present = signals.filter(Boolean) as AbortSignal[];
    if (typeof (AbortSignal as any).any === 'function') {
        return (AbortSignal as any).any(present);
    }
    const controller = new AbortController();
    for (const s of present) {
        if (s.aborted) {
            controller.abort(s.reason);
            break;
        }
        s.addEventListener('abort', () => controller.abort(s.reason), {
            once: true,
        });
    }
    return controller.signal;
}
