import { createLogger, createThreadId } from '@kodus/flow';
import { BusinessRulesValidationAgentProvider } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/businessRulesValidationAgent';
import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { PipelineError } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-context.interface';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { ISuggestionByPR } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

/**
 * Validates that the code in the PR matches the business requirements
 * declared in the PR description (linked tickets, requirement keywords).
 *
 * Surface as a top-level pipeline stage in the agent (v4) engine so the
 * UI can show what happened: ran with a gap, ran clean, or skipped with
 * a concrete reason (no ticket link, feature off, unchanged description).
 *
 * In the legacy EE engine this is still done inside
 * ProcessFilesPrLevelReviewStage alongside kody rules and cross-file
 * analysis. Once the EE engine is retired this can become the sole owner.
 */
@Injectable()
export class BusinessLogicValidationStage extends BasePipelineStage<CodeReviewPipelineContext> {
    private readonly logger = createLogger(BusinessLogicValidationStage.name);
    readonly stageName = 'BusinessLogicValidationStage';
    readonly label = 'Validating Business Logic';
    readonly visibility = StageVisibility.PRIMARY;
    readonly errorSeverity = 'partial' as const;

    private static readonly REQUIREMENT_KEYWORDS = [
        'requirement',
        'acceptance criteria',
        'user story',
        'given',
        'when',
        'then',
    ];
    private static readonly TIMEOUT_MS = 300_000; // 5 min

    private static readonly TASK_MANAGEMENT_HINTS = [
        'jira',
        'linear',
        'notion',
        'clickup',
        'googledocs',
        'atlassianrovo',
        'githubissues',
    ];

    /** Maps task-management MCP names to URL domain patterns.
     *  If a URL in the PR description contains one of these domains,
     *  it's considered a valid signal for that MCP. */
    private static readonly MCP_URL_PATTERNS: Record<string, string[]> = {
        jira: ['atlassian.net', 'jira.'],
        linear: ['linear.app'],
        notion: ['notion.so', 'notion.site'],
        clickup: ['clickup.com'],
        googledocs: ['docs.google.com'],
        githubissues: ['github.com'],
        atlassianrovo: ['atlassian.net'],
    };

    constructor(
        private readonly businessRulesValidationAgentProvider: BusinessRulesValidationAgentProvider,
        private readonly mcpManagerService: MCPManagerService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        // IMPORTANT: do NOT mutate context.statusInfo from this stage.
        // The pipeline executor treats statusInfo.status === SKIPPED as
        // "abort the pipeline" / start jump-to-stage logic. Setting it
        // here would skip every stage downstream (CreateSandbox,
        // AgentReview, ValidateSuggestions, ...). Instead, surface the
        // outcome via logs + the businessLogicOutcome field that the
        // observer can pick up for per-stage UI metadata.
        const skipDecision = await this.evaluateSkip(context);
        if (skipDecision) {
            this.logger.log({
                message: `[BUSINESS-LOGIC] Skipped: ${skipDecision.message}`,
                context: this.stageName,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    prNumber: context.pullRequest?.number,
                    reason: skipDecision.reason,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.businessLogicResults = [];
                draft.businessLogicOutcome = {
                    kind: 'skipped',
                    reason: skipDecision.reason,
                    message: skipDecision.message,
                };
            });
        }

        const prBody = context.pullRequest?.body ?? '';
        const signalSources = this.buildSignalSources(context);

        const prBodyHash = this.computePrBodyHash(prBody);
        const signals = this.detectSignals(signalSources, prBody);

        try {
            const prepareContext = {
                userQuestion: '@kody -v business-logic',
                pullRequest: {
                    pullRequestNumber: context.pullRequest.number,
                    headRef: context.pullRequest?.head?.ref,
                    baseRef: context.pullRequest?.base?.ref,
                },
                repository: context.repository,
                pullRequestDescription: prBody,
                platformType: context.platformType,
                defaultBranch: context.pullRequest?.base?.ref,
                businessSignals: signals,
            };
            const thread = this.createBusinessLogicThread(context);

            const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new Error('BusinessLogicValidation timeout')),
                    BusinessLogicValidationStage.TIMEOUT_MS,
                ),
            );

            const agentPromise =
                this.businessRulesValidationAgentProvider.execute({
                    organizationAndTeamData: context.organizationAndTeamData,
                    prepareContext,
                    thread,
                    // Per-repo/directory model override resolved by ValidateConfigStage.
                    byokModel: context.codeReviewConfig?.byokModel,
                });

            const result = await Promise.race([agentPromise, timeoutPromise]);

            // No task-management MCP connected — treat as if the category
            // were disabled: skip silently, no PR comment.
            if (
                result ===
                BusinessRulesValidationAgentProvider.NO_TASK_MCP_SENTINEL
            ) {
                this.logger.log({
                    message:
                        '[BUSINESS-LOGIC] Skipped — no task-management MCP connected.',
                    context: this.stageName,
                    metadata: {
                        organizationId:
                            context.organizationAndTeamData?.organizationId,
                        prNumber: context.pullRequest?.number,
                    },
                });

                return this.updateContext(context, (draft) => {
                    draft.businessLogicResults = [];
                    draft.businessLogicOutcome = {
                        kind: 'skipped',
                        reason: 'no_task_mcp',
                        message: 'Skipped: no task-management MCP connected.',
                    };
                });
            }

            const classification = this.classifyResult(result);

            if (classification.kind === 'limitation') {
                this.logger.warn({
                    message: `[BUSINESS-LOGIC] Skipped — agent could not validate: ${classification.message}`,
                    context: this.stageName,
                    metadata: {
                        organizationId:
                            context.organizationAndTeamData?.organizationId,
                        prNumber: context.pullRequest?.number,
                        outcome: classification.kind,
                        reason: 'agent_limitation',
                        agentResponsePreview: this.firstNonEmptyLine(result),
                        signals,
                    },
                });

                // Only post to the PR when the limitation is about weak
                // task context — the user can improve the task description.
                // All other limitations (MCP missing, auth error, diff
                // unavailable, etc.) are silenced.
                if (this.isWeakTaskContext(result)) {
                    const limitationSuggestion: ISuggestionByPR = {
                        id: uuidv4(),
                        suggestionContent: result,
                        oneSentenceSummary:
                            'Task description is insufficient for business logic validation.',
                        label: LabelType.BUSINESS_LOGIC,
                        severity: SeverityLevel.MEDIUM,
                        deliveryStatus: DeliveryStatus.NOT_SENT,
                    };

                    return this.updateContext(context, (draft) => {
                        draft.businessLogicResults = [limitationSuggestion];
                        draft.businessLogicOutcome = {
                            kind: 'skipped',
                            reason: 'weak_task_context',
                            message: `Skipped: task context is too weak for validation (${classification.message}).`,
                        };
                    });
                }

                return this.updateContext(context, (draft) => {
                    draft.businessLogicResults = [];
                    draft.businessLogicOutcome = {
                        kind: 'skipped',
                        reason: 'agent_limitation',
                        message: `Skipped: business logic validation could not run (${classification.message}).`,
                    };
                });
            }

            this.logger.log({
                message: `[BUSINESS-LOGIC] Validation finished (outcome=${classification.kind})`,
                context: this.stageName,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    prNumber: context.pullRequest?.number,
                    outcome: classification.kind,
                    signals,
                },
            });

            if (classification.kind === 'no_gap') {
                const noGapSuggestion: ISuggestionByPR = {
                    id: uuidv4(),
                    suggestionContent: result,
                    oneSentenceSummary:
                        'Business logic validation passed — PR aligns with task requirements.',
                    label: LabelType.BUSINESS_LOGIC,
                    severity: SeverityLevel.LOW,
                    deliveryStatus: DeliveryStatus.NOT_SENT,
                };

                return this.updateContext(context, (draft) => {
                    draft.businessLogicResults = [noGapSuggestion];
                    draft.businessLogicPrBodyHash = prBodyHash;
                    draft.businessLogicOutcome = {
                        kind: 'success',
                        message:
                            'PR aligns with the requirements stated in the description.',
                    };
                });
            }

            const suggestion: ISuggestionByPR = {
                id: uuidv4(),
                suggestionContent: result,
                oneSentenceSummary:
                    'Business logic gap detected based on PR requirements.',
                label: LabelType.BUSINESS_LOGIC,
                severity: SeverityLevel.MEDIUM,
                deliveryStatus: DeliveryStatus.NOT_SENT,
            };

            return this.updateContext(context, (draft) => {
                draft.businessLogicResults = [suggestion];
                draft.businessLogicPrBodyHash = prBodyHash;
                draft.businessLogicOutcome = {
                    kind: 'gap_found',
                    message:
                        'Business logic gap detected — see PR-level comment.',
                };
            });
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);

            this.logger.error({
                message: `[BUSINESS-LOGIC] Validation failed for PR#${context.pullRequest?.number}: ${message}`,
                context: this.stageName,
                error,
            });

            const pipelineError: PipelineError = {
                stage: this.stageName,
                substage: 'BusinessRulesValidationAgent',
                error:
                    error instanceof Error ? error : new Error(String(error)),
                metadata: { prNumber: context.pullRequest?.number },
            };

            return this.updateContext(context, (draft) => {
                draft.businessLogicResults = [];
                draft.errors.push(pipelineError);
                draft.businessLogicOutcome = {
                    kind: 'error',
                    message: `Business logic validation failed: ${message}`,
                };
            });
        }
    }

    private async evaluateSkip(
        context: CodeReviewPipelineContext,
    ): Promise<{ reason: string; message: string } | null> {
        if (!context?.organizationAndTeamData) {
            return {
                reason: 'missing_org',
                message: 'Missing organization context.',
            };
        }
        if (!context?.pullRequest?.number) {
            return {
                reason: 'missing_pr',
                message: 'Missing pull request data.',
            };
        }
        if (!context?.repository?.id) {
            return {
                reason: 'missing_repo',
                message: 'Missing repository data.',
            };
        }

        if (!context.codeReviewConfig?.reviewOptions?.business_logic) {
            return {
                reason: 'option_off',
                message:
                    'Business logic validation is disabled in the code review configuration.',
            };
        }

        const connectedMcps =
            await this.getConnectedTaskManagementMcps(context);

        if (connectedMcps.length === 0) {
            return {
                reason: 'no_task_mcp',
                message:
                    'Skipped: no task-management MCP connected (Jira, Linear, Notion, ClickUp, etc.).',
            };
        }

        const prBody = context.pullRequest?.body ?? '';
        const signalSources = this.buildSignalSources(context);

        if (!this.hasRelevantBusinessSignals(signalSources, connectedMcps)) {
            return {
                reason: 'no_signals',
                message:
                    'Skipped: no ticket key or task link matching a connected MCP found in the PR description, title or branch name.',
            };
        }

        const currentHash = this.computePrBodyHash(prBody);
        const lastHash = (context.pipelineMetadata?.lastExecution as any)
            ?.businessLogicHash;
        if (lastHash && lastHash === currentHash) {
            return {
                reason: 'unchanged_body',
                message:
                    'Skipped: PR description has not changed since the last review.',
            };
        }

        return null;
    }

    /**
     * Build the combined text surface (body + title + branch name) used for
     * ticket-key and task-link detection. GitLab / GitHub already render
     * ticket references found in the title as hot-links, so requiring them in
     * the body would skip validation in the most common real-world case.
     */
    private buildSignalSources(context: CodeReviewPipelineContext): string {
        const body = context.pullRequest?.body ?? '';
        const title = context.pullRequest?.title ?? '';
        const branch = context.pullRequest?.head?.ref ?? '';
        return [body, title, branch].filter(Boolean).join(' ');
    }

    /**
     * Ticket keys and task URLs may legitimately come from the PR title or
     * branch name. Requirement keywords (`when`, `then`, ...) stay scoped to
     * the body — they double as common English words that would false-positive
     * on titles like "Fix crash when user clicks save".
     */
    private detectSignals(
        combined: string,
        body: string,
    ): Record<string, string[]> {
        return {
            ticketKeys: this.detectTicketKeys(combined),
            taskLinks: this.detectTaskLinks(combined),
            requirementKeywords: this.detectRequirementKeywords(body),
        };
    }

    /**
     * Returns the normalized names of connected task-management MCPs
     * (e.g. ['jira', 'linear']). Empty array = none connected.
     */
    private async getConnectedTaskManagementMcps(
        context: CodeReviewPipelineContext,
    ): Promise<string[]> {
        try {
            const allConnections = await this.mcpManagerService.getConnections(
                context.organizationAndTeamData,
                false,
            );

            const orgId = context.organizationAndTeamData?.organizationId;
            const connections = (allConnections ?? []).filter(
                (c) => c.organizationId === orgId,
            );

            const matched: string[] = [];

            for (const conn of connections) {
                const aliases = [conn.appName, conn.provider]
                    .map((v) =>
                        typeof v === 'string'
                            ? v
                                  .trim()
                                  .toLowerCase()
                                  .replace(/[^a-z0-9]+/g, '')
                            : '',
                    )
                    .filter(Boolean);

                for (const alias of aliases) {
                    const hint =
                        BusinessLogicValidationStage.TASK_MANAGEMENT_HINTS.find(
                            (h) => alias.includes(h) || h.includes(alias),
                        );
                    if (hint && !matched.includes(hint)) {
                        matched.push(hint);
                    }
                }
            }

            return matched;
        } catch (error) {
            this.logger.warn({
                message: `[BUSINESS-LOGIC] Failed to fetch MCP connections: ${error instanceof Error ? error.message : String(error)}`,
                context: this.stageName,
                error,
            });
            return [];
        }
    }

    /**
     * Returns true when the PR description contains business signals
     * (ticket keys or URLs) that match a connected task-management MCP.
     * Random URLs like bananinha.com are ignored if no MCP matches.
     */
    private hasRelevantBusinessSignals(
        body: string,
        connectedMcps: string[],
    ): boolean {
        // Ticket keys (e.g. KAN-1) are valid if any MCP that handles
        // tickets is connected (jira, linear, clickup, githubissues).
        const ticketKeys = this.detectTicketKeys(body);
        const ticketMcps = ['jira', 'linear', 'clickup', 'githubissues'];
        if (
            ticketKeys.length > 0 &&
            connectedMcps.some((mcp) => ticketMcps.includes(mcp))
        ) {
            return true;
        }

        // URLs are valid only if they match the domain pattern of a
        // connected MCP.
        const urls = this.detectTaskLinks(body);
        for (const url of urls) {
            const lower = url.toLowerCase();
            for (const mcp of connectedMcps) {
                const patterns =
                    BusinessLogicValidationStage.MCP_URL_PATTERNS[mcp] ?? [];
                if (patterns.some((pattern) => lower.includes(pattern))) {
                    return true;
                }
            }
        }

        return false;
    }

    private detectTicketKeys(body: string): string[] {
        const matches = body.match(/[A-Za-z]{2,}-\d+/g) ?? [];
        return Array.from(new Set(matches.map((m) => m.toUpperCase())));
    }

    private detectTaskLinks(body: string): string[] {
        const matches = body.match(/https?:\/\/[^\s)>\]"']+/g);
        return matches ?? [];
    }

    private detectRequirementKeywords(body: string): string[] {
        const lower = body.toLowerCase();
        return BusinessLogicValidationStage.REQUIREMENT_KEYWORDS.filter((kw) =>
            lower.includes(kw),
        );
    }

    private computePrBodyHash(body: string): string {
        return crypto.createHash('sha256').update(body).digest('hex');
    }

    /**
     * Classify the agent's output into one of three outcomes:
     *  - 'gap_found'  → a real business-logic gap was detected
     *  - 'no_gap'     → the PR is aligned with the requirements
     *  - 'limitation' → the agent could not validate (MCP down, missing
     *                   task context, etc.). This MUST NOT be reported as
     *                   success — the UI would claim the review passed
     *                   when no validation actually ran.
     */
    private classifyResult(
        result: string,
    ):
        | { kind: 'gap_found' }
        | { kind: 'no_gap' }
        | { kind: 'limitation'; message: string } {
        if (!result || result.trim().length === 0) {
            return {
                kind: 'limitation',
                message: 'Business logic agent returned an empty response.',
            };
        }

        const lower = result.toLowerCase();
        const limitationIndicators = [
            'need task information',
            'need pull request diff',
            'insufficient task context',
            'limited task context',
            'could not validate',
            'without the actual code changes, i can',
            'preciso do diff da pull request',
            'preciso de informacoes da task',
            'contexto insuficiente da task',
            'contexto limitado da task',
            'nao consegui validar',
            'sem as alteracoes de codigo',
            'mcp connection failed',
            'mcp integration required',
            'no compatible mcp integration',
        ];
        for (const indicator of limitationIndicators) {
            if (lower.includes(indicator)) {
                return {
                    kind: 'limitation',
                    message: this.firstNonEmptyLine(result),
                };
            }
        }

        const noGapIndicators = [
            'no gaps',
            'no issues',
            'fully compliant',
            'no business logic gap',
            'all requirements met',
            'implementation is complete',
            'no violations',
            '✅ compliant',
            'status: ✅',
            'sem bloqueios identificados',
            'requirements covered',
            '"needsmoreinfo": false',
        ];
        if (noGapIndicators.some((indicator) => lower.includes(indicator))) {
            return { kind: 'no_gap' };
        }

        return { kind: 'gap_found' };
    }

    /**
     * Returns true when the limitation is specifically about the task
     * description being too weak / incomplete — the one case where we
     * still want to surface feedback on the PR so the author knows the
     * task needs better acceptance criteria.
     *
     * Detection is based on a structured marker embedded by the agent
     * provider, not on natural-language matching (which would break
     * across locales).
     */
    private isWeakTaskContext(result: string): boolean {
        if (!result) return false;
        return result.includes(
            BusinessRulesValidationAgentProvider.WEAK_TASK_CONTEXT_MARKER,
        );
    }

    private firstNonEmptyLine(text: string): string {
        for (const line of text.split('\n')) {
            // Strip markdown heading markers, leading emoji, and trailing
            // colons so the message reads as a plain sentence when embedded
            // into logs and UI status messages.
            const trimmed = line
                .replace(/^\s*#{1,6}\s*/, '')
                .replace(
                    /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*/u,
                    '',
                )
                .replace(/\s*[:：]\s*$/, '')
                .trim();
            if (trimmed) {
                return trimmed.length > 240
                    ? trimmed.slice(0, 237) + '…'
                    : trimmed;
            }
        }
        return text.slice(0, 240);
    }

    private createBusinessLogicThread(context: CodeReviewPipelineContext) {
        try {
            const identifiers: Record<string, string | number> = {
                organizationId: context.organizationAndTeamData.organizationId,
                teamId: context.organizationAndTeamData.teamId,
                repositoryId: context.repository.id,
                pullRequestNumber: context.pullRequest.number,
            };

            if (context.userGitId) {
                identifiers.userId = context.userGitId;
            }

            return createThreadId(identifiers, { prefix: 'vbl' });
        } catch (error) {
            this.logger.warn({
                message: `Failed to create business logic thread for PR#${context.pullRequest?.number}`,
                context: this.stageName,
                error,
            });
            return undefined;
        }
    }
}
