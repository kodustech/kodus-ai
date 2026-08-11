import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '@libs/core/log/logger';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    ITraceDecisionBranchReader,
    TRACE_DECISION_BRANCH_READER_TOKEN,
} from '@libs/cli-review/domain/contracts/trace-decision-branch-reader.contract';
import {
    estimateTokens,
    TRACE_CONTEXT_PACK_TOKEN_BUDGET,
    TraceContextDecision,
} from '@libs/cli-review/domain/types/trace-context.types';

export interface BuildTraceContextPackInput {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: { id: string; name: string };
    /** Repo-relative paths touched by the pull request. */
    changedFilePaths: string[];
    /** Destination branch key used by the CLI's shared record. */
    branch: string;
    tokenBudget?: number;
}

export interface BuildTraceContextPackResult {
    decisions: TraceContextDecision[];
    /** Decisions that matched the diff but did not fit the budget. */
    droppedForBudget: number;
    estimatedTokens: number;
}

/**
 * Turns recorded decisions into the slice of them that is relevant to one
 * pull request.
 *
 * Deliberate tradeoffs stop being reported as findings only if the reviewer can
 * see them, so this runs before the review prompt is built. It returns an empty
 * result when nothing matches, and the caller must leave the prompt untouched in
 * that case — the feature is inert until decisions exist.
 */
@Injectable()
export class BuildTraceContextPackUseCase {
    private readonly logger = createLogger(BuildTraceContextPackUseCase.name);

    constructor(
        @Inject(TRACE_DECISION_BRANCH_READER_TOKEN)
        private readonly decisionBranchReader: ITraceDecisionBranchReader,
    ) {}

    async execute(
        input: BuildTraceContextPackInput,
    ): Promise<BuildTraceContextPackResult> {
        const empty: BuildTraceContextPackResult = {
            decisions: [],
            droppedForBudget: 0,
            estimatedTokens: 0,
        };

        const changedFilePaths = (input.changedFilePaths ?? [])
            .map((entry) => normalizePath(entry))
            .filter(Boolean);

        if (changedFilePaths.length === 0) {
            return empty;
        }

        let recorded: TraceContextDecision[];
        try {
            const record = await this.decisionBranchReader.read({
                organizationAndTeamData: input.organizationAndTeamData,
                repository: input.repository,
                branch: input.branch,
            });
            recorded = record?.decisions ?? [];
        } catch (error) {
            // A review must not fail because the decision store is unavailable.
            this.logger.warn({
                message:
                    'Failed to load recorded decisions for the context pack',
                context: BuildTraceContextPackUseCase.name,
                metadata: {
                    organizationId:
                        input.organizationAndTeamData.organizationId,
                    teamId: input.organizationAndTeamData.teamId,
                    repositoryId: input.repository?.id,
                    branch: input.branch,
                    errorName:
                        error instanceof Error ? error.name : 'UnknownError',
                },
            });
            return empty;
        }

        const matching = dedupe(recorded).filter((decision) =>
            matchesAnyPath(decision, changedFilePaths),
        );

        if (matching.length === 0) {
            return empty;
        }

        return applyBudget(
            matching,
            input.tokenBudget ?? TRACE_CONTEXT_PACK_TOKEN_BUDGET,
        );
    }
}

/**
 * Pinned first, then highest confidence. The order doubles as the drop order:
 * whatever does not fit is cut from the tail, so the lowest confidence goes
 * first and a pinned decision is never dropped.
 */
export function applyBudget(
    decisions: TraceContextDecision[],
    tokenBudget: number,
): BuildTraceContextPackResult {
    const ordered = [...decisions].sort(compareForPack);

    const kept: TraceContextDecision[] = [];
    let used = 0;
    let dropped = 0;

    for (const decision of ordered) {
        const cost = estimateTokens(renderDecision(decision));

        if (decision.pinned) {
            kept.push(decision);
            used += cost;
            continue;
        }

        if (used + cost > tokenBudget) {
            dropped += 1;
            continue;
        }

        kept.push(decision);
        used += cost;
    }

    return {
        decisions: kept,
        droppedForBudget: dropped,
        estimatedTokens: used,
    };
}

export function renderDecision(decision: TraceContextDecision): string {
    const parts = [`- ${decision.decision}`];

    if (decision.rationale) {
        parts.push(`  why: ${decision.rationale}`);
    }

    const meta = [
        decision.type,
        decision.origin ? `origin: ${decision.origin}` : null,
        typeof decision.confidence === 'number'
            ? `confidence: ${decision.confidence.toFixed(2)}`
            : null,
        decision.scope?.length ? `scope: ${decision.scope.join(', ')}` : null,
    ].filter(Boolean);

    parts.push(`  (${meta.join(' · ')})`);

    return parts.join('\n');
}

/**
 * The prompt block. Returns an empty string when there is nothing to say, so
 * the caller can leave the prompt byte-identical.
 */
export function renderTraceContextPack(
    decisions: TraceContextDecision[],
): string {
    if (!decisions.length) {
        return '';
    }

    return [
        '### Recorded Decisions (why this code looks the way it does)',
        '',
        'These decisions were captured from the agent sessions that produced the',
        'code under review, scoped to the files in this diff. They may be stale',
        'or wrong and are not proof that the implementation is correct. Verify',
        'their claims and never suppress a concrete finding merely because the',
        'recorded decision describes the behavior as deliberate.',
        '',
        ...decisions.map((decision) => renderDecision(decision)),
    ].join('\n');
}

function compareForPack(
    a: TraceContextDecision,
    b: TraceContextDecision,
): number {
    if (!!a.pinned !== !!b.pinned) {
        return a.pinned ? -1 : 1;
    }

    const confidenceDelta = (b.confidence ?? 0) - (a.confidence ?? 0);
    if (confidenceDelta !== 0) {
        return confidenceDelta;
    }

    return a.decision.localeCompare(b.decision);
}

function dedupe(decisions: TraceContextDecision[]): TraceContextDecision[] {
    const seen = new Map<string, TraceContextDecision>();

    for (const decision of decisions) {
        if (!decision?.decision) {
            continue;
        }
        const key = `${decision.decision}|${(decision.scope ?? []).slice().sort().join(',')}`;
        const existing = seen.get(key);
        if (
            !existing ||
            (decision.confidence ?? 0) > (existing.confidence ?? 0)
        ) {
            seen.set(key, decision);
        }
    }

    return [...seen.values()];
}

/**
 * Exact or prefix comparison in both directions, matching the CLI's recall.
 * No embeddings, no similarity search.
 */
export function matchesAnyPath(
    decision: TraceContextDecision,
    changedFilePaths: string[],
): boolean {
    const scope = (decision.scope ?? []).map(normalizePath).filter(Boolean);
    if (scope.length === 0) {
        return false;
    }

    return scope.some((scopeEntry) =>
        changedFilePaths.some(
            (changed) =>
                scopeEntry === changed ||
                changed.startsWith(`${scopeEntry}/`) ||
                scopeEntry.startsWith(`${changed}/`),
        ),
    );
}

function normalizePath(value: string): string {
    if (typeof value !== 'string') {
        return '';
    }
    return value
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');
}
