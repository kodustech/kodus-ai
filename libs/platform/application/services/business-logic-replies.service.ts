import { Injectable } from '@nestjs/common';

import { BusinessValidationService } from '@libs/agents/business-validation/business-validation.service';
import type { BusinessValidationRequest } from '@libs/agents/business-validation/business-validation.types';
import { taskPasses } from '@libs/agents/business-validation/check-policy';
import type { OpenFinding } from '@libs/agents/business-validation/judge/reply-classifier';
import type {
    Acceptance,
    RequirementVerdict,
} from '@libs/agents/business-validation/judge/validation.types';
import { deriveStatus } from '@libs/agents/business-validation/judge/validation-verdict';
import { outcomeFromRun } from '@libs/agents/business-validation/runs/run-mapping';
import type { RunTask } from '@libs/agents/business-validation/runs/validation-run.model';
import {
    type ValidationRunRecord,
    ValidationRunRepository,
} from '@libs/agents/business-validation/runs/validation-run.repository';
import { createLogger } from '@libs/core/log/logger';

import { BusinessLogicPublisher } from './business-logic-publisher.service';

export interface BusinessLogicReplyInput {
    request: Omit<BusinessValidationRequest, 'door'>;
    message: string;
    sender: { login: string };
    /** The PR author, who can't waive their own requirements. */
    authorLogin?: string;
}

export type BusinessLogicReplyResult =
    { handled: false } | { handled: true; reply: string };

interface Located {
    finding: OpenFinding;
    task: RunTask;
    requirement?: RequirementVerdict;
    changeIndex?: number;
}

/**
 * Replies to the Business Logic comment that decide something:
 *
 * - a reviewer waives a finding, e.g. "moved to SAA-102" (UC-37). Never the
 *   PR author: they can ask for a re-check, but only someone else waives;
 * - the author says the code already covers it (UC-38). Kody re-checks with
 *   what they pointed at, then keeps or changes the state and says why.
 *
 * Anything else, questions included, is not handled here.
 */
@Injectable()
export class BusinessLogicReplies {
    private readonly logger = createLogger(BusinessLogicReplies.name);

    constructor(
        private readonly businessValidationService: BusinessValidationService,
        private readonly publisher: BusinessLogicPublisher,
        private readonly runs: ValidationRunRepository,
    ) {}

    async handle(
        input: BusinessLogicReplyInput,
    ): Promise<BusinessLogicReplyResult> {
        const { request } = input;
        if (!request.repository || !request.pullRequest) {
            return { handled: false };
        }
        const run = await this.runs
            .latestForPullRequest({
                organizationId: request.organizationAndTeamData.organizationId,
                repositoryId: request.repository.id,
                pullRequestNumber: request.pullRequest.number,
                outcome: 'validated',
            })
            .catch(() => undefined);
        if (!run?.comment) {
            return { handled: false };
        }
        const open = openFindings(run);
        if (!open.length) {
            return { handled: false };
        }

        const intent = await this.businessValidationService.classifyReply(
            request.organizationAndTeamData,
            input.message,
            open.map((o) => o.finding),
        );
        if (intent.intent === 'other') {
            return { handled: false };
        }
        const chosen = open.filter((o) =>
            intent.findings.includes(o.finding.index),
        );

        try {
            if (intent.intent === 'accept') {
                return await this.accept(input, run, chosen, intent);
            }
            return await this.dispute(input, run, chosen, intent);
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not apply a reply to the business logic comment',
                context: BusinessLogicReplies.name,
                error,
                metadata: {
                    organizationId:
                        request.organizationAndTeamData.organizationId,
                    prNumber: request.pullRequest.number,
                },
            });
            return { handled: false };
        }
    }

    private async accept(
        input: BusinessLogicReplyInput,
        run: ValidationRunRecord,
        chosen: Located[],
        intent: { movedTo?: string; reason?: string },
    ): Promise<BusinessLogicReplyResult> {
        const { request } = input;
        const say = (text: string) =>
            this.businessValidationService.inTeamLanguage(
                request.organizationAndTeamData,
                text,
            );
        const isAuthor =
            !!input.authorLogin &&
            input.authorLogin.toLowerCase() ===
                input.sender.login.toLowerCase();
        if (isAuthor) {
            return {
                handled: true,
                reply: await say(
                    `Only a reviewer or maintainer can accept a requirement, not the PR author. If the code already covers it, say where and I'll re-check; or comment \`@kody -v business-logic\` after a fix.`,
                ),
            };
        }

        const settings = await this.publisher.settingsFor(
            request.organizationAndTeamData,
            request.repository!.id,
        );
        if (intent.movedTo) {
            const exists = await this.businessValidationService.tryRead(
                request.organizationAndTeamData,
                intent.movedTo,
                settings,
            );
            if (exists.status !== 'found') {
                return {
                    handled: true,
                    reply: await say(
                        `I couldn't find ${intent.movedTo} in the task tracker, so nothing was accepted. Check the id and reply again.`,
                    ),
                };
            }
        }

        const acceptance: Acceptance = {
            by: input.sender.login,
            ...(intent.reason ? { reason: intent.reason } : {}),
            ...(intent.movedTo ? { movedTo: intent.movedTo } : {}),
            at: new Date().toISOString(),
        };
        const tasks = run.tasks.map((task) => {
            const mine = chosen.filter((c) => c.task.id === task.id);
            if (!mine.length) {
                return task;
            }
            const requirements = task.requirements.map((r) =>
                mine.some((c) => c.requirement === r)
                    ? { ...r, accepted: acceptance }
                    : r,
            );
            const outOfScope = task.outOfScope.map((c, i) =>
                mine.some((m) => m.changeIndex === i)
                    ? { ...c, accepted: acceptance }
                    : c,
            );
            const verdict = {
                needsMoreInfo: false,
                summary: '',
                requirements,
                outOfScope,
                scopeMismatch: task.scopeMismatch,
                ...deriveStatus({
                    requirements,
                    outOfScope,
                    scopeMismatch: task.scopeMismatch,
                }),
            };
            return {
                ...task,
                requirements,
                outOfScope,
                passed: taskPasses(verdict, settings.failOn, task.intent),
            };
        });

        const outcome = outcomeFromRun(tasks, run.unseenFiles);
        const published = await this.publisher.publish({
            request: { ...request, door: 'command' },
            result: {
                outcome,
                references: [],
                attempts: [],
                trackers: run.trackers,
            },
            settings,
            trigger: 'accepted',
            headSha: run.headSha,
        });
        const names = chosen.map((c) => `“${c.finding.text}”`).join(', ');
        const passed =
            published.outcome.kind === 'validated' && published.outcome.passed;
        return {
            handled: true,
            reply: await say(
                [
                    `Got it.${intent.movedTo ? ` ${intent.movedTo} exists,` : ''} I marked ${names} as accepted by @${input.sender.login} and updated the table above.`,
                    passed
                        ? 'The kody/business-logic check is now green. This decision is recorded on the PR.'
                        : 'Other findings still keep the kody/business-logic check from passing.',
                ].join(' '),
            ),
        };
    }

    private async dispute(
        input: BusinessLogicReplyInput,
        run: ValidationRunRecord,
        chosen: Located[],
        intent: { files: string[]; claim: string },
    ): Promise<BusinessLogicReplyResult> {
        const { request } = input;
        const settings = await this.publisher.settingsFor(
            request.organizationAndTeamData,
            request.repository!.id,
        );
        const disputed = chosen
            .filter((c) => c.requirement)
            .map((c) => c.requirement!.requirement);
        const fullRequest: BusinessValidationRequest = {
            ...request,
            door: 'command',
            // The task(s) the comment was about, not whatever the PR says now.
            taskInput: run.tasks.map((t) => t.id).join(' '),
            settings,
            authorClaim: {
                claim: intent.claim || input.message,
                requirements: disputed,
                files: intent.files,
            },
        };
        const result =
            await this.businessValidationService.validate(fullRequest);
        if (result.outcome.kind === 'validated') {
            for (const check of result.outcome.checks) {
                for (const r of check.verdict.requirements ?? []) {
                    if (disputed.some((d) => sameText(d, r.requirement))) {
                        r.disputed =
                            r.state === 'met' ? 'overturned' : 'upheld';
                    }
                }
            }
        }
        const published = await this.publisher.publish({
            request: fullRequest,
            result,
            settings,
            trigger: 'command',
            headSha: await this.publisher.headShaOf(
                request.organizationAndTeamData,
                { id: request.repository!.id, name: request.repository!.name },
                request.pullRequest!.number,
                request.platformType,
            ),
        });

        const outcome = published.outcome;
        if (outcome.kind !== 'validated') {
            return {
                handled: true,
                reply:
                    outcome.kind === 'skipped'
                        ? outcome.message
                        : 'I re-checked, and the Business Logic comment above is updated.',
            };
        }
        const lines = outcome.checks.flatMap((check) =>
            (check.verdict.requirements ?? [])
                .filter((r) => disputed.some((d) => sameText(d, r.requirement)))
                .map((r) =>
                    r.state === 'met'
                        ? `- “${r.requirement}”: you're right, ${r.evidence[0] ? `\`${r.evidence[0].file}${r.evidence[0].line ? `:${r.evidence[0].line}` : ''}\` covers it` : 'the diff covers it'}. Marked MET.`
                        : `- “${r.requirement}”: still ${r.state.replace('_', ' ').toUpperCase()}. ${r.note ?? ''}`.trim(),
                ),
        );
        return {
            handled: true,
            reply: await this.businessValidationService.inTeamLanguage(
                request.organizationAndTeamData,
                [
                    `I re-checked${intent.files.length ? ` ${intent.files.map((f) => `\`${f}\``).join(', ')}` : ''}:`,
                    ...lines,
                    '',
                    'The Business Logic comment above is updated. Someone other than the author can accept a requirement that stays open.',
                ].join('\n'),
            ),
        };
    }
}

/** The findings a reply can act on: open requirements and unaccepted changes, numbered. */
function openFindings(run: ValidationRunRecord): Located[] {
    const located: Located[] = [];
    for (const task of run.tasks) {
        for (const requirement of task.requirements) {
            if (requirement.accepted || requirement.state === 'met') {
                continue;
            }
            located.push({
                finding: {
                    index: located.length + 1,
                    taskId: task.id,
                    kind: 'requirement',
                    text: requirement.requirement,
                    state: requirement.state,
                },
                task,
                requirement,
            });
        }
        task.outOfScope.forEach((change, changeIndex) => {
            if (change.accepted) {
                return;
            }
            located.push({
                finding: {
                    index: located.length + 1,
                    taskId: task.id,
                    kind: 'not_in_task',
                    text: change.change,
                    state: 'not_in_task',
                },
                task,
                changeIndex,
            });
        });
    }
    return located;
}

function sameText(a: string, b: string): boolean {
    const norm = (t: string) =>
        t
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .trim();
    return norm(a) === norm(b);
}
