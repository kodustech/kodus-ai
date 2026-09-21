"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import { toast } from "@components/ui/toaster/use-toast";
import { KodyLearningStatus } from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useFormContext, useFormState, useWatch } from "react-hook-form";
import { PageBoundary } from "src/core/components/page-boundary";
import { useUnsavedChangesGuard } from "src/core/hooks/use-unsaved-changes-guard";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { cn } from "src/core/utils/components";
import { unformatConfig } from "src/core/utils/helpers";

import { CentralizedConfigReadOnlyAlert } from "../../_components/centralized-config-readonly-alert";
import GeneratingConfig from "../../_components/generating-config";
import { useCodeReviewSettingsMutation } from "../../_hooks/use-code-review-settings-mutation";
import { type CodeReviewFormType } from "../../_types";
import { getCentralizedPrToastPayload } from "../../_utils/centralized-pr-feedback";
import {
    useDefaultCodeReviewConfig,
    usePlatformConfig,
} from "../../../_components/context";
import { useCodeReviewRouteParams } from "../../../_hooks";
import {
    bindGlobalSettings,
    CustomMessagesEditorTabs,
    useCustomMessagesEditor,
    type CustomMessageType,
} from "../custom-messages/_components/custom-messages-editor";
import { HiddenComments } from "../custom-messages/_components/hidden-comments";
import { LLMPromptToggle } from "../custom-messages/_components/llm-prompt";
import { PromptEditorField } from "../custom-prompts/_components/prompt-editor-field";
import {
    getPromptFieldText,
    getValueAtPath,
    parsePromptFieldValue,
} from "../custom-prompts/_utils/custom-prompts-state";
import { PrSummaryFields } from "../pr-summary/_components/pr-summary-fields";
import { PrSummaryPreviewButton } from "../pr-summary/_components/pr-summary-fields-compact";
import { PrPreview } from "./_components/pr-preview";

const VOICE_FIELD = "v2PromptOverrides.generation.main.value";

// The preview column is a personal reading preference, kept per browser.
const PREVIEW_STORAGE_KEY = "kodus:output:preview";
const readStoredPreview = (): boolean | null => {
    try {
        const raw = window.localStorage.getItem(PREVIEW_STORAGE_KEY);
        return raw === "open" ? true : raw === "closed" ? false : null;
    } catch {
        return null;
    }
};
const storePreview = (open: boolean) => {
    try {
        window.localStorage.setItem(
            PREVIEW_STORAGE_KEY,
            open ? "open" : "closed",
        );
    } catch {
        // Private mode / blocked storage — the choice just won't persist.
    }
};

// Tab value → the message it edits, so the PR preview can follow along.
const MESSAGE_FOR_TAB: Record<string, CustomMessageType | null> = {
    "start-review-message": "startReviewMessage",
    "end-review-message": "endReviewMessage",
    "error-review-message": "errorReviewMessage",
    "global-settings": null,
};

const SectionHeading = ({
    title,
    description,
    action,
}: {
    title: string;
    description: string;
    /** The section's own action, next to the title it acts on. */
    action?: ReactNode;
}) => (
    <div className="flex items-end justify-between gap-6">
        <div className="flex flex-col gap-1">
            <h2 className="text-text-primary text-base font-semibold">
                {title}
            </h2>
            <p className="text-text-secondary text-sm">{description}</p>
        </div>
        {action && <div className="shrink-0">{action}</div>}
    </div>
);

/**
 * Everything Kody writes on a pull request, on one screen and all visible:
 * the voice of its suggestions, the PR summary, and the status comments.
 * Two stores sit behind it (the code-review config form and the
 * custom-messages record), so Save writes whichever of the two changed.
 */
function OutputContent() {
    const platformConfig = usePlatformConfig();
    const form = useFormContext<CodeReviewFormType>();
    const { teamId } = useSelectedTeamId();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const defaults = useDefaultCodeReviewConfig()?.v2PromptOverrides;
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );
    const { saveSettings } = useCodeReviewSettingsMutation({
        teamId,
        repositoryId,
        directoryId,
        form,
    });
    const messages = useCustomMessagesEditor();
    const [messageTab, setMessageTab] = useState("start-review-message");
    const globalSettings = bindGlobalSettings(messages);

    // Open by default; the stored choice is restored after mount so the
    // server and first client render agree.
    const [previewOpen, setPreviewOpen] = useState(true);
    useEffect(() => {
        const stored = readStoredPreview();
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (stored !== null) setPreviewOpen(stored);
    }, []);
    const togglePreview = () => {
        setPreviewOpen((open) => {
            storePreview(!open);
            return !open;
        });
    };

    // What the preview needs from the summary settings.
    const summaryOn = useWatch({
        control: form.control,
        name: "summary.generatePRSummary.value",
    });
    const existingBehaviour = useWatch({
        control: form.control,
        name: "summary.behaviourForExistingDescription.value",
    });
    const newCommitsBehaviour = useWatch({
        control: form.control,
        name: "summary.behaviourForNewCommits.value",
    });

    const {
        dirtyFields,
        defaultValues: formDefaultValues,
        isValid: formIsValid,
        isSubmitting: formIsSubmitting,
    } = useFormState({ control: form.control });

    // The prompt editor writes its default into the form on mount, so the
    // voice field is compared as text; the summary fields can trust
    // react-hook-form's dirty tracking.
    const voiceValue = useWatch({
        control: form.control,
        name: VOICE_FIELD as never,
    });
    const voiceDirty = useMemo(() => {
        const current = getPromptFieldText(parsePromptFieldValue(voiceValue));
        const saved = getPromptFieldText(
            parsePromptFieldValue(
                getValueAtPath(formDefaultValues ?? {}, VOICE_FIELD),
            ),
        );
        return current !== saved;
    }, [voiceValue, formDefaultValues]);
    const summaryDirty = Boolean(dirtyFields?.summary);
    const formPartDirty = voiceDirty || summaryDirty;
    const isDirty = formPartDirty || messages.hasPendingChanges;
    const isSaving = formIsSubmitting || messages.isSaving;

    const submitForm = form.handleSubmit(async (formData) => {
        const saveResult = await saveSettings(formData, {
            prepare: (data) => {
                const { language: _language, ...config } = data;
                const unformatted = unformatConfig(config);
                return {
                    savedFormData: data,
                    codeReviewConfig: unformatted,
                };
            },
        });

        if (saveResult.centralizedPr) {
            toast(
                getCentralizedPrToastPayload(
                    saveResult.centralizedPr,
                    "Change proposed through centralized pull request.",
                ),
            );
            return;
        }
        toast({ description: "Settings saved", variant: "success" });
    });

    const saveAll = async () => {
        try {
            if (formPartDirty) await submitForm();
            if (messages.hasPendingChanges) await messages.save();
        } catch (error) {
            console.error("Error saving settings:", error);
            toast({
                title: "Error",
                description:
                    "An error occurred while saving the settings. Please try again.",
                variant: "danger",
            });
        }
    };

    const resetAll = () => {
        form.reset();
        messages.handleReset();
    };

    useUnsavedChangesGuard({
        id: "output",
        isDirty: isDirty || isSaving,
        onBlock: messages.scrollToDirtyField,
    });

    if (
        platformConfig.kodyLearningStatus ===
        KodyLearningStatus.GENERATING_CONFIG
    ) {
        return <GeneratingConfig />;
    }

    return (
        <Page.Root>
            <Page.Header sticky>
                <Page.TitleContainer>
                    <Page.Title>What Kody writes</Page.Title>
                    <Page.Description>
                        How Kody sounds, the summary it writes on each pull
                        request, and the comments it posts while reviewing.
                    </Page.Description>
                </Page.TitleContainer>

                <Page.SaveActions
                    isDirty={isDirty}
                    isSaving={isSaving}
                    canSave={canEdit && formIsValid}
                    onReset={resetAll}
                    onSave={saveAll}>
                    <Button
                        size="sm"
                        variant="helper"
                        aria-pressed={previewOpen}
                        leftIcon={previewOpen ? <EyeOffIcon /> : <EyeIcon />}
                        onClick={togglePreview}>
                        {previewOpen ? "Hide preview" : "Show preview"}
                    </Button>
                </Page.SaveActions>
            </Page.Header>

            <Page.Content className="gap-6">
                <CentralizedConfigReadOnlyAlert />

                <div
                    className={cn(
                        "grid gap-8 xl:items-start",
                        previewOpen && "xl:grid-cols-[minmax(0,1fr)_25rem]",
                    )}>
                    <div className="flex min-w-0 flex-col gap-10">
                        <section className="flex flex-col gap-4">
                            <SectionHeading
                                title="Kody's personality"
                                description="How Kody sounds in every suggestion: tone, length, what it always includes. Applies on top of each category's instructions."
                            />
                            <div
                                className="border-card-lv3/60 bg-card-lv1 rounded-xl border p-5"
                                data-field-name="v2PromptOverrides.generation">
                                <PromptEditorField
                                    name={VOICE_FIELD as never}
                                    fieldName="v2PromptOverrides.generation.main"
                                    label="Personality instructions"
                                    helperText="Kody's default is shown. Edit it to customise, clear it to go back (max 2000)."
                                    placeholder="Describe how Kody should phrase suggestions…"
                                    defaultValue={
                                        defaults?.generation?.main ?? ""
                                    }
                                    canEdit={canEdit}
                                    groups={[]}
                                    formatInsertByType={{}}
                                />
                            </div>
                        </section>

                        <section className="flex flex-col gap-4">
                            <SectionHeading
                                title="PR summary"
                                description="A description Kody writes for the pull request."
                                action={<PrSummaryPreviewButton />}
                            />
                            <PrSummaryFields
                                compact
                                showPreviewButton={false}
                            />
                        </section>

                        <section className="flex flex-col gap-4">
                            <SectionHeading
                                title="Comments during the review"
                                description="What Kody posts when a review starts, ends or fails."
                            />
                            <CustomMessagesEditorTabs
                                editor={messages}
                                hidePreview
                                hideGlobalSettings
                                value={messageTab}
                                onValueChange={setMessageTab}
                            />
                        </section>

                        <section
                            className="flex flex-col gap-4"
                            data-field-name="globalSettings">
                            <SectionHeading
                                title="Comment visibility"
                                description="How Kody's comments show up on the pull request."
                            />
                            <div className="flex flex-col gap-3">
                                <HiddenComments
                                    {...globalSettings.hiddenComments}
                                />
                                <LLMPromptToggle
                                    {...globalSettings.llmPrompt}
                                />
                            </div>
                        </section>
                    </div>

                    {previewOpen && (
                        <aside className="min-w-0 xl:sticky xl:top-2">
                            <PrPreview
                                onHide={togglePreview}
                                summaryOn={Boolean(summaryOn)}
                                existingBehaviour={existingBehaviour}
                                newCommitsBehaviour={newCommitsBehaviour}
                                messages={messages.editorState.messages}
                                activeMessage={
                                    MESSAGE_FOR_TAB[messageTab] ?? null
                                }
                                hideComments={Boolean(
                                    messages.editorState.globalSettings
                                        .hideComments?.value,
                                )}
                                copyPrompt={Boolean(
                                    messages.editorState.globalSettings
                                        .suggestionCopyPrompt?.value,
                                )}
                            />
                        </aside>
                    )}
                </div>
            </Page.Content>
        </Page.Root>
    );
}

export default function Output() {
    return (
        <PageBoundary
            errorVariant="card"
            errorMessage="Failed to load these settings. Please try again.">
            <OutputContent />
        </PageBoundary>
    );
}
