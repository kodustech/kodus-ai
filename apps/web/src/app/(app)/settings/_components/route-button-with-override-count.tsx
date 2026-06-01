"use client";

import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import type { FormattedCustomMessageEntity } from "@services/pull-request-messages/types";
import type { FormattedConfigLevel } from "src/app/(app)/settings/code-review/_types";
import { apiProxyPath } from "src/core/utils/api-proxy";
import { useFetch } from "src/core/utils/reactQuery";

import {
    countConfigOverridesByRoute,
    countFormattedOverrides,
} from "../_utils/count-overrides";
import type { FormattedCodeReviewConfig } from "../code-review/_types";

export const RouteButtonWithOverrideCount = ({
    label,
    href,
    to,
    active,
    level,
    config,
    customMessagesOverrideCount,
    kodyRulesOverrideCount,
}: {
    label: string;
    href: string;
    to: string;
    active: boolean;
    level: FormattedConfigLevel;
    config?: FormattedCodeReviewConfig;
    customMessagesOverrideCount?: number;
    kodyRulesOverrideCount?: number;
}) => {
    const isCustomMessagesRoute = href === "custom-messages";
    const isKodyRulesRoute = href === "kody-rules";

    const configOverrideCount =
        countConfigOverridesByRoute(config, href, level) ?? 0;

    let routeOverrideCount: number | null;
    if (isCustomMessagesRoute) {
        routeOverrideCount = customMessagesOverrideCount ?? 0;
    } else if (isKodyRulesRoute) {
        routeOverrideCount =
            configOverrideCount + (kodyRulesOverrideCount ?? 0);
    } else {
        routeOverrideCount = configOverrideCount;
    }

    return (
        <Link className="w-full" href={to}>
            <Button
                decorative
                size="sm"
                variant="cancel"
                active={active}
                rightIcon={
                    routeOverrideCount !== null && routeOverrideCount > 0 ? (
                        <Badge
                            variant="primary-dark"
                            className="h-5 min-w-5 rounded-full px-1.5 text-[10px] font-medium">
                            {routeOverrideCount}
                        </Badge>
                    ) : null
                }
                className="min-h-auto w-full justify-start px-0 py-2">
                {label}
            </Button>
        </Link>
    );
};

export const useCustomMessagesOverrideCount = ({
    scopeRepositoryId,
    scopeDirectoryId,
    level,
    enabled,
}: {
    scopeRepositoryId: string;
    scopeDirectoryId?: string;
    level: FormattedConfigLevel;
    enabled: boolean;
}) => {
    const { data: customMessagesData } = useFetch<FormattedCustomMessageEntity>(
        apiProxyPath("/pull-request-messages/find-by-repository-or-directory"),
        {
            params: {
                repositoryId: scopeRepositoryId,
                directoryId: scopeDirectoryId,
            },
        },
        enabled,
    );

    return countFormattedOverrides(
        customMessagesData
            ? {
                  startReviewMessage: customMessagesData.startReviewMessage,
                  endReviewMessage: customMessagesData.endReviewMessage,
                  globalSettings: customMessagesData.globalSettings,
              }
            : undefined,
        level,
    );
};
