"use client";

import { Badge } from "@components/ui/badge";
import { useKodyRulesCount } from "@services/kodyRules/hooks";
import { useCustomMessagesOverrideCountsByRepository } from "@services/pull-request-messages/hooks";
import type { FormattedCustomMessageEntity } from "@services/pull-request-messages/types";
import type { ScopeTarget } from "src/core/layout/sidebar/scope-tools";
import { apiProxyPath } from "src/core/utils/api-proxy";
import { useFetch } from "src/core/utils/reactQuery";
import { safeArray } from "src/core/utils/safe-array";

import {
    countConfigOverridesForRoutes,
    countFormattedOverrides,
} from "../_utils/count-overrides";
import {
    FormattedConfigLevel,
    type FormattedGlobalCodeReviewConfig,
} from "../code-review/_types";

const useGlobalCustomMessagesOverrideCount = (enabled: boolean) => {
    const { data } = useFetch<FormattedCustomMessageEntity>(
        apiProxyPath("/pull-request-messages/find-by-repository-or-directory"),
        { params: { repositoryId: "global" } },
        enabled,
    );

    return countFormattedOverrides(
        data
            ? {
                  startReviewMessage: data.startReviewMessage,
                  endReviewMessage: data.endReviewMessage,
                  globalSettings: data.globalSettings,
              }
            : undefined,
        FormattedConfigLevel.GLOBAL,
    );
};

/**
 * How many settings a scope overrides across some pages: the config values
 * set at that level, plus the start/end review messages (they live under
 * "What Kody writes") and the scope's own Kody Rules. The requests behind the
 * last two are shared per repository, so a row per scope costs no more
 * fetches than one.
 */
export const OverrideCount = ({
    config,
    scope,
    pages,
}: {
    config: FormattedGlobalCodeReviewConfig;
    scope: ScopeTarget;
    pages: string[];
}) => {
    const isGlobal = scope.repositoryId === "global";
    const repository = isGlobal
        ? undefined
        : safeArray(config.repositories).find(
              (item) => item.id === scope.repositoryId,
          );
    const directory = scope.directoryId
        ? repository?.directories?.find((item) => item.id === scope.directoryId)
        : undefined;
    const level = isGlobal
        ? FormattedConfigLevel.GLOBAL
        : directory
          ? FormattedConfigLevel.DIRECTORY
          : FormattedConfigLevel.REPOSITORY;
    const scopeConfig = isGlobal
        ? config.configs
        : directory
          ? directory.configs
          : repository?.configs;

    const countsMessages = pages.includes("output");
    const countsRules = pages.includes("kody-rules") && !!repository;

    const globalMessagesCount = useGlobalCustomMessagesOverrideCount(
        isGlobal && countsMessages,
    );
    const { data: repositoryMessages } =
        useCustomMessagesOverrideCountsByRepository(
            repository?.id ?? "global",
            !!repository && countsMessages,
        );
    const kodyRulesCount = useKodyRulesCount(
        repository?.id ?? "global",
        directory?.id,
        countsRules,
    );

    const messagesCount = !countsMessages
        ? 0
        : isGlobal
          ? globalMessagesCount
          : directory
            ? (repositoryMessages?.directoryOverrideCounts?.find(
                  (item) => item.directoryId === directory.id,
              )?.overrideCount ?? 0)
            : (repositoryMessages?.repositoryOverrideCount ?? 0);

    const count =
        countConfigOverridesForRoutes(scopeConfig, pages, level) +
        messagesCount +
        (countsRules ? kodyRulesCount : 0);

    if (count === 0) return null;

    const description = `${count} setting${count === 1 ? "" : "s"} overridden at this level`;

    return (
        <span title={description} className="inline-flex shrink-0">
            <Badge
                variant="primary-dark"
                aria-hidden
                className="pointer-events-none h-5 min-w-5 rounded-full px-1.5 text-[10px] font-medium">
                {count}
            </Badge>
            <span className="sr-only">{description}</span>
        </span>
    );
};
