import { redirect } from "next/navigation";
import { getLibraryKodyRulesWithFeedback } from "@services/kodyRules/fetch";
import { getTeamParameters } from "@services/parameters/fetch";
import { ParametersConfigKey } from "@services/parameters/types";
import type { AutomationCodeReviewConfigType } from "src/app/(app)/settings/code-review/_types";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";

import { KodyRuleLibraryItemModal } from "./_components/modal";

export default async function Route(context: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ repositoryId?: string; directoryId?: string }>;
}) {
    const params = await context.params;
    const searchParams = await context.searchParams;

    const rulesResponse = await getLibraryKodyRulesWithFeedback({
        page: 1,
        limit: 1000, // Use maximum allowed limit to get all rules
    });

    const rules = rulesResponse?.data || [];
    const rule = rules.find((r) => r.uuid === params.id);
    if (!rule) redirect("/library/kody-rules");

    const teamId = await getGlobalSelectedTeamId();

    const { configValue } = await getTeamParameters<{
        configValue: AutomationCodeReviewConfigType;
    }>({
        key: ParametersConfigKey.CODE_REVIEW_CONFIG,
        teamId,
    });

    return (
        <KodyRuleLibraryItemModal
            key={rule.uuid}
            rule={rule}
            repositoryId={searchParams.repositoryId}
            directoryId={searchParams.directoryId}
            repositories={configValue.repositories}
        />
    );
}
