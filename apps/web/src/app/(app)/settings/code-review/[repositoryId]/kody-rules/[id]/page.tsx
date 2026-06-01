import { redirect } from "next/navigation";
import {
    getAllOrganizationKodyRules,
    getInheritedKodyRules,
    getKodyRulesByRepositoryId,
} from "@services/kodyRules/fetch";
import { resolveKodyRuleById } from "src/core/utils/kody-rules/resolve-rule";
import { addSearchParamsToUrl } from "src/core/utils/url";

import { KodyRuleModalClient } from "./modal-client";

export default async function KodyRuleDetailPage({
    params,
    searchParams,
}: {
    params: Promise<{ repositoryId: string; id: string }>;
    searchParams: Promise<{
        directoryId?: string;
        teamId?: string;
        tab?: "review-rules" | "memories" | "configuration";
    }>;
}) {
    try {
        // Await params first (Next.js 15 requirement)
        const { repositoryId, id } = await params;
        const { directoryId, teamId, tab } = await searchParams;

        const rule = await resolveKodyRuleById(
            id,
            { repositoryId, directoryId, teamId },
            {
                byRepo: (repoId, dirId) =>
                    getKodyRulesByRepositoryId(repoId, dirId),
                inherited: (p) => getInheritedKodyRules(p),
                all: () => getAllOrganizationKodyRules(),
            },
        );

        if (!rule) {
            const url = addSearchParamsToUrl(
                `/settings/code-review/${repositoryId}/kody-rules`,
                { directoryId, tab },
            );
            redirect(url);
        }

        return (
            <KodyRuleModalClient
                rule={rule as any}
                repositoryId={repositoryId}
                directoryId={directoryId}
            />
        );
    } catch (error) {
        console.error("Error loading rule:", error);
        redirect("/settings/code-review");
    }
}
