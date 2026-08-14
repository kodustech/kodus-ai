import { Injectable } from '@nestjs/common';
import { createLogger } from '@libs/core/log/logger';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { TraceContextDecision } from '@libs/cli-review/domain/types/trace-context.types';

/**
 * Invisible in the rendered comment, and the only thing that identifies the
 * comment as ours across re-runs.
 */
export const TRACE_COMMENT_MARKER = '<!-- kodus-trace-decisions -->';

export interface PostTracePrCommentInput {
    organizationAndTeamData: OrganizationAndTeamData;
    prNumber: number;
    repository: { name: string; id: string };
    decisions: TraceContextDecision[];
    platformType?: string;
    dryRun?: { enabled?: boolean };
}

export type PostTracePrCommentOutcome =
    | { action: 'skipped'; reason: 'no-decisions' | 'dry-run' | 'error' }
    | { action: 'created'; commentId?: number }
    | { action: 'updated'; commentId?: number };

/**
 * A single sticky comment carrying the reasoning behind the change.
 *
 * Follows the post-then-update pattern the review pipeline already uses: find
 * the previous comment by its marker and edit it in place, so a PR that is
 * reviewed five times ends up with one comment rather than five.
 */
@Injectable()
export class PostTracePrCommentUseCase {
    private readonly logger = createLogger(PostTracePrCommentUseCase.name);

    constructor(
        private readonly codeManagementService: CodeManagementService,
    ) {}

    async execute(
        input: PostTracePrCommentInput,
    ): Promise<PostTracePrCommentOutcome> {
        const decisions = (input.decisions ?? []).filter(
            (decision) => decision?.decision?.trim(),
        );

        // A PR with no recorded decisions gets no comment at all — not an empty
        // one, and not an edit of a previous one.
        if (decisions.length === 0) {
            return { action: 'skipped', reason: 'no-decisions' };
        }

        if (input.dryRun?.enabled) {
            return { action: 'skipped', reason: 'dry-run' };
        }

        const body = renderTraceComment(decisions);

        try {
            const existing = await this.findExistingComment(input);

            if (existing) {
                await this.codeManagementService.updateIssueComment({
                    organizationAndTeamData: input.organizationAndTeamData,
                    prNumber: input.prNumber,
                    repository: input.repository,
                    commentId: existing.id,
                    noteId: existing.id,
                    body,
                });

                return { action: 'updated', commentId: existing.id };
            }

            const created = await this.codeManagementService.createIssueComment(
                {
                    organizationAndTeamData: input.organizationAndTeamData,
                    prNumber: input.prNumber,
                    repository: input.repository,
                    body,
                },
            );

            return { action: 'created', commentId: created?.id };
        } catch (error) {
            // A review must not fail because a comment could not be posted.
            this.logger.warn({
                message: `Failed to post the Kodus Trace comment on PR#${input.prNumber}`,
                context: PostTracePrCommentUseCase.name,
                error,
                metadata: {
                    organizationAndTeamData: input.organizationAndTeamData,
                    prNumber: input.prNumber,
                },
            });
            return { action: 'skipped', reason: 'error' };
        }
    }

    private async findExistingComment(
        input: PostTracePrCommentInput,
    ): Promise<{ id: number } | null> {
        const comments =
            (await this.codeManagementService.getAllCommentsInPullRequest({
                organizationAndTeamData: input.organizationAndTeamData,
                prNumber: input.prNumber,
                repository: input.repository,
            })) ?? [];

        const match = comments.find((comment) =>
            commentBody(comment).includes(TRACE_COMMENT_MARKER),
        );

        if (!match) {
            return null;
        }

        const id = match.id ?? match.commentId ?? match.note_id;
        return typeof id === 'number' ? { id } : null;
    }
}

function commentBody(comment: Record<string, unknown>): string {
    const candidate = comment?.body ?? comment?.note ?? comment?.content;
    return typeof candidate === 'string' ? candidate : '';
}

export function renderTraceComment(
    decisions: TraceContextDecision[],
): string {
    const grouped = new Map<string, TraceContextDecision[]>();
    for (const decision of decisions) {
        const key = decision.type ?? 'other';
        grouped.set(key, [...(grouped.get(key) ?? []), decision]);
    }

    const sections: string[] = [];
    for (const [type, items] of [...grouped.entries()].sort()) {
        sections.push(`**${humanizeType(type)}**`);
        sections.push('');
        for (const item of items) {
            const details: string[] = [`- ${item.decision.trim()}`];
            if (item.rationale?.trim()) {
                details.push(`  - _why:_ ${item.rationale.trim()}`);
            }
            if (item.scope?.length) {
                details.push(
                    `  - _scope:_ ${item.scope
                        .map((entry) => `\`${entry}\``)
                        .join(', ')}`,
                );
            }
            sections.push(details.join('\n'));
        }
        sections.push('');
    }

    return [
        TRACE_COMMENT_MARKER,
        '## Why this changed',
        '',
        'Captured by Kodus Trace from the agent sessions behind this pull request.',
        '',
        ...sections,
        '<sub>Run `kodus trace <path>` to read these from your terminal. `kodus trace forget <id>` removes one that is wrong.</sub>',
    ].join('\n');
}

function humanizeType(type: string): string {
    return type
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}
