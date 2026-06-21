import {
    createMCPAdapter,
    createOrchestration,
    createThreadId,
    PlannerType,
    EnhancedJSONParser,
    createLogger,
    ContextEvidence,
} from '@kodus/flow';
import { SDKOrchestrator } from '@kodus/flow/dist/orchestration';
import { LLMModelProvider, PromptRunnerService } from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';
import type {
    CodeReviewConfig,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';

import { BaseAgentProvider } from './base-agent.provider';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { convertTiptapJSONToText } from '@libs/common/utils/tiptap-json';

export interface ContextEvidenceAgentResult {
    evidences?: ContextEvidence[];
    actionsLog?: string;
}

export interface ContextMCPDependency {
    provider: string;
    toolName: string;
    pathKey?: string;
    path?: string[];
    requirementId?: string;
    metadata?: Record<string, unknown>;
    descriptor?: unknown;
    schema?: unknown;
    requiredArgs?: string[];
    description?: string;
}

@Injectable()
export class ContextEvidenceAgentProvider extends BaseAgentProvider {
    private readonly logger = createLogger(ContextEvidenceAgentProvider.name);
    private orchestration: SDKOrchestrator | null = null;
    private mcpAdapter: ReturnType<typeof createMCPAdapter>;
    private initializing: Promise<void> | null = null;

    protected readonly defaultLLMConfig = {
        llmProvider: LLMModelProvider.GEMINI_2_5_PRO,
        temperature: 0,
        maxTokens: 60000,
        maxReasoningTokens: 1024,
        stop: undefined as string[] | undefined,
    };

    constructor(
        promptRunnerService: PromptRunnerService,
        permissionValidationService: PermissionValidationService,
        observabilityService: ObservabilityService,
        private readonly mcpManagerService: MCPManagerService,
    ) {
        super(
            promptRunnerService,
            permissionValidationService,
            observabilityService,
        );
    }

    protected async createMCPAdapter(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        const mcpManagerServers = await this.mcpManagerService.getConnections(
            organizationAndTeamData,
        );

        if (!mcpManagerServers?.length) {
            this.logger.warn({
                message:
                    'ContextEvidenceAgent: no MCP connections available for this organization/team. Skipping MCP adapter initialization.',
                context: ContextEvidenceAgentProvider.name,
                metadata: {
                    organizationId: organizationAndTeamData?.organizationId,
                    teamId: organizationAndTeamData?.teamId,
                },
            });
            this.mcpAdapter = undefined;
            return;
        }

        const servers = [...mcpManagerServers];

        this.mcpAdapter = createMCPAdapter({
            servers,
            defaultTimeout: 15_000,
            maxRetries: 1,
            onError: (error) => {
                this.logger.warn({
                    message:
                        'ContextEvidenceAgent: MCP execution failed, continuing.',
                    context: ContextEvidenceAgentProvider.name,
                    error,
                });
            },
        });
    }

    private buildPrompt(
        files: FileChange[],
        dependencies?: ContextMCPDependency[],
        promptOverrides?: CodeReviewConfig['v2PromptOverrides'],
        kodyRule?: Partial<IKodyRule>,
    ): string {
        const diffsSection = files.length
            ? files
                  .map((file) => {
                      const snippet =
                          file.patchWithLinesStr ?? file.patch ?? 'N/A';
                      return `\`\`\`diff\n${snippet}\n\`\`\``;
                  })
                  .join('\n\n')
            : 'N/A (PR Level Analysis)';

        const missionToolsSection = this.formatDependencies(dependencies);

        const missionToolNames =
            dependencies?.map((d) => `\`${d.toolName}\``).join(', ') || 'none';

        const directiveSection = kodyRule
            ? this.buildKodyRuleDirective(kodyRule)
            : this.buildOverridesDirective(promptOverrides);

        return `${directiveSection}

### Diffs
${diffsSection}

> **Reading the diff:** \`-\` = deleted, \`+\` = added, no prefix = context

## 🚀 YOUR MISSION & EXECUTION PLAN
Your mission is to act as a **Lead Evidence Auditor**. First, validate if the code change warrants investigation based on the DIRECTIVE. If relevant, **AGGRESSIVELY GATHER CONTEXT**. If irrelevant (e.g., typo fix, formatting), skip tools.

**Step 1: Triage & Scope (Analyze Inputs)**
-   **SOURCE 1: The DIRECTIVE (The "Intent"):** This defines *what* to look for (e.g., "bugs", "security issues").
-   **SOURCE 2: The DIFF (The "Subject"):** This defines the target entities (Files, Identifiers, Context).
-   **SOURCE 3: ADDITIONAL INFO (The "Environment"):** Metadata (Org/Team IDs).
-   **EVALUATE RELEVANCE (CRITICAL):** Does this specific change interact with the Directive's intent?
    -   *Example:* Directive asks about "Security", but Diff only changes a CSS color -> **SKIP**.
    -   *Example:* Directive asks about "Bugs", Diff changes core logic -> **EXECUTE**.
-   **DECISION:** Only proceed to Step 2 if the change is RELEVANT. Otherwise, STOP and report the reason 'not_needed_for_this_change'.

**Step 2: Argument Resolution Matrix (MANDATORY)**
-   Before executing, create a mental map for *each* MISSION TOOL:
    1.  **Tool Name**: [Name]
    2.  **Required Args**: [List args]
    3.  **Source Strategy**:
        -   **Primary:** Check \`Diff\` and \`DIRECTIVE\`.
        -   **Secondary:** Check \`ADDITIONAL INFO\` (User Context, Repo Metadata) for environment IDs/Slugs.
        -   **Tertiary (Discovery):** If missing, plan to run a "Discovery Tool" from <AVAILABLE TOOLS> first (e.g., use a "list" tool to get a slug, or "search" tool to get an ID).
    4.  **Constraint Application**: Check the DIRECTIVE for specific conditions. Apply these conditions to relevant arguments to ensure the tool execution matches the specific intent.

**Step 3: Execution & Chaining (The Main Loop)**
-   **PRIORITIZE MISSION TOOLS:** Your primary goal is to execute the tools listed in \`MISSION TOOLS\`. Use other tools *only* to unblock these.
-   **CHAIN TOOLS:** If Tool A returns an ID, *immediately* use it in Tool B. Do not stop.
-   **EXECUTE EXACTLY:** Use the tool name EXACTLY as listed in ${missionToolNames} or the '<AVAILABLE TOOLS>' definition. Do not modify, prefix, or suffix it. If the definition says "toolName": "X", you call "X".
-   **EXTRACT & ADAPT:** Tools return structures (JSON). You need specific values for the next tool.
    -   *Action:* Parse the response from Tool A. Locate the exact field required by Tool B.
-   **MISSING ARGUMENTS (BLOCKER):** If you are missing an argument (like an ID) to run a Mission Tool:
    1.  **DO NOT SKIP** the tool yet.
    2.  **EXECUTE A HELPER:** Find a tool in <AVAILABLE TOOLS> that can return the missing data.
    3.  **Example:** Need an ID? Run a search tool. Need a slug? Run a listing tool.
-   **SMART RECOVERY (CRITICAL):** If a tool fails (e.g., 404, 400, Invalid Arg):
    1.  **Assume the argument is wrong** (e.g., wrong slug, stale ID).
    2.  **Scan <AVAILABLE TOOLS>** for a "Discovery Capability" (listing or searching).
    3.  **Execute Broadly:** If searching for a specific name/ID failed, **DO NOT** repeat the search with the same value. Instead, execute the Discovery Tool **WITHOUT filters** (or with broad wildcards) to list ALL available entities.
    4.  **Manual Match:** Look through the returned list to find the correct entity that matches the user's intent.
    5.  **Retry** the original tool with the fresh, validated value.
    6.  *Only* give up if the Broad Discovery also fails.

**Step 4: Comprehensive Reporting**
-   **REPORT PARTIAL SUCCESS:** If you ran 3 tools and 1 failed, report the 2 successes. Do not discard valid data because of a partial failure.
-   Report ALL findings. Even empty results are valuable context.
-   Only use \`skipReason\` if you have *proven* that the data is unreachable or irrelevant.

## 🎯 MISSION TOOLS (${missionToolNames})
If your initial assessment determines they are needed, your goal is to execute these tools.

${missionToolsSection}

## 🛑 STOPPING CRITERIA

**STOP when:**
- ✅ All required tools processed (executed or skipped)
- ✅ No tools needed for this change

**SKIP when:**
| Reason | skipReason |
|--------|------------|
| Not in \`<AVAILABLE TOOLS>\` | \`"tool_not_available"\` |
| Can't resolve args | \`"args_unresolvable"\` |
| Context wouldn't help | \`"not_needed_for_this_change"\` |
| Directive doesn't apply | \`"change_unrelated_to_request"\` |

## 🚨 ERROR HANDLING
- **If a tool fails:**
    1.  **Analyze the error message.** Does it mention a specific parameter (e.g., "Invalid Organization", "Project not found")?
    2.  **Locate a Discovery Tool.** Analyze <AVAILABLE TOOLS> descriptions/schemas to find a tool that can retrieve the missing/invalid entity. Focus on what the tool returns, not just its name.
    3.  **Execute & Retry.** Use the Discovery Tool to get valid values, then retry the failed operation.
    4.  **Do not retry blind.** Never retry the exact same failed request. Change the parameters based on new evidence.
- **NEVER** loop indefinitely. If a recovery attempt fails, STOP.

## ✅ OUTPUT FORMAT
When you have completed your mission and processed all required tools, provide your final response as a single JSON object. No other text or explanation outside the JSON.
\`\`\`json
{
  "reasoning": "What is this change? Do I need context? Why/why not?",
  "evidences": [
    {
      "provider": "string",
      "toolName": "string",
      "pathKey": "string",
      "payload": "<result or null>",
      "metadata": {
        "executionStatus": "success" | "failed" | "skipped",
        "skipReason": "string or null"
      }
    }
  ],
  "actionsLog": "Step-by-step log"
}
\`\`\`
`;
    }

    private buildKodyRuleDirective(kodyRule: Partial<IKodyRule>): string {
        return `## 📌 DIRECTIVE: KodyRule Validation

You are validating this code change against a specific rule.

**Rule:** ${kodyRule.title}
**Description:** ${kodyRule.rule}

Task: Use available tools to validate compliance with this rule against the provided code changes.`;
    }

    private buildOverridesDirective(
        promptOverrides?: CodeReviewConfig['v2PromptOverrides'],
    ): string {
        if (!promptOverrides) {
            return `## 📌 DIRECTIVE: Standard Review
No specific context request. Use your judgment as a senior engineer to decide if external context would help.`;
        }

        const overridesContent = this.deserializeNestedJson(promptOverrides);

        if (!overridesContent.trim()) {
            return `## 📌 DIRECTIVE: Standard Review
No specific context request. Use your judgment as a senior engineer to decide if external context would help.`;
        }

        return `## 📌 DIRECTIVE: User Request
The user is asking for specific context:
${overridesContent}
Task: Fulfill this request using available tools based on the provided code changes.`;
    }

    private formatDependencies(dependencies?: ContextMCPDependency[]): string {
        if (!dependencies?.length) {
            return '[]';
        }

        try {
            const summarized = dependencies.map((dependency) => ({
                provider: dependency.provider,
                toolName: dependency.toolName,
                pathKey: dependency.pathKey ?? 'generation.main',
                requiredArgs: dependency.requiredArgs ?? [],
                description: dependency.description ?? null,
                schema:
                    dependency.schema ??
                    dependency.metadata?.toolInputSchema ??
                    null,
            }));

            return JSON.stringify(summarized);
        } catch {
            return dependencies
                .map(
                    (dependency, index) =>
                        `${index + 1}. ${dependency.provider || 'unknown'}::${dependency.toolName || 'unknown'} (path: ${dependency.pathKey ?? 'n/a'})`,
                )
                .join('\n');
        }
    }

    private deserializeNestedJson(obj: unknown): string {
        if (typeof obj === 'string') {
            const trimmed = obj.trim();
            if (
                (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
                (trimmed.startsWith('[') && trimmed.endsWith(']'))
            ) {
                try {
                    const parsed = JSON.parse(trimmed);
                    return convertTiptapJSONToText(parsed);
                } catch {
                    return obj;
                }
            }
            return obj;
        }

        if (Array.isArray(obj)) {
            return obj
                .map((item) => this.deserializeNestedJson(item))
                .join('\n');
        }

        if (obj && typeof obj === 'object') {
            const lines: string[] = [];
            for (const [key, value] of Object.entries(obj)) {
                const deserializedValue = this.deserializeNestedJson(value);
                if (deserializedValue.trim()) {
                    lines.push(`**${key}:**\n${deserializedValue}`);
                }
            }
            return lines.join('\n\n');
        }

        return String(obj ?? '');
    }

    private parseAgentResponse(
        response: unknown,
    ): ContextEvidenceAgentResult | null {
        if (!response) {
            return null;
        }

        const text =
            typeof response === 'string' ? response : JSON.stringify(response);

        try {
            const parsed: any = EnhancedJSONParser.parse(text);

            if (!parsed) {
                if (
                    text.trim().startsWith('{') ||
                    text.trim().startsWith('[')
                ) {
                    const preview =
                        text.length > 200
                            ? text.substring(0, 200) + '...'
                            : text;
                    return {
                        evidences: [],
                        actionsLog: `Failed to parse agent response (EnhancedParser returned null). payload_preview=${JSON.stringify(preview)}`,
                    };
                }
                return null;
            }

            const evidences = Array.isArray(parsed.evidences)
                ? (parsed.evidences as ContextEvidence[])
                : undefined;

            return {
                evidences,
                actionsLog:
                    typeof parsed.actionsLog === 'string'
                        ? parsed.actionsLog
                        : typeof parsed.actions === 'string'
                          ? parsed.actions
                          : undefined,
            };
        } catch (error) {
            const message =
                typeof error?.message === 'string'
                    ? error.message
                    : String(error);

            this.logger.warn({
                message: 'ContextEvidenceAgent: failed to parse response',
                error,
                context: ContextEvidenceAgentProvider.name,
                metadata: { responseText: text },
            });

            if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
                const preview =
                    text.length > 200 ? text.substring(0, 200) + '...' : text;
                return {
                    evidences: [],
                    actionsLog: `Failed to parse agent response. error=${message}. payload_preview=${JSON.stringify(preview)}`,
                };
            }
            return null;
        }
    }

    private async createEphemeralOrchestrator(
        organizationAndTeamData: OrganizationAndTeamData,
        dependencies?: ContextMCPDependency[],
    ) {
        const mcpManagerServers = await this.mcpManagerService.getConnections(
            organizationAndTeamData,
        );

        const requiredServerNames = new Set<string>();

        if (dependencies) {
            for (const dep of dependencies) {
                const serverName =
                    (dep.metadata as any)?.providerName ||
                    (dep.metadata as any)?.providerAlias ||
                    dep.provider;
                if (serverName) {
                    requiredServerNames.add(serverName.toLowerCase());
                }
            }
        }

        requiredServerNames.add('kodus mcp');

        const servers = mcpManagerServers.filter((server) => {
            const serverName = server.name.toLowerCase();
            return requiredServerNames.has(serverName);
        });

        const mcpAdapter = createMCPAdapter({
            servers,
            defaultTimeout: 60_000,
            maxRetries: 1,
            onError: (error) => {
                this.logger.warn({
                    message:
                        'ContextEvidenceAgent: MCP execution failed, continuing.',
                    context: ContextEvidenceAgentProvider.name,
                    error,
                });
            },
        });

        const llmAdapter = super.createLLMAdapter(
            'ContextEvidenceAgent',
            'contextEvidenceAgent',
        );

        const orchestration = await createOrchestration({
            tenantId: 'kodus-context-evidence-agent',
            llmAdapter,
            mcpAdapter,
            observability:
                this.observabilityService.getAgentObservabilityConfig(
                    'context-script-agent',
                ),
            storage: this.observabilityService.getStorageConfig(),
        });

        await orchestration.connectMCP();
        await orchestration.registerMCPTools();

        await orchestration.createAgent({
            name: 'kodus-context-evidence-agent',
            llmDefaults: {
                model: this.defaultLLMConfig.llmProvider,
                temperature: this.defaultLLMConfig.temperature,
                maxTokens: this.defaultLLMConfig.maxTokens,
                maxReasoningTokens: this.defaultLLMConfig.maxReasoningTokens,
                stop: this.defaultLLMConfig.stop,
            },
            identity: {
                description:
                    'Lead Evidence Auditor. Your role is to EXHAUSTIVELY gather external context for code reviews, but ONLY when relevant. You are an active investigator who uses every available tool to build a complete picture of the code changes, provided the changes warrant such investigation.',
                goal: "First, assess the relevance of the DIRECTIVE to the provided DIFF. If the code changes intersect with the directive's concerns (e.g., security logic changed vs security directive), AGGRESSIVELY gather evidence. If the changes are trivial or unrelated (e.g., formatting, comments), skip execution.",
                expertise: [
                    'Relevance Assessment',
                    'Deep Context Retrieval',
                    'Tool Chaining Strategy',
                    'Log Analysis',
                ],
                personality:
                    'Critical thinker, precise in execution, and resilient. You do not waste resources on irrelevant changes, but you leave no stone unturned when a change is significant.',
            },
            plannerOptions: {
                type: PlannerType.REACT,
                replanPolicy: {
                    toolUnavailable: 'fail',
                    maxReplans: 1,
                },
                scratchpad: {
                    enabled: true,
                    initialState: `Thought: I need to validate if this change is relevant to the directive before gathering evidence. I will start by analyzing the intersection between the provided code changes and the directive's intent.

My execution plan is:
1. Triage & Scope (Validate Relevance & Define Constraints)
2. Argument Resolution Matrix (Map tools to arguments with constraints)
3. Execution & Chaining (Run tools, chain results, handle errors)
4. Comprehensive Reporting`,
                },
            },
        });

        return orchestration;
    }

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        files: FileChange[];
        dependencies?: ContextMCPDependency[];
        promptOverrides?: CodeReviewConfig['v2PromptOverrides'];
        additionalContext?: Record<string, unknown>;
        kodyRule?: Partial<IKodyRule>;
        /** Per-repo/directory BYOK model override (`codeReviewConfig.byokModel`). */
        byokModel?: string;
    }): Promise<ContextEvidenceAgentResult | null> {
        const {
            organizationAndTeamData,
            files,
            dependencies,
            promptOverrides,
            additionalContext,
            kodyRule,
            byokModel,
        } = params;

        this.logger.log({
            message: 'Starting context evidence collection',
            context: ContextEvidenceAgentProvider.name,
            serviceName: ContextEvidenceAgentProvider.name,
            metadata: {
                organizationId: organizationAndTeamData?.organizationId,
                teamId: organizationAndTeamData?.teamId,
                filesCount: files.length,
                dependenciesCount: dependencies?.length || 0,
                mode: kodyRule ? 'PR-Level' : 'File-Level',
            },
        });

        if (!organizationAndTeamData) {
            throw new Error(
                'Organization and team data is required for context evidence collection.',
            );
        }

        if (!dependencies?.length) {
            return null;
        }

        await this.fetchBYOKConfig(organizationAndTeamData, byokModel);

        const orchestration = await this.createEphemeralOrchestrator(
            organizationAndTeamData,
            dependencies,
        );

        const thread = createThreadId(
            {
                organizationId: organizationAndTeamData.organizationId,
                file:
                    files.length === 1
                        ? files[0].filename
                        : `PR-Level-${kodyRule?.uuid || 'general'}`,
            },
            { prefix: 'csa' },
        );

        const prompt = this.buildPrompt(
            files,
            dependencies,
            promptOverrides,
            kodyRule,
        );

        const result = await orchestration.callAgent(
            'kodus-context-evidence-agent',
            prompt,
            {
                thread,
                userContext: {
                    organizationAndTeamData,
                    additional_information: additionalContext,
                },
            } as any,
        );

        const agentOutput =
            (result as { result?: unknown })?.result ?? result ?? null;
        return this.parseAgentResponse(agentOutput);
    }
}
