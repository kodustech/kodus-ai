import { ServiceUnavailableException } from '@nestjs/common';
import type { ModelMessage } from 'ai';

import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';

import type { NormalizedModel } from '@libs/llm/byok-config';
import { readAiSdkUsage } from '@libs/llm/ai-sdk-usage';
import { LLM } from '@libs/llm/llm';
import { LLM_TASK, type LlmTask } from '@libs/llm/llm-tasks';
import type { ReasoningEffort } from '@libs/llm/reasoning-options';
import { hasManagedModelKey } from '@libs/llm/managed-slot';
import { createLogger } from '@libs/core/log/logger';
import type { PermissionValidationService, ValidationResult } from '@libs/ee/shared/services/permissionValidation.service';

import {
    LlmProviderUnavailableError,
    type OrgTeam,
    type RuntimeAgentRunnerFactory,
    type RuntimeLlmCompletion,
    type RuntimeLlmMessage,
    type RuntimeLlmProvider,
    type RuntimeSpanAttribution,
} from '../domain/ports';

/**
 * The reasoning effort a Runtime task runs at when the org's slot chose none.
 * `runtime.intent` labels one finding against a short prompt, and only
 * `intended` changes what ships (the guard holds it to a test). On
 * deepseek-v4-pro the slot default (wire `high`) took p95 133 s per call and
 * `low` 30 s, with the same shipped decision on every case
 * (evals/runtime-intent). `runtime.plan` keeps the slot's default.
 */
const TASK_EFFORT: Readonly<Record<string, ReasoningEffort>> = { 'runtime.intent': 'low' };

/**
 * The slot (and its fallback) with the task's effort, unless the org set its
 * own: an explicit `reasoningEffort` (`none` included) or a reasoning override
 * JSON always wins. A provider with no effort mapping (Novita) sends nothing
 * either way.
 */
export function withTaskEffort(slot: NormalizedModel | undefined, task: string): NormalizedModel | undefined {
    const effort = TASK_EFFORT[task];
    if (!slot || !effort) return slot;
    const hint = <S extends Omit<NormalizedModel, 'fallback'>>(s: S): S => (s.reasoningEffort || s.reasoningConfigOverride ? s : { ...s, reasoningEffort: effort });
    const own = hint(slot);
    return slot.fallback ? { ...own, fallback: hint(slot.fallback) } : own;
}

/** The slot source of the org (PermissionValidationService.resolveTaskSlot). */
export interface RuntimeSlotResolver {
    resolveTaskSlot(orgTeam: { organizationId: string; teamId: string }, task: LlmTask): Promise<NormalizedModel | undefined | null>;
}

/**
 * The gateway's provider call (ADR-057): the org's BYOK routes LLM_TASK.runtime
 * the same way code review routes its task. No slot → the managed default
 * inside LLM.run, when the deployment has a managed key; otherwise 503. The
 * key stays encrypted in the slot until LLM.run builds the model, and nothing
 * here logs or returns it.
 */
export class ByokRuntimeLlmProvider implements RuntimeLlmProvider {
    constructor(
        private readonly slots: RuntimeSlotResolver,
        private readonly hasManagedDefault: () => boolean = hasManagedModelKey,
    ) {}

    async complete(input: {
        organizationId: string;
        teamId: string;
        runId: string;
        repositoryId: string;
        prNumber: number;
        task: string;
        messages: RuntimeLlmMessage[];
        maxOutputTokens?: number;
    }): Promise<RuntimeLlmCompletion> {
        const slot = (await this.slots.resolveTaskSlot({ organizationId: input.organizationId, teamId: input.teamId }, LLM_TASK.runtime)) ?? undefined;
        if (!slot && !this.hasManagedDefault()) {
            throw new LlmProviderUnavailableError('No LLM is configured for the Kody Runtime of this organization');
        }

        // Leading system turns become the system prompt; the rest is the conversation.
        let i = 0;
        while (i < input.messages.length && input.messages[i].role === 'system') i++;
        const system = input.messages.slice(0, i).map((m) => m.content).join('\n\n') || undefined;
        const messages = input.messages.slice(i).map((m) => ({ role: m.role, content: m.content }) as ModelMessage);

        // The slot's own maxOutputTokens wins inside LLM.run, so the gateway cap
        // is applied to the slot too (it must never raise the slot's limit).
        const cap = input.maxOutputTokens;
        const hinted = withTaskEffort(slot, input.task);
        const byokConfig = hinted && cap ? { ...hinted, maxOutputTokens: Math.min(hinted.maxOutputTokens ?? cap, cap) } : hinted;

        const result = await LLM.run({
            byokConfig,
            loop: { tools: {}, maxSteps: 1 },
            ...(system ? { system } : {}),
            messages,
            runName: input.task,
            organizationId: input.organizationId,
            // The usage span in observability_telemetry is the record of this call:
            // it carries the Run's ids so Token Usage and the Run attribute it.
            attrs: {
                route: LLM_TASK.runtime,
                runId: input.runId,
                teamId: input.teamId,
                repositoryId: input.repositoryId,
                prNumber: input.prNumber,
                task: input.task,
            },
            ...(cap ? { maxOutputTokens: cap } : {}),
        });

        const usage = readAiSdkUsage(result.usage);
        const { inputTokens, outputTokens } = usage;
        // The model that answered (a fallback slot may have), else the slot's: the Run's cost is priced by it.
        const model = result.response?.modelId || slot?.model;
        // No usage reported stays absent: the gateway then keeps the reservation counted instead of a free call.
        return {
            text: result.text ?? '',
            ...(typeof inputTokens === 'number' && typeof outputTokens === 'number'
                ? {
                      usage: {
                          inputTokens,
                          outputTokens,
                          ...(usage.cacheReadTokens ? { cacheReadTokens: usage.cacheReadTokens } : {}),
                          ...(usage.cacheWriteTokens ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
                      },
                  }
                : {}),
            ...(model ? { model } : {}),
        };
    }
}

/**
 * The agent runner of the Runtime's agents (Kody's recipe author): the same
 * slot the gateway resolves (LLM_TASK.runtime of the org's BYOK, else the
 * managed default when the deployment has a managed key). The slot is handed
 * to the harness as is: LLM.run decrypts the key when it builds the model.
 */
export class ByokRuntimeAgentRunnerFactory implements RuntimeAgentRunnerFactory {
    constructor(
        private readonly slots: RuntimeSlotResolver,
        private readonly hasManagedDefault: () => boolean = hasManagedModelKey,
    ) {}

    async forOrganization(orgTeam: OrgTeam, attribution?: RuntimeSpanAttribution) {
        const slot =
            (await this.slots
                .resolveTaskSlot({ organizationId: orgTeam.organizationId, teamId: orgTeam.teamId }, LLM_TASK.runtime)
                .catch((error: unknown) => {
                    // The permission gate's refusal says why: the agent's caller answers it as a 503.
                    if (error instanceof LlmProviderUnavailableError) throw new ServiceUnavailableException(error.message);
                    throw error;
                })) ?? undefined;
        if (!slot && !this.hasManagedDefault()) return null;
        // The usage span of each call carries the Runtime route and the Run's ids, as the gateway's calls do:
        // without them the managed default stamps no route and the Run cost cannot find the call.
        const spanAttrs = attribution
            ? {
                  route: LLM_TASK.runtime,
                  runId: attribution.runId,
                  task: attribution.task,
                  teamId: orgTeam.teamId,
                  ...(attribution.repositoryId ? { repositoryId: attribution.repositoryId } : {}),
                  ...(attribution.environmentId ? { environmentId: attribution.environmentId } : {}),
                  ...(attribution.prNumber ? { prNumber: attribution.prNumber } : {}),
              }
            : { route: LLM_TASK.runtime };
        return {
            runner: new AiSdkAgentRunner(slot, { organizationId: orgTeam.organizationId, spanAttrs }),
            ...(slot?.model ? { model: slot.model } : {}),
        };
    }
}

/** How long an org's allowed verdict is reused: a Run makes many model calls, the license is read once a minute. */
export const RUNTIME_LLM_PERMISSION_TTL_MS = 60_000;
const PERMISSION_CACHE_MAX = 1_000;
const PERMISSION_CONTEXT = 'RuntimeLlmPermission';

type PermissionSource = Pick<PermissionValidationService, 'validateExecutionPermissions' | 'resolveTaskSlot'>;

/** Why the gate refused, said to whoever sees the Run's failure. No ids, no key material. */
function refusalOf(verdict: Partial<ValidationResult>): string {
    switch (verdict.errorType) {
        case 'BYOK_REQUIRED':
            return verdict.metadata?.byokModelUnresolvable
                ? 'The model set for the Kody Runtime cannot be used: its credential is incomplete'
                : "This organization's plan needs its own LLM key for the Kody Runtime";
        case 'INVALID_LICENSE':
            return 'This organization has no valid license for the Kody Runtime';
        case 'LICENSE_UNAVAILABLE':
            return "This organization's license could not be read; try again";
        case 'CREDITS_EXHAUSTED':
            return 'This organization has no Kodus credits left for the Kody Runtime';
        case 'PLAN_LIMIT_EXCEEDED':
            return "This organization's trial credits are used up";
        default:
            return 'This organization may not use an LLM for the Kody Runtime';
    }
}

/**
 * The product's resolver behind the narrow port, gated first. Every Runtime
 * model call (gateway, model turns, the recipe author and the planner) reads
 * its slot here, so each passes the code review's own gate for
 * LLM_TASK.runtime: a valid license, the plan's BYOK requirement (FREE and
 * BYOK plans never get the managed key), the Kodus credits and a broken
 * credential that must not fall to the managed key. There is no PR author
 * to check a seat for. A refusal, or a gate that fails, throws
 * LlmProviderUnavailableError (a 503) before any slot is read; an allowed
 * verdict is reused for RUNTIME_LLM_PERMISSION_TTL_MS, a refusal never is.
 */
export const permissionSlotResolver = (svc: PermissionSource, now: () => number = Date.now): RuntimeSlotResolver => {
    const logger = createLogger(PERMISSION_CONTEXT);
    const allowedAt = new Map<string, number>();
    const gate = async (orgTeam: { organizationId: string; teamId: string }) => {
        const key = `${orgTeam.organizationId}:${orgTeam.teamId}`;
        const at = allowedAt.get(key);
        if (at !== undefined && now() - at < RUNTIME_LLM_PERMISSION_TTL_MS) return;
        let verdict: Partial<ValidationResult>;
        try {
            verdict = await svc.validateExecutionPermissions(orgTeam as any, undefined, PERMISSION_CONTEXT, {
                task: LLM_TASK.runtime,
                requireUserSeat: false,
            });
        } catch (error) {
            logger.warn({ message: 'Runtime LLM permission could not be checked; the call is refused', context: PERMISSION_CONTEXT, error: error instanceof Error ? error : undefined, metadata: { organizationId: orgTeam.organizationId } });
            throw new LlmProviderUnavailableError("This organization's LLM permission could not be checked; try again");
        }
        if (!verdict?.allowed) {
            allowedAt.delete(key);
            logger.warn({ message: 'Runtime LLM call refused by the permission gate', context: PERMISSION_CONTEXT, metadata: { organizationId: orgTeam.organizationId, errorType: verdict?.errorType } });
            throw new LlmProviderUnavailableError(refusalOf(verdict ?? {}));
        }
        if (allowedAt.size >= PERMISSION_CACHE_MAX) allowedAt.clear();
        allowedAt.set(key, now());
    };
    return {
        resolveTaskSlot: async (orgTeam, task) => {
            await gate(orgTeam);
            return svc.resolveTaskSlot(orgTeam as any, task);
        },
    };
};
