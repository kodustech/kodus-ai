/**
 * The security scan itself, with no database: map the repository, audit each
 * unit with one lens per vulnerability class on the code-review harness (the
 * same finder, tools and verify a review runs), and turn what survives verify
 * into findings. The job processor persists what this returns; the eval runs
 * this same engine and scores its findings, so both see one code path.
 */
import { z } from 'zod';

import { LLM } from '@libs/llm/llm';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { runWithUsageMeter } from '@libs/llm/usage-meter';
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
} from '../domain/scan-units';
import type {
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
const LENS_MAX_STEPS = 18;
const LISTING_LIMIT = 4000;
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
    /** Write and run a reproduction test for each finding (needs E2B). */
    reproduce: boolean;
    onPlanned?: (units: ScanUnit[], languages: string[]) => Promise<void>;
    onUnitDone?: (
        progress: ScanUnitProgress,
        findings: ScanFinding[],
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
        const signal = anySignal([params.signal, budgetAbort.signal]);

        return runWithUsageMeter(
            params.meter,
            () => this.runMetered(params, signal, budgetAbort.signal),
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
    ): Promise<SecurityScanEngineResult> {
        const listing = await this.listFiles(params.sandbox);
        const existingFiles = new Set(listing);
        const languages = detectLanguages(listing);

        // Collected on every run, a continuation too: the lenses read its
        // hits as leads, and a resumed plan would audit without them.
        const surface = await this.collect(
            params.sandbox.remoteCommands.grep as GrepFn,
            { languages },
        );
        const hitsByFile = new Map<string, SurfaceHit[]>();
        for (const hit of surface.hits) {
            const list = hitsByFile.get(hit.file);
            if (list) list.push(hit);
            else hitsByFile.set(hit.file, [hit]);
        }

        let units = params.units;
        if (!units?.length) {
            units = await this.plan(
                params,
                surface,
                listing,
                existingFiles,
                languages,
            );
            await params.onPlanned?.(units, languages);
        }

        const progress = new Map<string, ScanUnitProgress>(
            (params.progress ?? []).map((p) => [p.unitId, p]),
        );
        const findings: ScanFinding[] = [];
        const examined = new Set<string>();
        let stoppedByBudget = false;

        for (const unit of units) {
            const state = progress.get(unit.id)?.state;
            if (state === 'done' || state === 'failed') {
                continue;
            }
            if (signal.aborted && !budgetSignal.aborted) {
                break;
            }
            if (budgetSignal.aborted || params.meter.isExhausted()) {
                stoppedByBudget = true;
                break;
            }
            if (params.deadlineAt && this.now() >= params.deadlineAt) {
                break;
            }

            const unitHits = [unit.file, ...unit.relatedFiles].flatMap(
                (file) => hitsByFile.get(file) ?? [],
            );

            const reported = [...(params.reported ?? []), ...findings];
            const result = await this.auditUnit(
                params,
                unit,
                unitHits,
                signal,
                reported,
            );

            if (result.aborted) {
                // What the unit found before it stopped is kept, but the unit
                // is not counted as examined: its files were only partly read,
                // so nothing there may be resolved as gone.
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
                    );
                } else if (result.findings.length) {
                    // The job ended mid-unit: the unit runs again next time;
                    // its findings so far are stored now so none is lost.
                    await params.onUnitDone?.(
                        { unitId: unit.id, state: 'pending', findings: 0 },
                        result.findings,
                    );
                }
                break;
            }

            result.findings = await this.withoutDuplicates(
                params,
                result.findings,
                nearby(reported, unit, result.findings),
            );

            const unitProgress: ScanUnitProgress = {
                unitId: unit.id,
                state: result.error ? 'failed' : 'done',
                findings: result.findings.length,
                ...(result.error ? { error: result.error } : {}),
            };
            progress.set(unit.id, unitProgress);
            if (!result.error) {
                examined.add(unit.file);
                unit.relatedFiles.forEach((f) => examined.add(f));
            }
            findings.push(...result.findings);
            await params.onUnitDone?.(unitProgress, result.findings);
        }

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
            examinedFiles: [...examined],
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
            const { suggestions } = await this.dedup(
                (this.dedupDeps ??= createFindingDedupDeps({
                    logger,
                    context: SecurityScanEngine.name,
                })),
                all.map(asSuggestion) as any,
                0,
                params.model.slot,
                { organizationId: params.organizationId } as any,
            );
            const kept = new Set(suggestions.map((s) => s.id));
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

    private async listFiles(sandbox: SandboxInstance): Promise<string[]> {
        const fromGit = await sandbox
            .run(`git -C ${sandbox.repoDir} ls-files`, { timeoutMs: 60_000 })
            .catch(() => undefined);
        const raw =
            fromGit?.exitCode === 0 && fromGit.stdout
                ? fromGit.stdout
                : await sandbox.remoteCommands.listDir('.', 25);
        return raw
            .split('\n')
            .map((l) => l.trim().replace(/^\.\//, ''))
            .filter((l) => l && !l.startsWith('Error:'))
            .slice(0, LISTING_LIMIT * 5);
    }

    private async plan(
        params: SecurityScanEngineParams,
        surface: SurfaceMap,
        listing: string[],
        existingFiles: Set<string>,
        languages: string[],
    ): Promise<ScanUnit[]> {
        const candidates = rankCandidates(surface);
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
        signal: AbortSignal,
        /** What earlier units of this scan already reported. */
        earlier: ScanReportedFinding[] = [],
    ): Promise<{
        findings: ScanFinding[];
        error?: string;
        /** The unit stopped halfway: the cap, or the job ended. */
        aborted?: boolean;
    }> {
        const findings: ScanFinding[] = [];
        let failures = 0;

        for (const vulnClass of unit.classes) {
            if (signal.aborted) {
                return { findings, aborted: true };
            }
            try {
                const output = await this.runLens(
                    this.lensInput(params, unit, vulnClass, hits, signal),
                    {
                        remoteCommands: params.sandbox.remoteCommands,
                        byokConfig: params.model.slot,
                    },
                );
                if (signal.aborted) {
                    return { findings, aborted: true };
                }
                const kept = (output.findings?.suggestions ?? []) as any[];
                for (const suggestion of kept) {
                    const finding = await this.finalize(
                        params,
                        unit,
                        vulnClass,
                        suggestion,
                    );
                    if (
                        finding &&
                        !isDuplicate(findings, finding) &&
                        !isDuplicate(earlier, finding)
                    ) {
                        findings.push(finding);
                    }
                }
            } catch (error) {
                if (signal.aborted) {
                    return { findings, aborted: true };
                }
                failures++;
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
        }

        if (params.reproduce) {
            for (const finding of findings) {
                // Past the slice's deadline a test install could outlive the
                // sandbox: the finding ships with its attack path, no test.
                if (
                    signal.aborted ||
                    (params.deadlineAt && this.now() >= params.deadlineAt)
                ) {
                    break;
                }
                await this.reproduce(params, finding);
            }
        }

        return failures === unit.classes.length && unit.classes.length > 0
            ? { findings, error: 'every lens failed' }
            : { findings };
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
            await sandbox.writeFile(
                `${sandbox.repoDir}/${path}`,
                repro.content,
            );
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
                output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`
                    .trim()
                    .slice(-4000),
            });
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
 * Two lenses, two passes or two units reporting the same operation are one
 * finding, whatever class each gave it: the SSRF lens and the data-exposure
 * lens both flag a fetch whose response leaks, and the developer has one
 * line to fix. So are the route, the handler and the query of one missing
 * check, reported from three units: same class, and one sits on the other's
 * attack path.
 */
function isDuplicate(
    existing: ScanReportedFinding[],
    candidate: ScanReportedFinding,
): boolean {
    return existing.some(
        (f) =>
            (f.filePath === candidate.filePath &&
                candidate.startLine <= f.endLine &&
                f.startLine <= candidate.endLine) ||
            (f.vulnerabilityClass === candidate.vulnerabilityClass &&
                (onAttackPath(f, candidate) || onAttackPath(candidate, f))),
    );
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

/** At most this many earlier findings go to one unit's dedup call. */
const DEDUP_EARLIER_LIMIT = 40;

/**
 * The earlier findings a unit's findings could duplicate: those in a file the
 * unit read or one of its findings' attack paths crosses, newest first. The
 * dedup call's size stays bounded however long the scan runs.
 */
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
