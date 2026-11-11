/**
 * Enterprise Code — see `license_ee.md`. Experiment (exp/finder-gap-tools),
 * after Meta's intent-aware catching tests: one call reads the PR's title,
 * description and diff, states what the change means to do and lists the
 * concrete ways that intent can go wrong; an agent then checks each risk in
 * the code and reports only the ones the code realises. Nothing is executed:
 * the code is the evidence.
 */
import type { AgentSpec } from '@libs/agent-harness/domain/contracts/agent.contract';
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import type { AgentTool } from '@libs/agent-harness/domain/contracts/tool.contract';
import { BudgetPolicy } from '@libs/agent-harness/infrastructure/policies/budget.policy';
import { ForceFinalizePolicy } from '@libs/agent-harness/infrastructure/policies/force-finalize.policy';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';

import type { HeavyLens } from './heavy-lenses';

export const MAX_RISKS = 8;
const BODY_MAX_CHARS = 8000;
export const RISK_PLAN_TOOL = 'submitRisks';

export interface IntentRisk {
    risk: string;
    where: string;
}

export interface RiskPlan {
    intent: string;
    risks: IntentRisk[];
}

const submitRisksTool: AgentTool = {
    name: RISK_PLAN_TOOL,
    description: 'Submit the change\'s intent and the risks to check. Call it once.',
    inputSchema: {
        type: 'object',
        properties: {
            intent: { type: 'string', description: 'One sentence: what this pull request means to do.' },
            risks: {
                type: 'array',
                maxItems: MAX_RISKS,
                items: {
                    type: 'object',
                    properties: {
                        risk: { type: 'string', description: 'One concrete way the implementation of the intent can be wrong, as a checkable claim.' },
                        where: { type: 'string', description: 'The changed file(s) and function(s) the risk is about.' },
                    },
                    required: ['risk', 'where'],
                },
            },
        },
        required: ['intent', 'risks'],
    },
    execute: async () => ({ output: 'submitted' }),
};

const RISK_PLAN_SYSTEM_PROMPT = `You plan a review. You read a pull request's title, description and diff, state what the change means to do, and list the concrete ways that intent can be implemented wrongly. You do not decide whether the code is wrong: another reviewer checks each risk in the code. Answer by calling the ${RISK_PLAN_TOOL} tool.`;

export function buildRiskPlanPrompt(title: string | undefined, body: string | undefined, diffText: string): string {
    const desc = (body ?? '').trim();
    return `<PullRequest>
Title: ${(title ?? '').trim() || '(none)'}
Description:
${desc ? desc.slice(0, BODY_MAX_CHARS) : '(none)'}
</PullRequest>

<Diffs>
${diffText}
</Diffs>

<Task>
  1. Intent: in one sentence, what this change means to do, from the title, the
     description and the diff. The description may be wrong or incomplete; the
     diff is what was done.
  2. Risks: up to ${MAX_RISKS} concrete ways an implementation of that intent can
     be wrong in THIS diff, most likely and most damaging first. Each risk is a
     checkable claim about the changed code, not a topic. Think of:
     - a case the intent covers that the code does not handle (another platform,
       status, input shape, empty or missing value, a concurrent or repeated call,
       a retry, a failure midway);
     - a place that must change with the intent and may not have (another caller,
       a sibling implementation, a reader of the changed field or value, a
       migration, a config);
     - the change breaking what the code did before for callers that did not ask
       for it;
     - a guarantee the intent implies (isolation between tenants, idempotency,
       ordering, a limit, a timeout, cleanup) that the code may not give.
     Skip style, naming, tests and documentation. Skip risks the diff visibly
     handles.
  3. Call ${RISK_PLAN_TOOL} with the intent and the risks. When the diff gives no
     real risk, submit an empty list.
</Task>`;
}

export function buildRiskPlanSpec(params: {
    modelId: string;
    usageRunName?: string;
    agentName?: string;
    providerOptions?: Readonly<Record<string, unknown>>;
}): AgentSpec {
    return {
        id: 'intent-risks-plan',
        runName: params.usageRunName ?? 'code-review',
        agentName: params.agentName,
        phase: 'review',
        systemPrompt: RISK_PLAN_SYSTEM_PROMPT,
        tools: new InMemoryToolRegistry([submitRisksTool]),
        policies: [new BudgetPolicy(), new ForceFinalizePolicy({ doneToolName: RISK_PLAN_TOOL })],
        maxSteps: 2,
        resultToolName: RISK_PLAN_TOOL,
        providerOptions: params.providerOptions,
    };
}

/** The plan the run submitted last, or none. */
export function riskPlanOf(state: RunState): RiskPlan | undefined {
    const last = [...state.artifacts].reverse().find((a) => a.payload && typeof a.payload === 'object');
    const p = last?.payload as Partial<RiskPlan> | undefined;
    if (!p) return undefined;
    const risks = (Array.isArray(p.risks) ? p.risks : [])
        .filter((r): r is IntentRisk => !!r && typeof r.risk === 'string' && r.risk.trim().length > 0)
        .slice(0, MAX_RISKS)
        .map((r) => ({ risk: r.risk.trim(), where: String(r.where ?? '').trim() }));
    return { intent: String(p.intent ?? '').trim(), risks };
}

const METHOD = `- A risk of this change's intent that the code realises. Another step read the pull request and listed, below, what the change means to do and the ways it can go wrong. METHOD:
  1. Take each risk in order. Find the code it is about, in the diff and outside it, with the tools: read the changed function, its callers (getCallers), its siblings (findSiblings), the readers of what it changed (findReaders).
  2. Decide whether the code actually has the problem: trace the concrete path (the input, the branch, the state) that makes it fail. A risk the code handles, here or in a caller, is dropped.
  3. Report only the risks you confirmed with a concrete path, anchored to the changed line that causes it; say which risk it is and the path that fails. Do not report a risk because it is plausible.`;

export function intentRisksLens(plan: RiskPlan): HeavyLens {
    const list = plan.risks.map((r, k) => `  [${k + 1}] ${r.risk}${r.where ? `\n      where: ${r.where}` : ''}`).join('\n');
    return {
        id: 'intent-risks',
        label: 'bug',
        assignment: 'the listed risks of this change\'s intent that the code actually realises',
        items: [],
        extraItems: [`${METHOD}\n\n  Intent: ${plan.intent || '(not stated)'}\n\n  Risks:\n${list}`],
        reasoningExample:
            "Risk [2]: the new tenant check may not cover the CLI entry point. getCallers on updateRuleUseCase shows cli/update-rule.ts:31 calling it without organizationId; read it: the use case falls back to the rule's own org, so any key updates any rule. Reported, anchored to update-rule.use-case.ts:44, naming risk [2].",
    };
}
