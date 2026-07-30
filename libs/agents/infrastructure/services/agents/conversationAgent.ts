import { BYOKConfig } from '@kodus/kodus-common/llm';
import { type Tool, type LanguageModel } from 'ai';
import { Inject, Injectable, Optional } from '@nestjs/common';

import type { AgentSpec } from '@libs/agent-harness/domain/contracts/agent.contract';
import type {
    ConversationStore,
    ToolContext,
} from '@libs/agent-harness/domain/contracts';
import { CONVERSATION_STORE_TOKEN } from '@libs/agents/infrastructure/persistence/mongo-conversation-store';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { AiSdkToolRegistry } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-tool-registry';
import { finalText } from '@libs/agent-harness/domain/run-state.util';

import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';

import { buildLangfuseTelemetry } from '@libs/core/log/langfuse';
import { createLogger } from '@libs/core/log/logger';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { resolveAgentModel } from '@libs/llm/agent-model';
import { createAgentRunContext } from '@libs/llm/agent-run-context';
import { buildProviderOptions } from '@libs/llm/reasoning-options';
import { ByokErrorCounter } from '@libs/notifications/application/byok-error-counter.service';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';
import { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

import { connectMcpTools } from '../ai-sdk/mcp-tools';
import { buildNativeTools } from '../ai-sdk/native-tools';
import {
    CONVERSATION_FALLBACK_MESSAGE,
    CONVERSATION_PROVIDER_ERROR_MESSAGE,
    normalizeConversationResponse,
} from './conversation-response.util';

/**
 * Upper bound on the ReAct tool-calling loop. Replaces the legacy
 * `replanPolicy.maxReplans` — the AI SDK runs native tool calling and we stop
 * after this many steps (`stepCountIs`). Generous enough for multi-tool repo
 * exploration, bounded so a stuck loop can't run away.
 */
const CONVERSATION_MAX_STEPS = 12;

/**
 * Thread identifier passed by the caller. Structurally compatible with the
 * legacy flow engine's `Thread` ({ id, metadata }) but typed locally so this
 * agent has no flow-engine dependency. Used only for log correlation now —
 * the conversation history travels in `prepareContext` (rebuilt from the PR
 * comment thread), not in any flow-managed session store.
 */
interface ConversationThread {
    id?: unknown;
    metadata?: Record<string, unknown>;
}

/**
 * Conversation agent ("chat with Kody") rebuilt on the Vercel AI SDK.
 *
 * Replaces the former flow-engine orchestration (createOrchestration +
 * REACT planner + createMCPAdapter + createTool + callAgent) with a thin
 * native loop: `byokToVercelModel` resolves the BYOK model, MCP + sandbox
 * tools are exposed as AI SDK tools, and `generateText` runs the tool-calling
 * loop until it answers or hits `CONVERSATION_MAX_STEPS`.
 */
@Injectable()
export class ConversationAgentProvider {
    private readonly logger = createLogger(ConversationAgentProvider.name);

    private readonly defaultLLMConfig = {
        // No fixed temperature on purpose: some BYOK models reject anything but
        // their default (e.g. kimi-k2.7-code → "invalid temperature: only 1 is
        // allowed for this model"), which made every call return 0 tokens and
        // fall back. Omitting it lets each provider use its valid default — and
        // a non-zero temperature is fine for natural conversation anyway. The
        // code-review finder omits it for the same reason.
        maxTokens: 20000,
    };

    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly permissionValidationService: PermissionValidationService,
        private readonly observabilityService: ObservabilityService,
        private readonly mcpManagerService?: MCPManagerService,
        @Optional() private readonly byokErrorCounter?: ByokErrorCounter,
        // Conversation record (kodus-agent-sessions). Optional so callers that
        // don't bind it (tests, lean wirings) still construct the agent.
        @Optional()
        @Inject(CONVERSATION_STORE_TOKEN)
        private readonly conversationStore?: ConversationStore,
    ) {}

    async execute(
        prompt: string,
        context?: {
            organizationAndTeamData: OrganizationAndTeamData;
            prepareContext?: any;
            thread?: ConversationThread;
            sandbox?: SandboxInstance;
        },
    ): Promise<string> {
        const { organizationAndTeamData, prepareContext, thread, sandbox } =
            context || ({} as any);

        if (!organizationAndTeamData?.organizationId) {
            throw new Error(
                'Organization and team data with organizationId is required.',
            );
        }

        if (!thread) {
            throw new Error('thread and team data is required.');
        }

        const userLanguage = await this.getLanguage(organizationAndTeamData);

        this.logger.log({
            message: 'Starting conversation agent execution',
            context: ConversationAgentProvider.name,
            serviceName: ConversationAgentProvider.name,
            metadata: { organizationAndTeamData, thread, userLanguage },
        });

        const byokConfig = await this.resolveBYOKConfig(organizationAndTeamData);
        // Standard model setup (same as every agent): BYOK resolve + concurrency
        // limiter + failure reporter.
        const model = resolveAgentModel(byokConfig, {
            organizationId: organizationAndTeamData.organizationId?.toString(),
            provider: byokConfig?.main?.provider,
            reporter: this.byokErrorCounter
                ? (e) => void this.byokErrorCounter!.record(e)
                : undefined,
        });

        // Per-call model params come straight from the org's saved BYOK config
        // (temperature / maxOutputTokens / reasoningEffort) — NOT hardcoded. The
        // old hardcoded `temperature: 0` overrode the config and broke models
        // that only accept their own value (e.g. kimi-k2.7-code wants 1).
        // `temperature` is passed through only when configured; omitting it lets
        // the provider use its valid default.
        const temperature = byokConfig?.main?.temperature;
        const maxOutputTokens =
            byokConfig?.main?.maxOutputTokens ?? this.defaultLLMConfig.maxTokens;

        // Thinking/reasoning budget. `buildProviderOptions` maps an effort tier
        // to the right per-provider shape (Gemini thinkingBudget/thinkingLevel,
        // Anthropic thinking, OpenAI reasoningEffort). The tier also comes from
        // the BYOK config (the org configured it).
        const providerOptions = buildProviderOptions('conversationAgent', undefined, {
            reasoningEffort: byokConfig?.main?.reasoningEffort ?? 'low',
            byokProvider: byokConfig?.main?.provider,
            modelName: byokConfig?.main?.model,
        });

        // Tools: MCP (memory, integrations) + native sandbox tools (grep,
        // readFile, listDir, exec). Both are plain AI SDK tools, carried into
        // the harness as-is by AiSdkToolRegistry (no schema round-trip).
        const mcp = await this.connectMcp(organizationAndTeamData);
        const tools: Record<string, Tool> = {
            ...mcp.tools,
            ...(sandbox ? buildNativeTools(sandbox) : {}),
        };
        // Whether the memory tool is actually available — gates the mandatory
        // memory bootstrap in the prompt (see buildUserPrompt). MCP offline ->
        // no tool -> don't command the model to call something that isn't there.
        const hasMemoryTool = 'KODUS_FIND_MEMORIES' in mcp.tools;

        // Single runtime: the conversation runs as an AgentSpec on the harness
        // AiSdkAgentRunner — the SAME loop/policies/observability seam as the
        // code-review finder. No `resultToolName` (free-form chat answer); the
        // final text is the last assistant turn in RunState. maxSteps applies
        // the ReAct stop bound the legacy `stopWhen: stepCountIs` did.
        const runner = new AiSdkAgentRunner({ resolve: () => model });
        const spec: AgentSpec = {
            id: 'conversation',
            systemPrompt: this.buildSystemPrompt(userLanguage),
            modelId: 'resolved',
            tools: new AiSdkToolRegistry(tools),
            policies: [],
            maxSteps: CONVERSATION_MAX_STEPS,
            ...(typeof temperature === 'number' ? { temperature } : {}),
            maxOutputTokens,
            ...(Object.keys(providerOptions).length ? { providerOptions } : {}),
        };

        // Standard run context: signal + hard timeout, same guarantee as the
        // code-review and business agents (a stuck run can't run forever).
        const { ctx, cleanup } = createAgentRunContext({
            runId: `conversation:${organizationAndTeamData.organizationId}`,
        });

        const startedAt = Date.now();
        try {
            const preparedPrompt = this.buildUserPrompt(
                prompt,
                userLanguage,
                prepareContext,
                organizationAndTeamData,
                hasMemoryTool,
                sandbox,
            );

            const state = await runner.run(
                spec,
                {
                    prompt: preparedPrompt,
                    // experimental_telemetry feeds Langfuse (forwarded verbatim
                    // by the runner).
                    telemetry: buildLangfuseTelemetry('conversationAgent', {
                        organizationId:
                            organizationAndTeamData.organizationId?.toString(),
                        teamId: organizationAndTeamData.teamId?.toString(),
                        repositoryId: prepareContext?.repository?.id?.toString(),
                        provider: byokConfig?.main?.provider,
                    }),
                },
                ctx,
            );

            // Cost -> Mongo `observability_telemetry` via the canonical emitter,
            // so the billing schema (agentName/phase/type/gen_ai.usage.*) is
            // identical to the code-review agents. Replaces the bespoke
            // runAiSdkLLMInSpan wrapper.
            const finishReason = state.stopReason ?? state.status;

            await this.observabilityService.recordAgentRunUsage({
                agentName: 'ConversationalAgent',
                phase: 'conversation',
                spanName: 'ConversationalAgent::conversationAgent',
                runName: 'conversationAgent',
                model: byokConfig?.main?.model,
                // Real billing source: a BYOK org runs on its own key -> 'byok'.
                // (The legacy code hardcoded 'system', misattributing BYOK cost.)
                isByok: !!byokConfig,
                usage: state.usage,
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                steps: state.steps.length,
                finishReason,
                source: 'harness',
                durationMs: Date.now() - startedAt,
            });

            const answer = finalText(state);

            this.logger.log({
                message: 'Finish conversation agent execution',
                context: ConversationAgentProvider.name,
                serviceName: ConversationAgentProvider.name,
                metadata: {
                    organizationAndTeamData,
                    thread,
                    steps: state.steps.length,
                    usage: state.usage,
                },
            });

            let response = normalizeConversationResponse(answer);

            // Never-empty guard — the lightweight equivalent of the legacy ReAct
            // `forceFinalAnswer`. When the main run yields nothing usable (e.g.
            // the model froze under the tool ceremony), retry ONCE with a
            // stripped, conversation-only prompt and no tools before giving up.
            if (response === null) {
                this.logger.warn({
                    message:
                        'Conversation agent produced no usable response; retrying minimal',
                    context: ConversationAgentProvider.name,
                    serviceName: ConversationAgentProvider.name,
                    metadata: {
                        organizationAndTeamData,
                        thread,
                        rawResult: answer,
                    },
                });
                response = await this.forceAnswer(
                    model,
                    userLanguage,
                    prompt,
                    ctx,
                    temperature,
                    maxOutputTokens,
                );
            }

            // The text the user actually sees: the agent's answer (possibly from
            // the minimal retry), or a fallback when both produced nothing
            // usable. A run that ENDED IN ERROR (provider down/blocked — zero
            // tokens) gets the technical-issue message, not the "add more
            // context" nudge, which would blame the user for an outage.
            const userFacing =
                response ??
                (finishReason === 'error'
                    ? CONVERSATION_PROVIDER_ERROR_MESSAGE
                    : CONVERSATION_FALLBACK_MESSAGE);

            // Persist the exchange to `kodus-agent-sessions` (best-effort —
            // never blocks the reply). Records the turn even when it fell back,
            // so the conversation record captures failed turns too. Keyed by the
            // caller's thread id; the user turn is the RAW prompt (not the
            // assembled context block).
            await this.persistConversationTurn(
                thread,
                prompt,
                userFacing,
                organizationAndTeamData,
                prepareContext,
            );

            return userFacing;
        } catch (error) {
            this.logger.error({
                message: 'Error during conversation agent execution',
                context: ConversationAgentProvider.name,
                serviceName: ConversationAgentProvider.name,
                metadata: { error, organizationAndTeamData, thread },
            });
            throw error;
        } finally {
            cleanup();
            await mcp.close();
        }
    }

    /**
     * Last-resort minimal answer pass — the lightweight equivalent of the
     * legacy ReAct `forceFinalAnswer`. When the main run returns nothing usable
     * (e.g. the model froze on the tool ceremony), retry ONCE with just the
     * system prompt and the raw user message: no tools, no PR context, single
     * step. Returns the normalized text, or null if it still produced nothing.
     */
    private async forceAnswer(
        model: LanguageModel,
        userLanguage: string,
        prompt: string,
        ctx: ToolContext,
        temperature: number | undefined,
        maxOutputTokens: number,
    ): Promise<string | null> {
        try {
            const runner = new AiSdkAgentRunner({ resolve: () => model });
            const spec: AgentSpec = {
                id: 'conversation-retry',
                systemPrompt: this.buildSystemPrompt(userLanguage),
                modelId: 'resolved',
                tools: new AiSdkToolRegistry({}),
                policies: [],
                maxSteps: 1,
                ...(typeof temperature === 'number' ? { temperature } : {}),
                maxOutputTokens,
            };

            const state = await runner.run(
                spec,
                {
                    prompt: `Reply to the user's message below. Write your reply in ${userLanguage} — do NOT switch to the language the user wrote in:\n\n${prompt}`,
                },
                ctx,
            );

            return normalizeConversationResponse(finalText(state));
        } catch (error) {
            this.logger.warn({
                message: 'Conversation retry (forceAnswer) failed',
                context: ConversationAgentProvider.name,
                error,
            });
            return null;
        }
    }

    /**
     * Append the user/assistant exchange to the conversation record
     * (`kodus-agent-sessions`) keyed by the thread id. Best-effort and fully
     * isolated: the store swallows its own errors, and this wrapper guards the
     * no-store / no-thread-id cases so a record failure can never affect the
     * reply that was already produced.
     */
    private async persistConversationTurn(
        thread: ConversationThread,
        userPrompt: string,
        assistantResponse: string,
        organizationAndTeamData: OrganizationAndTeamData,
        prepareContext: any,
    ): Promise<void> {
        if (!this.conversationStore) {
            return;
        }

        const threadId =
            thread?.id != null ? String(thread.id) : '';
        if (!threadId) {
            return;
        }

        const channel = thread?.metadata?.channel;

        await this.conversationStore.append(
            threadId,
            [
                { role: 'user', content: userPrompt },
                { role: 'assistant', content: assistantResponse },
            ],
            {
                organizationId:
                    organizationAndTeamData?.organizationId?.toString(),
                teamId: organizationAndTeamData?.teamId?.toString(),
                repositoryId: prepareContext?.repository?.id?.toString(),
                channel: typeof channel === 'string' ? channel : undefined,
            },
        );
    }

    /**
     * Resolve the BYOK config for the org. Mirrors the legacy base provider's
     * `fetchBYOKConfig` (without the `byokModelOverride`, which the
     * conversation path never set).
     */
    private async resolveBYOKConfig(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<BYOKConfig | undefined> {
        return this.permissionValidationService.getBYOKConfig(
            organizationAndTeamData,
        );
    }

    /**
     * Connect to the org's MCP servers and expose their tools. Never throws:
     * if MCP is offline the agent proceeds with sandbox/no tools (parity with
     * the legacy "MCP offline, prosseguindo" path).
     */
    private async connectMcp(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{ tools: Record<string, Tool>; close: () => Promise<void> }> {
        const servers =
            (await this.mcpManagerService?.getConnections(
                organizationAndTeamData,
            )) ?? [];

        if (!servers.length) {
            this.logger.warn({
                message:
                    'ConversationAgent: no MCP connections available for this organization/team.',
                context: ConversationAgentProvider.name,
                metadata: {
                    organizationId: organizationAndTeamData?.organizationId,
                    teamId: organizationAndTeamData?.teamId,
                },
            });
            return { tools: {}, close: async () => undefined };
        }

        return connectMcpTools(servers, {
            onError: (error, serverName) => {
                this.logger.warn({
                    message: `ConversationAgent: MCP server '${serverName}' failed to connect, continuing.`,
                    context: ConversationAgentProvider.name,
                    error,
                });
            },
        });
    }

    private buildSystemPrompt(userLanguage: string): string {
        return [
            'You are Kodus, an intelligent conversation agent for user interactions.',
            'Goal: engage in natural, helpful conversations while respecting the user language preference.',
            '',
            'LANGUAGE REQUIREMENTS (NON-NEGOTIABLE):',
            `- Write your ENTIRE response in ${userLanguage}. This is the team's configured system language.`,
            `- ALWAYS reply in ${userLanguage} EVEN WHEN the user writes in a different language. NEVER mirror or switch to the language of the user's message.`,
            '- Keep the whole reply in one language; do not mix languages.',
            '- Use terminology and formatting natural to that language.',
        ].join('\n');
    }

    /**
     * Assemble the user turn: the conversation context (rebuilt from the PR
     * comment thread), an OPTIONAL list of available tools (memory + repo), and
     * finally the user's message. Tools are offered, never mandated — a chat
     * agent must be free to just answer.
     */
    private buildUserPrompt(
        prompt: string,
        userLanguage: string,
        prepareContext: any,
        organizationAndTeamData: OrganizationAndTeamData,
        hasMemoryTool: boolean,
        sandbox?: SandboxInstance,
    ): string {
        const organizationId =
            organizationAndTeamData?.organizationId?.toString() || '';
        const teamId = organizationAndTeamData?.teamId?.toString() || '';
        const repositoryId = prepareContext?.repository?.id?.toString() || '';

        const memoryPayload = {
            organizationId,
            teamId,
            ...(repositoryId ? { repositoryId } : {}),
            limit: 20,
        };

        const sections: string[] = [];

        const contextBlock = this.buildContextBlock(prepareContext);
        if (contextBlock) {
            sections.push(contextBlock, '');
        }

        // Tools are OPTIONAL aids, not a mandatory pipeline. This is a chat
        // agent — forcing a tool call first (especially one that may be
        // unavailable) made the model freeze and answer nothing on trivial
        // messages like a greeting. List what's available and let it decide.
        const toolLines: string[] = [];
        if (hasMemoryTool) {
            toolLines.push(
                `- KODUS_FIND_MEMORIES — look up the user's prior context/preferences when the question would benefit from it. Payload: ${JSON.stringify(memoryPayload)}`,
            );
        }
        if (sandbox && sandbox.type !== 'null') {
            toolLines.push(
                '- grep / readFile / listDir / exec — search and read the repository when the user asks about code, config, or behavior. Cite file paths and line numbers when you do.',
            );
        }

        if (toolLines.length) {
            sections.push(
                '',
                'TOOLS (optional — use them only when they help you answer; for greetings or simple questions, just reply directly):',
                ...toolLines,
            );
        }

        sections.push(
            '',
            `Answer the user's message below directly. Write your entire answer in ${userLanguage} (the team's configured language) — do NOT switch to the language the user wrote in.`,
            '',
            'USER MESSAGE:',
            prompt,
        );

        return sections.join('\n');
    }

    /**
     * Render the conversation context carried in `prepareContext` (the PR
     * comment thread) into the prompt. In the legacy flow this travelled as
     * `userContext.additional_information`; the AI SDK is stateless, so we make
     * it explicit here. Every field is optional — only present ones render.
     */
    private buildContextBlock(prepareContext: any): string {
        if (!prepareContext) {
            return '';
        }

        const lines: string[] = [];
        const pr = prepareContext.pullRequest;
        const repo = prepareContext.repository;
        const cmc = prepareContext.codeManagementContext;

        if (pr?.pullRequestNumber || repo?.name) {
            const head = pr?.headRef ? ` (${pr.headRef} → ${pr?.baseRef})` : '';
            lines.push(
                `## Conversation context`,
                `Pull request #${pr?.pullRequestNumber ?? '?'}${head}` +
                    (repo?.name ? ` in ${repo.name}` : ''),
            );
        }

        if (prepareContext.pullRequestDescription) {
            lines.push('', String(prepareContext.pullRequestDescription));
        }

        const original = cmc?.originalComment;
        if (original?.suggestionText) {
            lines.push(
                '',
                '### Original Kody suggestion (under discussion)',
                ...(original.suggestionFilePath
                    ? [`File: ${original.suggestionFilePath}`]
                    : []),
                String(original.suggestionText),
                ...(original.diffHunk
                    ? ['Diff:', '```', String(original.diffHunk), '```']
                    : []),
            );
        }

        const replies: Array<{ historyConversationText?: string }> =
            cmc?.othersReplies ?? [];
        const history = replies
            .map((r) => r?.historyConversationText)
            .filter((t): t is string => typeof t === 'string' && t.length > 0);
        if (history.length) {
            lines.push(
                '',
                '### Conversation so far',
                ...history.map((t) => `- ${t}`),
            );
        }

        if (prepareContext.customInstructions) {
            lines.push(
                '',
                '### Custom instructions',
                String(prepareContext.customInstructions),
            );
        }

        return lines.join('\n');
    }

    private async getLanguage(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string> {
        let language = null;

        if (organizationAndTeamData && organizationAndTeamData.teamId) {
            language = await this.parametersService.findByKey(
                ParametersKey.LANGUAGE_CONFIG,
                organizationAndTeamData,
            );
        }

        if (!language) {
            return 'en-US';
        }

        return language?.configValue || 'en-US';
    }
}
