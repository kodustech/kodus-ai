import { useDefaultCodeReviewConfig } from "src/app/(app)/settings/_components/context";
import { useCodeReviewRouteParams } from "src/app/(app)/settings/_hooks";
import { FormattedConfigLevel } from "src/app/(app)/settings/code-review/_types";
import type { LiteralUnion } from "src/core/types";
import { pathToApiUrl } from "src/core/utils/helpers";
import { useFetch, useSuspenseFetch } from "src/core/utils/reactQuery";

import {
    FormattedCustomMessageEntity,
    PullRequestMessageStatus,
} from "./types";

export const useSuspensePullRequestMessages = () => {
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const defaults = useDefaultCodeReviewConfig()?.customMessages;

    return useSuspenseFetch<FormattedCustomMessageEntity>(
        pathToApiUrl("/pull-request-messages/find-by-repository-or-directory"),
        {
            params: {
                repositoryId,
                directoryId,
            },
        },
        {
            fallbackData: {
                uuid: undefined as any,
                repositoryId,
                directoryId,
                startReviewMessage: {
                    content: {
                        level: FormattedConfigLevel.DEFAULT,
                        value: defaults?.startReviewMessage?.content ?? "",
                    },
                    status: {
                        level: FormattedConfigLevel.DEFAULT,
                        value:
                            defaults?.startReviewMessage?.status ??
                            PullRequestMessageStatus.EVERY_PUSH,
                    },
                },
                endReviewMessage: {
                    content: {
                        level: FormattedConfigLevel.DEFAULT,
                        value: defaults?.endReviewMessage?.content ?? "",
                    },
                    status: {
                        level: FormattedConfigLevel.DEFAULT,
                        value:
                            defaults?.endReviewMessage?.status ??
                            PullRequestMessageStatus.EVERY_PUSH,
                    },
                },
                globalSettings: {
                    hideComments: {
                        level: FormattedConfigLevel.DEFAULT,
                        value: defaults?.globalSettings?.hideComments ?? false,
                    },
                    suggestionCopyPrompt: {
                        level: FormattedConfigLevel.DEFAULT,
                        value:
                            defaults?.globalSettings?.suggestionCopyPrompt ??
                            true,
                    },
                },
            },
        },
    );
};

// Fetch messages for an explicit scope (useful to get parent scope value)
export const useSuspensePullRequestMessagesFor = (
    repositoryId: LiteralUnion<"global">,
    directoryId?: string,
) => {
    const defaults = useDefaultCodeReviewConfig()?.customMessages;

    return useSuspenseFetch<FormattedCustomMessageEntity>(
        pathToApiUrl("/pull-request-messages/find-by-repository-or-directory"),
        {
            params: {
                repositoryId,
                directoryId,
            },
        },
        {
            fallbackData: {
                uuid: undefined as any,
                repositoryId,
                directoryId,
                startReviewMessage: {
                    content: {
                        level: FormattedConfigLevel.DEFAULT,
                        value: defaults?.startReviewMessage?.content ?? "",
                    },
                    status: {
                        level: FormattedConfigLevel.DEFAULT,
                        value:
                            defaults?.startReviewMessage?.status ??
                            PullRequestMessageStatus.EVERY_PUSH,
                    },
                },
                endReviewMessage: {
                    content: {
                        level: FormattedConfigLevel.DEFAULT,
                        value: defaults?.endReviewMessage?.content ?? "",
                    },
                    status: {
                        level: FormattedConfigLevel.DEFAULT,
                        value:
                            defaults?.endReviewMessage?.status ??
                            PullRequestMessageStatus.EVERY_PUSH,
                    },
                },
                globalSettings: {
                    hideComments: {
                        level: FormattedConfigLevel.DEFAULT,
                        value: defaults?.globalSettings?.hideComments ?? false,
                    },
                    suggestionCopyPrompt: {
                        level: FormattedConfigLevel.DEFAULT,
                        value:
                            defaults?.globalSettings?.suggestionCopyPrompt ??
                            true,
                    },
                },
            },
        },
    );
};

// Parent scope: repository <- global; directory <- repository; global has no parent
export const useSuspenseParentPullRequestMessages = () => {
    const { repositoryId, directoryId } = useCodeReviewRouteParams();

    // repository parent is global; directory parent is repository (same repo, no directory)
    const parentRepositoryId: LiteralUnion<"global"> = directoryId
        ? repositoryId
        : repositoryId === "global"
          ? "global"
          : "global";
    const parentDirectoryId: string | undefined = directoryId
        ? undefined
        : undefined;

    return useSuspensePullRequestMessagesFor(
        parentRepositoryId,
        parentDirectoryId,
    );
};

export type PullRequestMessagesOverrideCountsByRepository = {
    repositoryId: string;
    repositoryOverrideCount: number;
    directoryOverrideCounts: Array<{
        directoryId: string;
        overrideCount: number;
    }>;
};

export const useCustomMessagesOverrideCountsByRepository = (
    repositoryId: string,
    enabled = true,
) => {
    return useFetch<PullRequestMessagesOverrideCountsByRepository>(
        pathToApiUrl("/pull-request-messages/override-counts-by-repository"),
        {
            params: {
                repositoryId,
            },
        },
        enabled,
        {
            staleTime: 60_000,
        },
    );
};
