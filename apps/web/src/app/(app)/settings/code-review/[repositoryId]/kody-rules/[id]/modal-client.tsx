"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { KODY_RULES_PATHS } from "@services/kodyRules";
import { useSuspenseKodyRulesByRepositoryId } from "@services/kodyRules/hooks";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useQueryClient } from "@tanstack/react-query";
import { addSearchParamsToUrl } from "src/core/utils/url";
import type { KodyRule } from "src/lib/services/kodyRules/types";

import { KodyRuleAddOrUpdateItemModal } from "../../../_components/modal";
import { useFullCodeReviewConfig } from "../../../../_components/context";

export function KodyRuleModalClient({
    rule,
    repositoryId,
    directoryId,
}: {
    rule: KodyRule;
    repositoryId: string;
    directoryId?: string;
}) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const config = useFullCodeReviewConfig();
    const queryClient = useQueryClient();
    const scopeRules = useSuspenseKodyRulesByRepositoryId(
        repositoryId,
        directoryId,
    );
    // The suspense query has resolved before the form mounts. Initialize from
    // it immediately: useForm defaultValues only apply on that first render.
    const hydratedRule =
        scopeRules.find((currentRule) => currentRule.uuid === rule.uuid) ?? rule;
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );

    const handleClose = async () => {
        const tab = searchParams.get("tab") ?? undefined;

        await queryClient.invalidateQueries({
            predicate: (query) =>
                query.queryKey[0] ===
                    KODY_RULES_PATHS.FIND_BY_ORGANIZATION_ID_AND_FILTER ||
                query.queryKey[0] === KODY_RULES_PATHS.GET_INHERITED_RULES ||
                query.queryKey[0] === KODY_RULES_PATHS.FIND_BY_ORGANIZATION_ID,
        });

        router.push(
            addSearchParamsToUrl(
                `/settings/code-review/${repositoryId}/kody-rules`,
                { directoryId, tab },
            ),
        );
    };

    const directory = config?.repositories
        .find((r) => r.id === repositoryId)
        ?.directories?.find((d) => d.id === directoryId);

    return (
        <KodyRuleAddOrUpdateItemModal
            key={`${repositoryId}:${directoryId ?? ""}:${rule.uuid}`}
            rule={hydratedRule}
            onClose={handleClose}
            directory={directory}
            repositoryId={repositoryId}
            ruleType={hydratedRule.type}
            canEdit={canEdit}
        />
    );
}
