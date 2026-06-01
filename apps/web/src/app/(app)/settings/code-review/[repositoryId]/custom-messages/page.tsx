"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@components/ui/tabs";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { isCentralizedPrResponse } from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { savePullRequestMessages } from "@services/pull-request-messages/fetch";
import { useSuspensePullRequestMessages } from "@services/pull-request-messages/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { RotateCcwIcon, SaveIcon } from "lucide-react";
import { PageBoundary } from "src/core/components/page-boundary";
import { useUnsavedChangesGuard } from "src/core/hooks/use-unsaved-changes-guard";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { unformatConfig } from "src/core/utils/helpers";
import { apiProxyPath } from "src/core/utils/api-proxy";

import { CodeReviewPagesBreadcrumb } from "../../_components/breadcrumb";
import { CentralizedConfigReadOnlyAlert } from "../../_components/centralized-config-readonly-alert";
import { CodeReviewSaveButton } from "../../_components/save-button";
import { getCentralizedPrToastPayload } from "../../_utils/centralized-pr-feedback";
import {
    buildCustomMessagesEditorState,
    getCustomMessagesDirtySection,
    hasCustomMessagesPendingChanges,
} from "../../_utils/custom-messages-state";
import { buildCodeReviewSettingsScopeKey } from "../../_utils/settings-shell";
import { useCodeReviewRouteParams } from "../../../_hooks";
import { HiddenComments } from "./_components/hidden-comments";
import { LLMPromptToggle } from "./_components/llm-prompt";
import { TabContent } from "./_components/tab-content";

function CustomMessagesContent() {
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
        wasGlobalSettingsChanged,
        wasStartReviewMessageChanged,
    ]);

    useUnsavedChangesGuard({
        id: "custom-messages",
        isDirty: hasPendingChanges || isSaving,
        onBlock: scrollToDirtyField,
    });

    return (
        <Page.Root>
            <Page.Header>
                <CodeReviewPagesBreadcrumb pageName="Custom messages" />
            </Page.Header>

            <Page.Header>
                <Page.Title>Custom Messages</Page.Title>

                <Page.HeaderActions>
                    {hasPendingChanges && (
                        <Button
                            size="md"
                            variant="cancel"
                            leftIcon={<RotateCcwIcon />}
                            onClick={handleReset}
                            disabled={isSaving}>
                            Reset
                        </Button>
                    )}

                    <CodeReviewSaveButton
                        size="md"
                        variant="primary"
                        loading={isSaving}
                        leftIcon={<SaveIcon />}
                        onClick={() => action()}
                        disabled={!canEdit || !hasPendingChanges}>
                        Save changes
                    </CodeReviewSaveButton>
                </Page.HeaderActions>
            </Page.Header>

            <Page.Content>
                <CentralizedConfigReadOnlyAlert />
                <Tabs defaultValue="start-review-message" className="flex-1">
                    <TabsList>
                        <TabsTrigger value="start-review-message">
                            Start Review message
                            {wasStartReviewMessageChanged && (
                                <span className="text-tertiary-light">*</span>
                            )}
                        </TabsTrigger>
                        <TabsTrigger value="end-review-message">
                            End Review message
                            {wasEndReviewMessageChanged && (
                                <span className="text-tertiary-light">*</span>
                            )}
                        </TabsTrigger>
                        <TabsTrigger value="global-settings">
                            Global Settings
                            {wasGlobalSettingsChanged && (
                                <span className="text-tertiary-light">*</span>
                            )}
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent
                        forceMount
                        className="flex-1"
                        value="start-review-message"
                        data-field-name="startReviewMessage">
                        <TabContent
                            type="startReviewMessage"
                            value={editorState.messages.startReviewMessage}
                            initialState={initialState.startReviewMessage}
                            onChangeAction={(startReviewMessage) => {
                                setEditorState((prev) => ({
                                    ...prev,
                                    messages: {
                                        ...prev.messages,
                                        startReviewMessage: {
                                            content: {
                                                ...prev.messages
                                                    .startReviewMessage.content,
                                                value: startReviewMessage.content,
                                            },
                                            status: {
                                                ...prev.messages
                                                    .startReviewMessage.status,
                                                value: startReviewMessage.status,
                                            },
                                        },
                                    },
                                }));
                            }}
                            canEdit={canEdit}
                        />
                    </TabsContent>

                    <TabsContent
                        forceMount
                        className="flex-1"
                        value="end-review-message"
                        data-field-name="endReviewMessage">
                        <TabContent
                            type="endReviewMessage"
                            value={editorState.messages.endReviewMessage}
                            initialState={initialState.endReviewMessage}
                            onChangeAction={(endReviewMessage) => {
                                setEditorState((prev) => ({
                                    ...prev,
                                    messages: {
                                        ...prev.messages,
                                        endReviewMessage: {
                                            content: {
                                                ...prev.messages
                                                    .endReviewMessage.content,
                                                value: endReviewMessage.content,
                                            },
                                            status: {
                                                ...prev.messages
                                                    .endReviewMessage.status,
                                                value: endReviewMessage.status,
                                            },
                                        },
                                    },
                                }));
                            }}
                            canEdit={canEdit}
                        />
                    </TabsContent>

                    <TabsContent
                        forceMount
                        className="flex-1 gap-y-4"
                        value="global-settings"
                        data-field-name="globalSettings">
                        <HiddenComments
                            hideComments={
                                editorState.globalSettings.hideComments
                            }
                            initialState={
                                initialState.globalSettings?.hideComments
                            }
                            onHideCommentsChangeAction={(value) => {
                                setEditorState((prev) => ({
                                    ...prev,
                                    globalSettings: {
                                        ...prev.globalSettings,
                                        hideComments: {
                                            ...(prev.globalSettings
                                                .hideComments ?? {}),
                                            value,
                                        },
                                    },
                                }));
                            }}
                            handleRevert={() => {
                                setEditorState((prev) => ({
                                    ...prev,
                                    globalSettings: {
                                        ...prev.globalSettings,
                                        hideComments: {
                                            ...(prev.globalSettings
                                                .hideComments ?? {}),
                                            value: initialState.globalSettings
                                                ?.hideComments?.value,
                                        },
                                    },
                                }));
                            }}
                            canEdit={canEdit}
                        />
                        <LLMPromptToggle
                            suggestionCopyPrompt={
                                editorState.globalSettings.suggestionCopyPrompt
                            }
                            initialState={
                                initialState.globalSettings
                                    ?.suggestionCopyPrompt
                            }
                            onsuggestionCopyPromptChangeAction={(value) => {
                                setEditorState((prev) => ({
                                    ...prev,
                                    globalSettings: {
                                        ...prev.globalSettings,
                                        suggestionCopyPrompt: {
                                            ...(prev.globalSettings
                                                .suggestionCopyPrompt ?? {}),
                                            value,
                                        },
                                    },
                                }));
                            }}
                            handleRevert={() => {
                                setEditorState((prev) => ({
                                    ...prev,
                                    globalSettings: {
                                        ...prev.globalSettings,
                                        suggestionCopyPrompt: {
                                            ...(prev.globalSettings
                                                .suggestionCopyPrompt ?? {}),
                                            value: initialState.globalSettings
                                                ?.suggestionCopyPrompt?.value,
                                        },
                                    },
                                }));
                            }}
                            canEdit={canEdit}
                        />
                    </TabsContent>
                </Tabs>
            </Page.Content>
        </Page.Root>
    );
}

export default function CustomMessages() {
    return (
        <PageBoundary
            errorVariant="card"
            errorMessage="Failed to load custom messages. Please try again.">
            <CustomMessagesContent />
        </PageBoundary>
    );
}
