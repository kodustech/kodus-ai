import type { ModelMessage } from 'ai';

import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';

import type { NormalizedModel } from '@libs/llm/byok-config';
import { readAiSdkUsage } from '@libs/llm/ai-sdk-usage';
import { LLM } from '@libs/llm/llm';
import { LLM_TASK, type LlmTask } from '@libs/llm/llm-tasks';
import type { ReasoningEffort } from '@libs/llm/reasoning-options';
import { hasManagedModelKey } from '@libs/llm/managed-slot';
import type { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';

import {
    LlmProviderUnavailableError,
    type OrgTeam,
    type RuntimeAgentRunnerFactory,
    type RuntimeLlmCompletion,
    type RuntimeLlmMessage,
    type RuntimeLlmProvider,
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

    async forOrganization(orgTeam: OrgTeam) {
        const slot = (await this.slots.resolveTaskSlot({ organizationId: orgTeam.organizationId, teamId: orgTeam.teamId }, LLM_TASK.runtime)) ?? undefined;
        if (!slot && !this.hasManagedDefault()) return null;
        return {
            runner: new AiSdkAgentRunner(slot, { organizationId: orgTeam.organizationId }),
            ...(slot?.model ? { model: slot.model } : {}),
        };
    }
}

/** Adapter so the module injects the product's resolver behind the narrow port. */
export const permissionSlotResolver = (svc: PermissionValidationService): RuntimeSlotResolver => ({
    resolveTaskSlot: (orgTeam, task) => svc.resolveTaskSlot(orgTeam as any, task),
});
