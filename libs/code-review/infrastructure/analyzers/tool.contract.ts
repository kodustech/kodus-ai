import { ManagedTool } from '@libs/code-review/infrastructure/adapters/services/ci-evidence/recognize-ci-analyzers';
import { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

import { AnalyzerFinding } from './analyzer-finding.type';

/** Every deterministic tool Kody can run itself. */
export const ANALYZER_TOOL_IDS = ['secrets', 'dependencies'] as const;

export type AnalyzerToolId = (typeof ANALYZER_TOOL_IDS)[number];

/**
 * Per-tool switch. `auto` defers to the customer's own pipeline — it runs only
 * when their CI has no equivalent analysis — while `on` is an explicit
 * instruction that outranks that check.
 */
export type ToolMode = 'off' | 'auto' | 'on';

export type ChangedFile = { filename: string; patch?: string };

/**
 * Why a tool did not run. Recorded rather than inferred: a tool that produced
 * no findings and a tool that never executed look identical downstream, and
 * confusing the two manufactures confidence in code nothing examined.
 */
export type RouteSkipReason =
    'disabled-by-config' | 'no-matching-files' | 'covered-by-ci';

export type RouteDecision = {
    toolId: AnalyzerToolId;
    run: boolean;
    /** Present only when `run` is false. */
    reason?: RouteSkipReason;
    /** How many changed files the tool selected. */
    fileCount: number;
};

export type ToolRouteInput = {
    changedFiles: ChangedFile[];
    /** Per-tool modes from the repository configuration. */
    modes?: Partial<Record<AnalyzerToolId, ToolMode>>;
    /** Analysis categories the customer's CI already covers. */
    ciCoveredTools?: ManagedTool[];
};

export type ToolRunInput = {
    sandbox: SandboxInstance;
    /** Only the files this tool selected, never the whole change. */
    files: ChangedFile[];
};

/**
 * A deterministic analyzer.
 *
 * `selectFiles` is how a tool declares what it applies to; returning an empty
 * list is how it says "not this change", which the router records as a skip
 * rather than running it for nothing.
 */
export interface AnalyzerTool {
    readonly id: AnalyzerToolId;
    /**
     * Category matched against the customer's CI checks. Absent when no CI
     * check could stand in for this tool.
     */
    readonly coverage?: ManagedTool;
    /**
     * Whether this tool should also see files `ignorePaths` removed from the
     * review. Opt-in, and true only for the dependency scan: lockfiles are on
     * that list by default and are the only place an advisory can be found.
     * Everything else must honour the setting — a credential reported in a
     * path the customer excluded is a comment they explicitly asked not to
     * get.
     */
    readonly readsIgnoredFiles?: boolean;
    selectFiles(files: ChangedFile[]): ChangedFile[];
    run(input: ToolRunInput): Promise<AnalyzerFinding[]>;
}

export const ANALYZER_TOOLS_TOKEN = Symbol('ANALYZER_TOOLS_TOKEN');

/**
 * A path as the host reports it, reduced to a repository-relative one.
 *
 * Azure Repos returns changed-file paths with a leading slash ("/yarn.lock").
 * Pasted into a sandbox command that becomes an absolute path outside the
 * checkout, so the scanner is handed a file that does not exist: betterleaks
 * exits non-zero and the dependency scan finds no manifest. Finding metadata
 * keeps the host's original spelling — comment anchoring matches against the
 * host's own changed-file list — so only the filesystem path is normalized.
 */
export const toRepoRelativePath = (filename?: string): string =>
    (filename ?? '').replace(/^\/+/, '');
