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
import { cweFamily } from '@libs/issues/domain/scan-fingerprint';
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
import { SCAN_MAP_FAILED_MESSAGE, ScanFailure } from '../domain/scan-failure';
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
         * Fingerprints of earlier findings a fresh one was dropped as a
         * duplicate of: found again, so seen by this scan.
         */
        sighted?: string[],
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
                // Only files a lens would read: an auth check alone is no
                // candidate, so its file is not one the limit left out.
                filesBeyondPlan: Math.max(
                    0,
                    rankCandidates(surface).length - params.maxUnits,
                ),
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
                        fingerprintsOf(result.sighted),
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
                            fingerprintsOf(result.sighted),
                        );
                    }
                }
                return;
            }

            // The unit ran beside units folded in after it started: what they
            // reported was not in its view yet. Past the cap the meter refuses
            // the dedup's request, and every finding is kept.
            const reported = [...(params.reported ?? []), ...findings];
            // Earlier findings a fresh one turns out to repeat: found again.
            const sighted = [...(result.sighted ?? [])];
            const fresh = result.findings.filter((f) => {
                const repeats = duplicatesOf(reported, f);
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
                fingerprintsOf(sighted),
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
                    [...(params.reported ?? []), ...findings],
                    reproduceOneAtATime,
                    progress.get(unit.id),
                );
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
            for (const group of trace?.groups ?? []) {
                const members = [group.keep, ...group.duplicates].flatMap(
                    (m) => indicesOf.get(dedupKey(m)) ?? [],
                );
                const droppedFresh = members.some(
                    (i) => i >= earlier.length && !kept.has(`scan-${i}`),
                );
                if (droppedFresh) {
                    for (const i of members) {
                        if (i < earlier.length) sighted.push(earlier[i]);
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
                metadata: { repositoryId: params.repositoryId },
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
                metadata: { repositoryId: params.repositoryId },
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
                    );
                    const repeats = finding
                        ? duplicatesOf(earlier, finding)
                        : [];
                    sighted.push(...repeats);
                    if (
                        finding &&
                        !repeats.length &&
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
    ): Promise<{ snippet: string; whole?: string }> {
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
        } catch {
            return { snippet: '' };
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
    ): Promise<ScanFinding | null> {
        const filePath = (suggestion.relevantFile ?? '').replace(/^\.?\//, '');
        if (!filePath || !suggestion.suggestionContent) {
            return null;
        }
        const startLine = Math.max(1, suggestion.relevantLinesStart ?? 1);
        const endLine = Math.max(
            startLine,
            suggestion.relevantLinesEnd ?? startLine,
        );
        const { snippet, whole } = await this.readAround(
            params.sandbox,
            filePath,
            startLine,
            endLine,
        );

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
                    'Security finding could not be structured; keeping it plain',
                context: SecurityScanEngine.name,
                error,
                metadata: { repositoryId: params.repositoryId, filePath },
            });
        }

        const firstLine = suggestion.suggestionContent
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l && !/^entry:/i.test(l));

        return {
            unitId: unit.id,
            vulnerabilityClass: vulnClass,
            cwe: normalizeCwe(structured?.cwe) ?? DEFAULT_CWE[vulnClass],
            title:
                structured?.title?.trim() ||
                (firstLine ?? 'Security vulnerability').slice(0, 120),
            description: suggestion.suggestionContent.trim(),
            severity: structured?.severity ?? 'high',
            filePath,
            startLine,
            endLine,
            language: unit.language,
            symbol: whole ? enclosingSymbol(whole, startLine) : undefined,
            attackPath: (structured?.attackPath ?? [])
                .filter((s) => s?.file && Number.isFinite(s.line))
                .slice(0, 12),
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
            const target = `${sandbox.repoDir}/${path}`;
            const quoted = `'${target.replace(/'/g, `'\\''`)}'`;
            // A file (or link) already there is the repository's own: never
            // written over, nor removed after. The test stays on the issue,
            // not run.
            const taken = await sandbox
                .run(`test -e ${quoted} || test -L ${quoted}`, {
                    timeoutMs: 10_000,
                })
                .then((r) => r.exitCode === 0)
                .catch(() => true);
            if (taken) {
                return;
            }
            await sandbox.writeFile(target, repro.content);
            await this.ensureDependencies(sandbox, finding.language);
            const result = await sandbox
                .run(`cd ${sandbox.repoDir} && ${record.command}`, {
                    timeoutMs: 180_000,
                })
                .catch((error) => ({
                    exitCode: 124,
                    stdout: '',
                    stderr: String(error?.message ?? error),
                }));
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
            // The test lives on the issue; left in the checkout, the next
            // units' lenses would read it as the repository's own code.
            await sandbox
                .run(`rm -f -- ${quoted}`, { timeoutMs: 10_000 })
                .catch(() => undefined);
        } catch (error) {
            logger.warn({
                message: 'Reproduction test could not be produced',
                context: SecurityScanEngine.name,
                error,
                metadata: {
                    repositoryId: params.repositoryId,
                    filePath: finding.filePath,
                },
            });
        }
    }

    private readonly installed = new Set<string>();

    /** One dependency install per language per sandbox, best effort. */
    private async ensureDependencies(
        sandbox: SandboxInstance,
        language: string,
    ): Promise<void> {
        if (this.installed.has(language)) {
            return;
        }
        this.installed.add(language);
        const command = INSTALL_COMMANDS[language];
        if (!command) {
            return;
        }
        await sandbox
            .run(`cd ${sandbox.repoDir} && (${command})`, {
                timeoutMs: 300_000,
            })
            .catch(() => undefined);
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

function normalizeCwe(value?: string): string | undefined {
    const match = value?.match(/(\d{1,5})/);
    return match ? `CWE-${match[1]}` : undefined;
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
function fingerprintsOf(findings: ScanReportedFinding[] = []): string[] {
    return [
        ...new Set(
            findings
                .map((f) => f.fingerprint)
                .filter((fp): fp is string => !!fp),
        ),
    ];
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
