"use client";

import { Page } from "@components/ui/page";
import { PageBoundary } from "src/core/components/page-boundary";
import { useUnsavedChangesGuard } from "src/core/hooks/use-unsaved-changes-guard";

import { CentralizedConfigReadOnlyAlert } from "../../_components/centralized-config-readonly-alert";
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
            <Page.Header sticky>
                <Page.Title>Custom Messages</Page.Title>

                <Page.SaveActions
                    isDirty={editor.hasPendingChanges}
                    isSaving={editor.isSaving}
                    canSave={editor.canEdit}
                    onReset={editor.handleReset}
                    onSave={() => editor.save()}
                />
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
