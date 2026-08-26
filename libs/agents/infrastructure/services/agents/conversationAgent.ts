import type { NormalizedModel } from '@libs/llm/byok-config';
import { type Tool } from 'ai';
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

import { withLangfuseTrace } from '@libs/core/log/langfuse';
import { createLogger } from '@libs/core/log/logger';
import { LLM_TASK } from '@libs/llm/byok-config';
import { createAgentRunContext } from '@libs/llm/agent-run-context';
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
 * native loop: this provider resolves ONLY the BYOK slot and exposes MCP +
 * sandbox tools as AI SDK tools, then hands them to the AiSdkAgentRunner →
 * `LLM.run` (the one door to the model), which owns model resolution, the
 * tool-calling loop, prompt-cache, and the cost span, until it answers or
 * hits `CONVERSATION_MAX_STEPS`.
 */
@Injectable()
export class ConversationAgentProvider {
    private readonly logger = createLogger(ConversationAgentProvider.name);

    /**
     * Task-level max-output fallback: LLM.run applies it only when the BYOK slot
     * leaves `maxOutputTokens` unset (`slot ?? this`). Temperature is deliberately
     * NOT set here — the slot owns it, and LLM.run withholds it for providers that
     * reject a fixed value (e.g. Anthropic 4.7+, kimi-k2.7-code).
     */
    private readonly maxOutputTokensFallback = 20000;

    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly permissionValidationService: PermissionValidationService,
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

        // The resolved slot the conversation task uses — provider/model/params
        // read off it directly (no `{main,fallback}` carrier).
        const slot = await this.resolveBYOKSlot(organizationAndTeamData);

        // The agent resolves ONLY the slot — LLM.run (inside the runner) owns the
        // model, tuning, reasoning, prompt-cache and the cost span.

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
        // AiSdkAgentRunner. LLM.run (inside) resolves the model + prompt-cache +
        // reasoning from the slot and records the cost span; the spec carries only
        // the harness concerns + the cost labels. maxSteps applies the ReAct bound.
        const runner = new AiSdkAgentRunner(slot, {
            organizationId: organizationAndTeamData.organizationId?.toString(),
            reporter: this.byokErrorCounter
                ? (e) => void this.byokErrorCounter!.record(e)
                : undefined,
        });
        const spec: AgentSpec = {
            id: 'conversation',
            agentName: 'ConversationalAgent',
            runName: 'conversationAgent',
            phase: 'conversation',
            spanName: 'ConversationalAgent::conversationAgent',
            systemPrompt: this.buildSystemPrompt(userLanguage),
            tools: new AiSdkToolRegistry(tools),
            policies: [],
            maxSteps: CONVERSATION_MAX_STEPS,
            // Conversation keeps its own max-output default when the slot omits one.
            maxOutputTokens: this.maxOutputTokensFallback,
        };

        // Standard run context: signal + hard timeout, same guarantee as the
        // code-review and business agents (a stuck run can't run forever).
        const { ctx, cleanup } = createAgentRunContext({
            runId: `conversation:${organizationAndTeamData.organizationId}`,
        });

        try {
            const preparedPrompt = this.buildUserPrompt(
                prompt,
                userLanguage,
                prepareContext,
                organizationAndTeamData,
                hasMemoryTool,
                sandbox,
            );

            // withLangfuseTrace -> TRACE level (session/user): a thread is a
            // session, so every turn of the same conversation reads as one unit.
            // The per-call OBSERVATION telemetry is built by LLM.run from the raw
            // `telemetryMetadata` the runner forwards (no hand-built SDK payload).
            const state = await withLangfuseTrace(
                {
                    traceName: 'conversationAgent',
                    sessionId: thread.id?.toString(),
                    userId: organizationAndTeamData.organizationId?.toString(),
                    metadata: {
                        organizationId:
                            organizationAndTeamData.organizationId?.toString(),
                        teamId: organizationAndTeamData.teamId?.toString(),
                        threadId: thread.id?.toString(),
                        repositoryId: prepareContext?.repository?.id?.toString(),
                    },
                },
                () =>
                    runner.run(
                        spec,
                        {
                            prompt: preparedPrompt,
                            telemetryMetadata: {
                                organizationId:
                                    organizationAndTeamData.organizationId?.toString(),
                                teamId: organizationAndTeamData.teamId?.toString(),
                                repositoryId:
                                    prepareContext?.repository?.id?.toString(),
                                provider: slot?.provider,
                            },
                        },
                        ctx,
                    ),
            );

            // Cost is recorded by LLM.run's span (inside the runner) — ONE place,
            // same schema (agentName/phase/type/gen_ai.usage.*). No manual record.
            const finishReason = state.stopReason ?? state.status;

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
                    runner,
                    userLanguage,
                    prompt,
                    ctx,
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
        runner: AiSdkAgentRunner,
        userLanguage: string,
        prompt: string,
        ctx: ToolContext,
    ): Promise<string | null> {
        try {
            const spec: AgentSpec = {
                id: 'conversation-retry',
                agentName: 'ConversationalAgent',
                runName: 'conversationAgent',
                phase: 'conversation-retry',
                spanName: 'ConversationalAgent::conversationAgent',
                systemPrompt: this.buildSystemPrompt(userLanguage),
                tools: new AiSdkToolRegistry({}),
                policies: [],
                maxSteps: 1,
                maxOutputTokens: this.maxOutputTokensFallback,
            };

            const state = await runner.run(
                spec,
                {
                    prompt: `Reply to the user's message below. Write your reply in ${userLanguage} — do NOT switch to the language the user wrote in:\n\n${prompt}`,
                },
                ctx,
            );

            // Cost recorded by LLM.run's span (phase 'conversation-retry') — the
            // reused runner carries the same slot, so the retry bills identically.
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
     * Resolve the BYOK model slot for the org's `conversation` task: source the
     * raw config and route it through `resolveTaskSlot` (StaticTaskStrategy over
     * `models[]`/`routing`), so a non-v2/managed/BLOCKED config yields
     * `undefined` → the env/managed default.
     */
    private async resolveBYOKSlot(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<NormalizedModel | undefined> {
        return (
            (await this.permissionValidationService.resolveTaskSlot(
                organizationAndTeamData,
                LLM_TASK.conversation,
            )) ?? undefined
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
