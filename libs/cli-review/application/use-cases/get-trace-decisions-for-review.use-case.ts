import { Injectable } from '@nestjs/common';
import { SessionEventRepository } from '@libs/cli-review/infrastructure/repositories/session-event.repository';
import type { TraceDecision } from './trace-context-pack';
import { createLogger } from '@libs/core/log/logger';

/**
 * Loads classified session decisions for a PR branch from the session_events
 * store so the code-review pipeline can inject a path-scoped context pack
 * and sticky PR comment.
 *
 * Fail-open: any repository error returns [] so review never blocks on Trace.
 */
@Injectable()
export class GetTraceDecisionsForReviewUseCase {
    private readonly logger = createLogger(
        GetTraceDecisionsForReviewUseCase.name,
    );

    constructor(
        private readonly sessionEventRepository: SessionEventRepository,
    ) {}

    async execute(params: {
        organizationId: string;
        branch: string;
    }): Promise<TraceDecision[]> {
        if (!params.organizationId || !params.branch) {
            return [];
        }

        try {
            const events =
                await this.sessionEventRepository.findClassifiedByBranch(
                    params.organizationId,
                    params.branch,
                );

            const byId = new Map<string, TraceDecision>();
            let index = 0;
            for (const event of events) {
                for (const d of event.decisions ?? []) {
                    if (!d?.decision) {
                        continue;
                    }
                    index += 1;
                    const id =
                        // Stable id from content when none was stored
                        `se-${event.sessionId?.slice(0, 8) ?? 'x'}-${index}`;
                    const paths = [
                        ...((d.evidence ?? []).filter(
                            (e) =>
                                typeof e === 'string' &&
                                (e.includes('/') || /\.\w+$/.test(e)),
                        ) as string[]),
                    ];
                    // Also pull filesModified from sibling turn_end payloads
                    // when present on the same session via evidence-only scope.
                    const decision: TraceDecision = {
                        id,
                        type: d.type || 'other',
                        decision: d.decision,
                        rationale: d.rationale,
                        confidence: d.confidence,
                        evidence: d.evidence,
                        paths: paths.length > 0 ? paths : undefined,
                        pinned: false,
                        forgotten: false,
                    };
                    const existing = byId.get(id);
                    if (
                        !existing ||
                        (decision.confidence ?? 0) >
                            (existing.confidence ?? 0)
                    ) {
                        byId.set(id, decision);
                    }
                }
            }

            // Enrich paths from turn_end files on the same sessions when
            // a decision has no path scope yet (so path filter can match).
            for (const event of events) {
                const payloadFiles = this.filesFromPayload(event.payload);
                if (payloadFiles.length === 0) {
                    continue;
                }
                for (const d of byId.values()) {
                    if (!d.paths || d.paths.length === 0) {
                        d.paths = payloadFiles.slice(0, 20);
                    }
                }
            }

            return [...byId.values()];
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to load Kodus Trace decisions for review (fail-open)',
                context: GetTraceDecisionsForReviewUseCase.name,
                error:
                    error instanceof Error ? error.message : String(error),
                metadata: {
                    organizationId: params.organizationId,
                    branch: params.branch,
                },
            });
            return [];
        }
    }

    private filesFromPayload(
        payload: Record<string, unknown> | null | undefined,
    ): string[] {
        if (!payload) {
            return [];
        }
        const out: string[] = [];
        const filesModified = payload.filesModified;
        if (Array.isArray(filesModified)) {
            for (const f of filesModified) {
                if (typeof f === 'string') {
                    out.push(f);
                } else if (f && typeof f === 'object' && 'path' in f) {
                    const p = (f as { path?: string }).path;
                    if (p) {
                        out.push(p);
                    }
                }
            }
        }
        return out;
    }
}
