import {
    getBYOK,
    getLLMConfigStatus,
} from "@services/organizationParameters/fetch";
import { resolveByokModelCost } from "@services/usage/byok-cost";
import { getSummaryTokenUsage } from "@services/usage/fetch";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";
import { getSelectedDateRange } from "src/features/ee/cockpit/_helpers/get-selected-date-range";
import { validateOrganizationLicense } from "src/features/ee/subscription/_services/billing/fetch";

import { ByokPageClient } from "./_components/page.client";
import { isBYOKSubscriptionPlan } from "./_utils";

export default async function ByokPage() {
    const [byokConfig, llmConfigStatus, teamId, dateRange] = await Promise.all([
        getBYOK().catch(() => null),
        getLLMConfigStatus().catch(() => null),
        getGlobalSelectedTeamId().catch(() => undefined),
        getSelectedDateRange(),
    ]);

    // Per-model cost for the configured models. Scoped to the SAME date range +
    // BYOK flag the Costs screen uses, so the chip value matches the Costs
    // screen it deep-links to (the chip==Costs invariant). Best-effort: a
    // failed fetch just renders the models without a cost chip.
    const subscription = teamId
        ? await validateOrganizationLicense({ teamId }).catch(() => null)
        : null;
    const isBYOK = subscription ? isBYOKSubscriptionPlan(subscription) : false;

    const summary = await getSummaryTokenUsage({
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        byok: isBYOK,
    }).catch(() => null);

    const mainCost = resolveByokModelCost(
        byokConfig?.main?.model,
        summary?.byModel,
    );
    const fallbackCost = resolveByokModelCost(
        byokConfig?.fallback?.model,
        summary?.byModel,
    );

    // Human label for the window the cost covers (same range as Costs screen).
    const periodDays = Math.max(
        1,
        Math.round(
            (new Date(dateRange.endDate).getTime() -
                new Date(dateRange.startDate).getTime()) /
                86_400_000,
        ),
    );
    const periodLabel = `last ${periodDays} days`;

    // Carry the exact window into the deep-link so the Costs screen opens on the
    // SAME range the chip summed (COCKPIT_PARAM start/end) — otherwise the two
    // screens default differently ("14 days" vs "1 week") and the numbers/period
    // wouldn't match.
    const costRangeQuery = `start=${dateRange.startDate}&end=${dateRange.endDate}`;

    return (
        <ByokPageClient
            config={byokConfig}
            llmConfigStatus={llmConfigStatus}
            teamId={teamId ?? undefined}
            mainCost={mainCost}
            fallbackCost={fallbackCost}
            periodLabel={periodLabel}
            costRangeQuery={costRangeQuery}
        />
    );
}
