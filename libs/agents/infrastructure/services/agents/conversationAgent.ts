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

import { connectMcpTools, type ConnectedMcpTools } from '../ai-sdk/mcp-tools';
import { buildNativeTools } from '../ai-sdk/native-tools';
import { withVerifiedOutcome } from './conversation-outcome';
import {
    auditWriteTools,
    isConversationWriteTool,
    type WriteToolEvent,
} from './conversation-tool-audit';
import { WriteGatePolicy } from './write-gate.policy';
import { WriteTruthPolicy } from './write-truth.policy';
import {
    buildSystemPrompt,
    buildUserPrompt,
    type ConversationThreadContext,
} from './conversation-prompt';
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
 * How many prior messages of the thread travel back into the prompt. Enough to
 * carry an offer and its confirmation without dragging a long thread into every
 * turn.
 */
const CONVERSATION_HISTORY_TURNS = 10;

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
 * native loop: `buildModelFromSlot` resolves the BYOK model, MCP + sandbox
 * tools are exposed as AI SDK tools, and `generateText` runs the tool-calling
 * loop until it answers or hits `CONVERSATION_MAX_STEPS`.
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
            prepareContext?: ConversationThreadContext;
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

        // What this turn actually changed. Drives both the honesty note the
        // model sees mid-run and the footer the developer reads at the end.
        const writes: WriteToolEvent[] = [];

        const tools: Record<string, Tool> = auditWriteTools(
            {
                ...mcp.tools,
                ...(sandbox ? buildNativeTools(sandbox) : {}),
            },
            mcp.metadata,
            (event) => (
                writes.push(event),
                this.logger.log({
                    message: `Conversation agent called write tool ${event.tool}`,
                    context: ConversationAgentProvider.name,
                    serviceName: ConversationAgentProvider.name,
                    metadata: {
                        organizationAndTeamData,
                        threadId: thread.id?.toString(),
                        repositoryId:
                            prepareContext?.repository?.id?.toString(),
                        developer: prepareContext?.gitUser?.username,
                        tool: event.tool,
                        failed: Boolean(event.error),
                        error: event.error,
                        // Debugging record of what the tool handed back — the
                        // reply shows the developer the link, not this.
                        result: event.result,
                    },
                })
            ),
        );
        // The PR thread strips Kody's own replies on every platform, so an offer
        // it made last turn survives only in the conversation record. Replay it —
        // otherwise a bare "yes, do it" resolves to nothing, and the write gate
        // has no way to know the developer was ever offered anything.
        const seedMessages = await this.loadThreadHistory(thread);

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
            systemPrompt: buildSystemPrompt(userLanguage),
            tools: new AiSdkToolRegistry(tools),
            policies: [
                new WriteGatePolicy(
                    (name) => isConversationWriteTool(mcp.metadata[name]),
                    seedMessages.some((m) => m.role === 'assistant'),
                ),
                new WriteTruthPolicy((name) =>
                    isConversationWriteTool(mcp.metadata[name]),
                ),
            ],
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
            const preparedPrompt = buildUserPrompt({
                prompt,
                userLanguage,
                prepareContext,
                organizationAndTeamData,
                availableTools: Object.keys(tools),
                toolMetadata: mcp.metadata,
                hasSandbox: Boolean(sandbox && sandbox.type !== 'null'),
                priorTurns: seedMessages,
            });

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
                        repositoryId:
                            prepareContext?.repository?.id?.toString(),
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
            // The model narrates; the tools are the record. Reconcile the two
            // before anyone reads the reply.
            const userFacing = response
                ? withVerifiedOutcome(response, writes)
                : finishReason === 'error'
                  ? CONVERSATION_PROVIDER_ERROR_MESSAGE
                  : CONVERSATION_FALLBACK_MESSAGE;

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
                systemPrompt: buildSystemPrompt(userLanguage),
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
     * The tail of this thread's conversation record, oldest first. Best-effort:
     * the store swallows its own errors and a miss just means the agent answers
     * without prior turns.
     */
    private async loadThreadHistory(
        thread: ConversationThread,
    ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
        const threadId = thread?.id != null ? String(thread.id) : '';
        if (!this.conversationStore || !threadId) {
            return [];
        }

        try {
            const messages = await this.conversationStore.load(threadId);
            return messages
                .filter(
                    (m) =>
                        (m.role === 'user' || m.role === 'assistant') &&
                        typeof m.content === 'string' &&
                        m.content.length > 0,
                )
                .slice(-CONVERSATION_HISTORY_TURNS)
                .map((m) => ({
                    role: m.role as 'user' | 'assistant',
                    content: m.content,
                }));
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to load conversation history; answering without it',
                context: ConversationAgentProvider.name,
                metadata: { threadId },
                error,
            });
            return [];
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
        prepareContext?: ConversationThreadContext,
    ): Promise<void> {
        if (!this.conversationStore) {
            return;
        }

        const threadId = thread?.id != null ? String(thread.id) : '';
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
    ): Promise<ConnectedMcpTools> {
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
            return { tools: {}, metadata: {}, close: async () => undefined };
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
