"use client";

import { Button } from "@components/ui/button";
import { PauseIcon, PlayIcon, Trash2 } from "lucide-react";

type BulkActionToolbarProps = {
    selectedCount: number;
    eligibleCount: number;
    /** How many of the selected rules can be paused (currently ACTIVE). */
    pauseableCount: number;
    /** How many of the selected rules can be resumed (currently PAUSED). */
    resumableCount: number;
    isDeleting: boolean;
    isPausing: boolean;
    isResuming: boolean;
    onSelectAll: () => void;
    onClear: () => void;
    onDelete: () => void;
    onPause: () => void;
    onResume: () => void;
};

// Sticky toolbar that appears below the filters when at least one rule is
// selected. Lets the user expand the selection to every visible-eligible
// rule, clear it, pause/resume in bulk, or trigger a bulk delete. Pause
// and Resume hide themselves when no selected rule is in the corresponding
// state, so the toolbar doesn't offer no-op actions.
export const BulkActionToolbar = ({
    selectedCount,
    eligibleCount,
    pauseableCount,
    resumableCount,
    isDeleting,
    isPausing,
    isResuming,
    onSelectAll,
    onClear,
    onDelete,
    onPause,
    onResume,
}: BulkActionToolbarProps) => {
    if (selectedCount === 0) return null;

    const allSelected = selectedCount >= eligibleCount && eligibleCount > 0;
    const anyMutationRunning = isDeleting || isPausing || isResuming;

    return (
        <div
            className="bg-card-lv1 ring-card-lv2 sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-lg px-3 py-1.5 ring-1"
            role="toolbar"
            aria-label="Bulk actions">
            <span className="text-text-secondary text-xs tabular-nums">
                <strong className="text-text-primary">{selectedCount}</strong>{" "}
                selected
            </span>

            <div className="bg-card-lv2 h-4 w-px" aria-hidden />

            {!allSelected && (
                <Button size="xs" variant="cancel" onClick={onSelectAll}>
                    Select all visible ({eligibleCount})
                </Button>
            )}

            <Button
                size="xs"
                variant="cancel"
                onClick={onClear}
                aria-label="Clear selection">
                Clear
            </Button>

            <div className="flex-1" />

            {pauseableCount > 0 && (
                <Button
                    size="xs"
                    variant="helper"
                    loading={isPausing}
                    disabled={anyMutationRunning}
                    onClick={onPause}
                    leftIcon={<PauseIcon aria-hidden />}>
                    Pause {pauseableCount}
                </Button>
            )}

            {resumableCount > 0 && (
                <Button
                    size="xs"
                    variant="helper"
                    loading={isResuming}
                    disabled={anyMutationRunning}
                    onClick={onResume}
                    leftIcon={<PlayIcon aria-hidden />}>
                    Resume {resumableCount}
                </Button>
            )}

            <Button
                size="xs"
                variant="error"
                loading={isDeleting}
                disabled={anyMutationRunning}
                onClick={onDelete}
                leftIcon={<Trash2 aria-hidden />}>
                Delete {selectedCount}
            </Button>
        </div>
    );
};
