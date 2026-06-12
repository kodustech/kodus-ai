import { Inject, Injectable } from '@nestjs/common';

import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import {
    IKodyRule,
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import {
    CockpitRangeQuery,
    KodyRuleHealthRow,
    KodyRuleHealthState,
    KodyRuleUsageRow,
} from '../../domain/types';
import {
    COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN,
    ICockpitReviewAnalyticsService,
} from '../../domain/contracts/cockpit-review-analytics.service.contract';

/**
 * "Kody Rules — health" table: merges warehouse usage (triggers /
 * implementation rate per rule, from `suggestions_mv.brokenKodyRulesIds`)
 * with rule metadata from Mongo `kodyRules` — which is also what surfaces
 * ACTIVE rules that never triggered in the window (`stale`).
 *
 * States:
 *  - `stale`     active rule with zero triggers in the window
 *  - `low_data`  triggered, but not enough sample to judge
 *  - `noisy`     the team actively downvotes what this rule produces
 *  - `ignored`   triggers a lot, almost nothing gets implemented
 *  - `healthy`   everything else
 *
 * `noisy` outranks `ignored`: explicit disagreement is a stronger signal
 * than passive inaction, and its fix is different (rewrite/scope the rule
 * vs. ask whether it matters at all).
 */

const MIN_TRIGGERS_TO_JUDGE = 5;
const IGNORED_MAX_RATE = 0.2;
const NOISY_MIN_THUMBS_DOWN = 3;

export function computeRuleState(usage: KodyRuleUsageRow | undefined): {
    state: KodyRuleHealthState;
    usage: Omit<KodyRuleUsageRow, 'ruleId'>;
} {
    if (!usage || usage.triggers === 0) {
        return {
            state: 'stale',
            usage: {
                triggers: 0,
                implemented: 0,
                rate: 0,
                thumbsUp: usage?.thumbsUp ?? 0,
                thumbsDown: usage?.thumbsDown ?? 0,
                lastTriggeredAt: usage?.lastTriggeredAt ?? null,
            },
        };
    }

    const { triggers, implemented, rate, thumbsUp, thumbsDown, lastTriggeredAt } =
        usage;
    let state: KodyRuleHealthState = 'healthy';
    if (triggers < MIN_TRIGGERS_TO_JUDGE) {
        state = 'low_data';
    } else if (thumbsDown >= NOISY_MIN_THUMBS_DOWN && thumbsDown > thumbsUp) {
        state = 'noisy';
    } else if (rate <= IGNORED_MAX_RATE) {
        state = 'ignored';
    }
    return {
        state,
        usage: { triggers, implemented, rate, thumbsUp, thumbsDown, lastTriggeredAt },
    };
}

@Injectable()
export class GetKodyRulesHealthUseCase {
    constructor(
        @Inject(COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN)
        private readonly reviewAnalytics: ICockpitReviewAnalyticsService,
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
    ) {}

    async execute(q: CockpitRangeQuery): Promise<KodyRuleHealthRow[]> {
        const [usageRows, rulesDoc, repoNames] = await Promise.all([
            this.reviewAnalytics.getKodyRulesUsage(q),
            this.kodyRulesService.findByOrganizationId(q.organizationId),
            this.reviewAnalytics.getRepositoryNames(q.organizationId),
        ]);

        const usageByRule = new Map(usageRows.map((u) => [u.ruleId, u]));
        const rules = (rulesDoc?.rules ?? []).filter(
            (r): r is IKodyRule & { uuid: string } =>
                Boolean(r.uuid) && r.status === KodyRulesStatus.ACTIVE,
        );

        // Only active rules are actionable — the table is for deciding what
        // to do with a rule (edit/scope/disable). Usage rows whose rule was
        // deleted or is no longer active are dropped: they can't be acted on
        // and would just be noise.
        const out: KodyRuleHealthRow[] = rules.map((rule) => {
            const { state, usage } = computeRuleState(
                usageByRule.get(rule.uuid),
            );
            // `'global'` is the org-wide sentinel (not a repo named "global");
            // normalize it — and empty strings — to null so consumers read
            // "no repository → global scope".
            const rawRepoId = rule.repositoryId ?? null;
            const repositoryId =
                rawRepoId && rawRepoId !== 'global' ? rawRepoId : null;
            return {
                ruleId: rule.uuid,
                title: rule.title,
                severity: rule.severity ?? null,
                repositoryId,
                repositoryName: repositoryId
                    ? (repoNames.get(repositoryId) ?? null)
                    : null,
                directoryPath: rule.path ? rule.path : null,
                state,
                ...usage,
            };
        });

        return out.sort((a, b) => b.triggers - a.triggers);
    }
}
