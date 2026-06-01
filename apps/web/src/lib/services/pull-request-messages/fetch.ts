import type { CentralizedPrResponse } from "@services/parameters/types";
import type { LiteralUnion } from "src/core/types";
import { axiosAuthorized } from "src/core/utils/axios";
import { pathToApiUrl } from "src/core/utils/helpers";

import { PullRequestMessageStatus } from "./types";

export const savePullRequestMessages = async ({
    uuid,
    teamId,
    repositoryId,
    startReviewMessage,
    endReviewMessage,
    directoryId,
    globalSettings,
}: {
    uuid?: string;
    teamId: string;
    repositoryId: LiteralUnion<"global">;
    directoryId?: string;
    startReviewMessage: {
        content: string;
        status: PullRequestMessageStatus;
    };
    endReviewMessage?: {
        content: string;
        status: PullRequestMessageStatus;
    };
    globalSettings?: {
        hideComments: boolean;
        suggestionCopyPrompt: boolean;
    };
}): Promise<void | CentralizedPrResponse> => {
    const response = await axiosAuthorized.post<void | CentralizedPrResponse>(
        pathToApiUrl("/pull-request-messages"),
        {
            uuid,
            teamId,
            directoryId,
            endReviewMessage,
            startReviewMessage,
            globalSettings,
            repositoryId: repositoryId === "global" ? null : repositoryId,
            configLevel:
                repositoryId === "global"
                    ? "global"
                    : directoryId
                      ? "directory"
                      : "repository",
        },
    );

    if (response && typeof response === "object" && "data" in response) {
        return (response as { data?: void | CentralizedPrResponse }).data;
    }

    return response;
};
