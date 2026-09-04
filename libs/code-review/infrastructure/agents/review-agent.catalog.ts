import { Inject, Injectable, Optional } from '@nestjs/common';

import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { ReviewAgentInput, ReviewAgentOutput } from './review-agent.contract';
import type { BugAgentProvider } from './providers/bug-agent.provider';
import type { GeneralistAgentProvider } from './providers/generalist-agent.provider';
import type { KodyRulesAgentProvider } from './providers/kody-rules-agent.provider';
import type { PerformanceAgentProvider } from './providers/performance-agent.provider';
import type { SecurityAgentProvider } from './providers/security-agent.provider';
import { ReviewAgentPlanItem } from '../../domain/review-policy/review-risk-planner';
import { ReviewAgentId } from '../../domain/review-policy/review-policy';

type AgentExecutor = (
    input: ReviewAgentInput,
    plan: ReviewAgentPlanItem,
    kodyRules?: Partial<IKodyRule>[],
) => Promise<ReviewAgentOutput>;

export interface IReviewAgentCatalog {
    has(agentId: ReviewAgentId): boolean;
    execute(
        plan: ReviewAgentPlanItem,
        input: ReviewAgentInput,
        kodyRules?: Partial<IKodyRule>[],
    ): Promise<ReviewAgentOutput>;
}

export const REVIEW_AGENT_CATALOG_TOKEN = Symbol.for('ReviewAgentCatalog');

export const REVIEW_AGENT_TOKENS = {
    bug: Symbol.for('ReviewAgent.Bug'),
    security: Symbol.for('ReviewAgent.Security'),
    performance: Symbol.for('ReviewAgent.Performance'),
    generalist: Symbol.for('ReviewAgent.Generalist'),
    kodyRules: Symbol.for('ReviewAgent.KodyRules'),
} as const;

/** Runtime registry that decouples orchestration policy from provider wiring. */
@Injectable()
export class ReviewAgentCatalog implements IReviewAgentCatalog {
    private readonly executors: Map<ReviewAgentId, AgentExecutor>;

    constructor(
        @Inject(REVIEW_AGENT_TOKENS.bug)
        bugAgent: BugAgentProvider,
        @Inject(REVIEW_AGENT_TOKENS.security)
        securityAgent: SecurityAgentProvider,
        @Inject(REVIEW_AGENT_TOKENS.performance)
        performanceAgent: PerformanceAgentProvider,
        @Inject(REVIEW_AGENT_TOKENS.generalist)
        generalistAgent: GeneralistAgentProvider,
        @Optional()
        @Inject(REVIEW_AGENT_TOKENS.kodyRules)
        kodyRulesAgent?: KodyRulesAgentProvider,
    ) {
        this.executors = new Map<ReviewAgentId, AgentExecutor>([
            ['bug', (input) => bugAgent.execute(input)],
            ['security', (input) => securityAgent.execute(input)],
            ['performance', (input) => performanceAgent.execute(input)],
            [
                'generalist',
                (input, plan) =>
                    generalistAgent.execute({
                        ...input,
                        requestedCategories: plan.categories,
                    }),
            ],
        ]);

        if (kodyRulesAgent) {
            this.executors.set('kody-rules', (input, _plan, kodyRules) =>
                kodyRulesAgent.execute({
                    ...input,
                    kodyRules: kodyRules ?? [],
                }),
            );
        }
    }

    has(agentId: ReviewAgentId): boolean {
        return this.executors.has(agentId);
    }

    execute(
        plan: ReviewAgentPlanItem,
        input: ReviewAgentInput,
        kodyRules?: Partial<IKodyRule>[],
    ): Promise<ReviewAgentOutput> {
        const executor = this.executors.get(plan.agentId);
        if (!executor) {
            throw new Error(`Review agent is not registered: ${plan.agentId}`);
        }
        return executor(input, plan, kodyRules);
    }
}
