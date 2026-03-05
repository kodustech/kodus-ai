import { redirect } from "next/navigation";
import {
    getInheritedKodyRules,
    getKodyRulesByRepositoryId,
} from "@services/kodyRules/fetch";
import { addSearchParamsToUrl } from "src/core/utils/url";

import { KodyRuleModalClient } from "./modal-client";

export default async function KodyRuleDetailPage({
    params,
    searchParams,
}: {
    params: Promise<{ repositoryId: string; id: string }>;
    searchParams: Promise<{
        directoryId: string;
        teamId: string;
        tab?: "review-rules" | "memories" | "configuration";
    }>;
}) {
    try {
        // Await params first (Next.js 15 requirement)
        const { repositoryId, id } = await params;
        const { directoryId, teamId, tab } = await searchParams;

        const kodyRules = await getKodyRulesByRepositoryId(
            repositoryId,
            directoryId,
        );

        let rule = kodyRules.find((r) => r.uuid === id);
        if (!rule) {
            const { directoryRules, globalRules, repoRules } =
                await getInheritedKodyRules({
                    teamId,
                    repositoryId,
                    directoryId,
                });
            const allRules = [...directoryRules, ...globalRules, ...repoRules];
            rule = allRules.find((r) => r.uuid === id);
        }

        if (!rule) {
            const url = addSearchParamsToUrl(
                `/settings/code-review/${repositoryId}/kody-rules`,
                { directoryId, tab },
            );
            redirect(url);
        }

        return (
            <KodyRuleModalClient
                rule={rule}
                repositoryId={repositoryId}
                directoryId={directoryId}
            />
        );
    } catch (error) {
        console.error("Error loading rule:", error);
        redirect("/settings/code-review");
    }
}
