"use client";

import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import { RotateCcwIcon, SaveIcon } from "lucide-react";
import { PageBoundary } from "src/core/components/page-boundary";
import { useUnsavedChangesGuard } from "src/core/hooks/use-unsaved-changes-guard";

import { CodeReviewPagesBreadcrumb } from "../../_components/breadcrumb";
import { CentralizedConfigReadOnlyAlert } from "../../_components/centralized-config-readonly-alert";
import { CodeReviewSaveButton } from "../../_components/save-button";
import {
    CustomMessagesEditorTabs,
    useCustomMessagesEditor,
} from "./_components/custom-messages-editor";

function CustomMessagesContent() {
    const editor = useCustomMessagesEditor();

    useUnsavedChangesGuard({
        id: "custom-messages",
        isDirty: editor.hasPendingChanges || editor.isSaving,
        onBlock: editor.scrollToDirtyField,
    });

    return (
        <Page.Root>
            <Page.Header>
                <CodeReviewPagesBreadcrumb pageName="Custom messages" />
            </Page.Header>

            <Page.Header>
                <Page.Title>Custom Messages</Page.Title>

                <Page.HeaderActions>
                    {editor.hasPendingChanges && (
                        <Button
                            size="md"
                            variant="cancel"
                            leftIcon={<RotateCcwIcon />}
                            onClick={editor.handleReset}
                            disabled={editor.isSaving}>
                            Reset
                        </Button>
                    )}

                    <CodeReviewSaveButton
                        size="md"
                        variant="primary"
                        loading={editor.isSaving}
                        leftIcon={<SaveIcon />}
                        onClick={() => editor.save()}
                        disabled={!editor.canEdit || !editor.hasPendingChanges}>
                        Save changes
                    </CodeReviewSaveButton>
                </Page.HeaderActions>
            </Page.Header>

            <Page.Content>
                <CentralizedConfigReadOnlyAlert />
                <CustomMessagesEditorTabs editor={editor} />
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
