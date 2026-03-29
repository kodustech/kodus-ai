import type { FormattedCustomMessageEntity } from "@services/pull-request-messages/types";

type CustomMessagesLocalState = Pick<
    FormattedCustomMessageEntity,
    "startReviewMessage" | "endReviewMessage"
>;

type CustomMessagesGlobalSettingsState = NonNullable<
    FormattedCustomMessageEntity["globalSettings"]
>;

type CustomMessagesEditorState = {
    messages: CustomMessagesLocalState;
    globalSettings: CustomMessagesGlobalSettingsState;
};

type HasCustomMessagesPendingChangesParams = {
    pullRequestMessages: FormattedCustomMessageEntity;
    messages: CustomMessagesLocalState;
    globalSettings: CustomMessagesGlobalSettingsState;
};

type CustomMessagesDirtySectionParams = {
    pullRequestMessages: FormattedCustomMessageEntity;
    editorState: CustomMessagesEditorState;
};

export type CustomMessagesDirtySection =
    | "startReviewMessage"
    | "endReviewMessage"
    | "globalSettings";

export const buildCustomMessagesEditorState = (
    pullRequestMessages: FormattedCustomMessageEntity,
): CustomMessagesEditorState => ({
    messages: {
        startReviewMessage: pullRequestMessages.startReviewMessage,
        endReviewMessage: pullRequestMessages.endReviewMessage,
    },
    globalSettings: {
        hideComments: pullRequestMessages.globalSettings?.hideComments,
        suggestionCopyPrompt:
            pullRequestMessages.globalSettings?.suggestionCopyPrompt,
    },
});

export const hasCustomMessagesPendingChanges = ({
    pullRequestMessages,
    messages,
    globalSettings,
}: HasCustomMessagesPendingChangesParams) =>
    messages.startReviewMessage.status?.value !==
        pullRequestMessages.startReviewMessage.status?.value ||
    messages.startReviewMessage.content?.value !==
        pullRequestMessages.startReviewMessage.content?.value ||
    messages.endReviewMessage.status?.value !==
        pullRequestMessages.endReviewMessage.status?.value ||
    messages.endReviewMessage.content?.value !==
        pullRequestMessages.endReviewMessage.content?.value ||
    globalSettings.hideComments?.value !==
        (pullRequestMessages.globalSettings?.hideComments?.value ?? false) ||
    globalSettings.suggestionCopyPrompt?.value !==
        (pullRequestMessages.globalSettings?.suggestionCopyPrompt?.value ??
            true);

export const getCustomMessagesDirtySection = ({
    pullRequestMessages,
    editorState,
}: CustomMessagesDirtySectionParams): CustomMessagesDirtySection | null => {
    const startReviewMessageChanged = hasCustomMessagesPendingChanges({
        pullRequestMessages,
        messages: {
            startReviewMessage: editorState.messages.startReviewMessage,
            endReviewMessage: pullRequestMessages.endReviewMessage,
        },
        globalSettings: pullRequestMessages.globalSettings,
    });

    if (startReviewMessageChanged) {
        return "startReviewMessage";
    }

    const endReviewMessageChanged = hasCustomMessagesPendingChanges({
        pullRequestMessages,
        messages: {
            startReviewMessage: pullRequestMessages.startReviewMessage,
            endReviewMessage: editorState.messages.endReviewMessage,
        },
        globalSettings: pullRequestMessages.globalSettings,
    });

    if (endReviewMessageChanged) {
        return "endReviewMessage";
    }

    const globalSettingsChanged = hasCustomMessagesPendingChanges({
        pullRequestMessages,
        messages: {
            startReviewMessage: pullRequestMessages.startReviewMessage,
            endReviewMessage: pullRequestMessages.endReviewMessage,
        },
        globalSettings: editorState.globalSettings,
    });

    return globalSettingsChanged ? "globalSettings" : null;
};
