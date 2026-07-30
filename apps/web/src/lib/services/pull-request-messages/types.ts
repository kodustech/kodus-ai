import { FormattedConfig } from "src/app/(app)/settings/code-review/_types";
import { LiteralUnion } from "src/core/types";

export enum PullRequestMessageStatus {
    EVERY_PUSH = "every_push",
    ONLY_WHEN_OPENED = "only_when_opened",
    OFF = "off",
    ACTIVE = "active",
    INACTIVE = "inactive",
}

export type CustomMessageEntity = CustomMessageConfig & {
    uuid?: string;
    repositoryId: LiteralUnion<"global">;
    directoryId?: string;
};

export type CustomMessageConfig = {
    startReviewMessage: {
        content: string;
        status: PullRequestMessageStatus;
    };
    endReviewMessage: {
        content: string;
        status: PullRequestMessageStatus;
    };
    errorReviewMessage: {
        content: string;
        status: PullRequestMessageStatus;
    };
    globalSettings: {
        hideComments: boolean;
        suggestionCopyPrompt: boolean;
    };
};

export type FormattedCustomMessageEntity = Pick<
    CustomMessageEntity,
    "uuid" | "repositoryId" | "directoryId"
> &
    FormattedCustomMessageConfig;

export type FormattedCustomMessageConfig = FormattedConfig<CustomMessageConfig>;
