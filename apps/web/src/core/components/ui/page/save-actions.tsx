"use client";

import { RotateCcwIcon, SaveIcon } from "lucide-react";

import { Button } from "../button";
import { PageHeaderActions } from "./components";

/**
 * The action cluster of every settings page that saves a form: an "Unsaved
 * changes" marker, the page's own extra actions, Reset and Save. Pair it with
 * `<Page.Header sticky>` so the only way to keep a change stays in reach on a
 * long page.
 *
 * Reset and Save are always mounted and only toggle `disabled`: mounting Reset
 * on the first edit made the whole bar jump sideways at the exact moment the
 * reader touched a control. Both are `type="button"` so a page that wraps its
 * header in a <form> doesn't get Reset submitting it; Save goes through
 * `onSave` there too.
 */
export const PageSaveActions = ({
    isDirty,
    isSaving,
    canSave = true,
    onReset,
    onSave,
    saveLabel = "Save settings",
    children,
}: React.PropsWithChildren<{
    isDirty: boolean;
    isSaving: boolean;
    /** False blocks saving on top of a clean form: no permission, invalid form. */
    canSave?: boolean;
    /** Omit when the page has no way to discard its pending changes. */
    onReset?: () => void;
    onSave: () => void;
    saveLabel?: string;
}>) => (
    <PageHeaderActions>
        {isDirty && (
            <span className="text-warning flex items-center gap-1.5 text-xs font-medium whitespace-nowrap">
                <span className="bg-warning size-1.5 rounded-full" />
                Unsaved changes
            </span>
        )}

        {children}

        {onReset && (
            <Button
                type="button"
                size="md"
                variant="cancel"
                leftIcon={<RotateCcwIcon />}
                onClick={onReset}
                disabled={!isDirty || isSaving}>
                Reset
            </Button>
        )}

        <Button
            type="button"
            size="md"
            variant="primary"
            leftIcon={<SaveIcon />}
            onClick={onSave}
            disabled={!isDirty || !canSave}
            loading={isSaving}>
            {saveLabel}
        </Button>
    </PageHeaderActions>
);
