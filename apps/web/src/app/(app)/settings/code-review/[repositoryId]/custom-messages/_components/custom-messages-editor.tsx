"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@components/ui/tabs";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { isCentralizedPrResponse } from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { savePullRequestMessages } from "@services/pull-request-messages/fetch";
import { useSuspensePullRequestMessages } from "@services/pull-request-messages/hooks";
import type { CustomMessageConfig } from "@services/pull-request-messages/types";
import { useQueryClient } from "@tanstack/react-query";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { apiProxyPath } from "src/core/utils/api-proxy";
import { unformatConfig } from "src/core/utils/helpers";

import { getCentralizedPrToastPayload } from "../../../_utils/centralized-pr-feedback";
import {
    buildCustomMessagesEditorState,
    getCustomMessagesDirtySection,
    hasCustomMessagesPendingChanges,
} from "../../../_utils/custom-messages-state";
import { buildCodeReviewSettingsScopeKey } from "../../../_utils/settings-shell";
import { useCodeReviewRouteParams } from "../../../../_hooks";
import { HiddenComments } from "./hidden-comments";
import { LLMPromptToggle } from "./llm-prompt";
import { TabContent } from "./tab-content";

/**
 * State, dirty tracking and save for the custom messages, independent of
 * the page hosting them (Custom Messages page or the Output tab). Suspends
 * on the messages query, so hosts need a boundary.
 */
export const useCustomMessagesEditor = () => {
    const { teamId } = useSelectedTeamId();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const pullRequestMessages = useSuspensePullRequestMessages();
    const queryClient = useQueryClient();
    const initialState = pullRequestMessages;
    const scopeKey = buildCodeReviewSettingsScopeKey(
        teamId,
        repositoryId,
        directoryId,
    );

    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );

    const [editorState, setEditorState] = useState(() =>
        buildCustomMessagesEditorState(pullRequestMessages),
    );
    const hydratedStateKeyRef = useRef("");

    useEffect(() => {
        const nextHydrationKey = `${scopeKey}::${pullRequestMessages.uuid ?? "initial"}`;

        if (hydratedStateKeyRef.current === nextHydrationKey) return;

        setEditorState(buildCustomMessagesEditorState(pullRequestMessages));
        hydratedStateKeyRef.current = nextHydrationKey;
    }, [pullRequestMessages, scopeKey]);

    const hasPendingChanges = hasCustomMessagesPendingChanges({
        pullRequestMessages,
        messages: editorState.messages,
        globalSettings: editorState.globalSettings,
    });
    const dirtySection = getCustomMessagesDirtySection({
        pullRequestMessages,
        editorState,
    });
    const wasStartReviewMessageChanged = dirtySection === "startReviewMessage";
    const wasEndReviewMessageChanged = dirtySection === "endReviewMessage";
    const wasErrorReviewMessageChanged = dirtySection === "errorReviewMessage";
    const wasGlobalSettingsChanged = dirtySection === "globalSettings";
    const handleReset = useCallback(() => {
        setEditorState(buildCustomMessagesEditorState(pullRequestMessages));
    }, [pullRequestMessages]);

    const [action, { loading: isSaving }] = useAsyncAction(async () => {
        try {
            const unformattedMessages = unformatConfig(editorState.messages);
            const unformattedGlobalSettings = unformatConfig(
                editorState.globalSettings,
            );

            const mutationResult = await savePullRequestMessages({
                uuid: pullRequestMessages.uuid,
                teamId,
                repositoryId,
                directoryId,
                startReviewMessage: unformattedMessages.startReviewMessage,
                endReviewMessage: unformattedMessages.endReviewMessage,
                errorReviewMessage: unformattedMessages.errorReviewMessage,
                globalSettings: unformattedGlobalSettings,
            });

            await queryClient.invalidateQueries({
                predicate: (query) =>
                    (query.queryKey[0] as string)?.startsWith(
                        apiProxyPath("/pull-request-messages"),
                    ),
            });

            if (isCentralizedPrResponse(mutationResult)) {
                toast(
                    getCentralizedPrToastPayload(
                        mutationResult,
                        "Custom messages change proposed through centralized pull request.",
                    ),
                );
                return;
            }

            toast({
                title: "Custom messages saved",
                variant: "success",
            });
        } catch (error) {
            console.error("Error saving custom messages:", error);

            toast({
                title: "Failed to save custom messages",
                description: "Please try again later.",
                variant: "warning",
            });
        }
    });

    const scrollToDirtyField = useCallback(() => {
        const fieldName = wasStartReviewMessageChanged
            ? "startReviewMessage"
            : wasEndReviewMessageChanged
              ? "endReviewMessage"
              : wasErrorReviewMessageChanged
                ? "errorReviewMessage"
                : "globalSettings";

        const fieldElement = document.querySelector(
            `[data-field-name="${fieldName}"]`,
        );
        if (fieldElement) {
            fieldElement.scrollIntoView({
                behavior: "smooth",
                block: "center",
            });
            fieldElement.classList.add("field-highlight");
            window.setTimeout(() => {
                fieldElement.classList.remove("field-highlight");
            }, 1800);
            return;
        }

        const headerElement = document.querySelector("[data-header-actions]");
        if (headerElement) {
            headerElement.scrollIntoView({
                behavior: "smooth",
                block: "center",
            });
            headerElement.classList.add("field-highlight");
            window.setTimeout(() => {
                headerElement.classList.remove("field-highlight");
            }, 1800);
        }
    }, [
        wasEndReviewMessageChanged,
        wasErrorReviewMessageChanged,
        wasGlobalSettingsChanged,
        wasStartReviewMessageChanged,
    ]);

    return {
        editorState,
        setEditorState,
        initialState,
        canEdit,
        hasPendingChanges,
        dirtySection,
        handleReset,
        save: action,
        isSaving,
        scrollToDirtyField,
    };
};

export type CustomMessagesEditor = ReturnType<typeof useCustomMessagesEditor>;

export type CustomMessageType =
    "startReviewMessage" | "endReviewMessage" | "errorReviewMessage";

/** Props for one message's `TabContent`, bound to the editor state. */
export const bindMessage = (
    editor: CustomMessagesEditor,
    type: CustomMessageType,
) => ({
    type,
    value: editor.editorState.messages[type],
    initialState: editor.initialState[type],
    canEdit: editor.canEdit,
    onChangeAction: (next: CustomMessageConfig["startReviewMessage"]) => {
        editor.setEditorState((prev) => ({
            ...prev,
            messages: {
                ...prev.messages,
                [type]: {
                    content: {
                        ...prev.messages[type].content,
                        value: next.content,
                    },
                    status: {
                        ...prev.messages[type].status,
                        value: next.status,
                    },
                },
            },
        }));
    },
});

/** Props for the two global-settings toggles, bound to the editor state. */
export const bindGlobalSettings = (editor: CustomMessagesEditor) => {
    const { editorState, setEditorState, initialState, canEdit } = editor;
    const set = (
        key: "hideComments" | "suggestionCopyPrompt",
        value: boolean | undefined,
    ) =>
        setEditorState((prev) => ({
            ...prev,
            globalSettings: {
                ...prev.globalSettings,
                [key]: { ...(prev.globalSettings[key] ?? {}), value },
            },
        }));
    return {
        hiddenComments: {
            hideComments: editorState.globalSettings.hideComments,
            initialState: initialState.globalSettings?.hideComments,
            onHideCommentsChangeAction: (value: boolean) =>
                set("hideComments", value),
            handleRevert: () =>
                set(
                    "hideComments",
                    initialState.globalSettings?.hideComments?.value,
                ),
            canEdit,
        },
        llmPrompt: {
            suggestionCopyPrompt:
                editorState.globalSettings.suggestionCopyPrompt,
            initialState: initialState.globalSettings?.suggestionCopyPrompt,
            onsuggestionCopyPromptChangeAction: (value: boolean) =>
                set("suggestionCopyPrompt", value),
            handleRevert: () =>
                set(
                    "suggestionCopyPrompt",
                    initialState.globalSettings?.suggestionCopyPrompt?.value,
                ),
            canEdit,
        },
    };
};

/** The start / end / error / global-settings tabs bound to an editor. */
export const CustomMessagesEditorTabs = ({
    editor,
    hidePreview = false,
    hideGlobalSettings = false,
    value,
    onValueChange,
}: {
    editor: CustomMessagesEditor;
    /** The Output tab renders one PR preview for the whole page instead. */
    hidePreview?: boolean;
    /** Hosts that show the visibility toggles elsewhere drop the 4th tab. */
    hideGlobalSettings?: boolean;
    /** Controlled active tab, so a host can follow which message is edited. */
    value?: string;
    onValueChange?: (value: string) => void;
}) => {
    const { dirtySection } = editor;
    const globalSettings = bindGlobalSettings(editor);
    const mark = (section: typeof dirtySection) =>
        dirtySection === section ? (
            <span className="text-tertiary-light">*</span>
        ) : null;

    return (
        <Tabs
            defaultValue="start-review-message"
            value={value}
            onValueChange={onValueChange}
            className="flex-1">
            <TabsList>
                <TabsTrigger value="start-review-message">
                    Review starts
                    {mark("startReviewMessage")}
                </TabsTrigger>
                <TabsTrigger value="end-review-message">
                    Review ends
                    {mark("endReviewMessage")}
                </TabsTrigger>
                <TabsTrigger value="error-review-message">
                    Review fails
                    {mark("errorReviewMessage")}
                </TabsTrigger>
                {!hideGlobalSettings && (
                    <TabsTrigger value="global-settings">
                        Visibility
                        {mark("globalSettings")}
                    </TabsTrigger>
                )}
            </TabsList>

            <TabsContent
                forceMount
                className="flex-1"
                value="start-review-message"
                data-field-name="startReviewMessage">
                <TabContent
                    {...bindMessage(editor, "startReviewMessage")}
                    showPreview={!hidePreview}
                />
            </TabsContent>

            <TabsContent
                forceMount
                className="flex-1"
                value="end-review-message"
                data-field-name="endReviewMessage">
                <TabContent
                    {...bindMessage(editor, "endReviewMessage")}
                    showPreview={!hidePreview}
                />
            </TabsContent>

            <TabsContent
                forceMount
                className="flex-1"
                value="error-review-message"
                data-field-name="errorReviewMessage">
                <TabContent
                    {...bindMessage(editor, "errorReviewMessage")}
                    showPreview={!hidePreview}
                />
            </TabsContent>

            {!hideGlobalSettings && (
                <TabsContent
                    forceMount
                    className="flex-1 gap-y-4"
                    value="global-settings"
                    data-field-name="globalSettings">
                    <HiddenComments {...globalSettings.hiddenComments} />
                    <LLMPromptToggle {...globalSettings.llmPrompt} />
                </TabsContent>
            )}
        </Tabs>
    );
};
