"use client";

import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { magicModal } from "@components/ui/magic-modal";
import { TrashIcon } from "lucide-react";

type BulkDeleteConfirmationModalProps = {
    titles: string[];
};

const VISIBLE_TITLES = 3;

// Confirmation-only: resolves `magicModal.show()` with a boolean so the
// caller (the page) owns the actual mutation.
//
// Shows the first few titles to confirm identity ("did I select the
// right rules?") without dumping path/instructions/content. The
// individual delete modal puts the rule title in red on the heading;
// the bulk equivalent is this short list — N rule titles is a
// scannable replacement for one heading.
export const BulkDeleteConfirmationModal = ({
    titles,
}: BulkDeleteConfirmationModalProps) => {
    const count = titles.length;
    const label = count === 1 ? "Delete 1 rule" : `Delete ${count} rules`;
    const visible = titles.slice(0, VISIBLE_TITLES);
    const extra = count - visible.length;

    return (
        <Dialog open onOpenChange={() => magicModal.hide(false)}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{label}?</DialogTitle>
                    <DialogDescription>
                        This can&apos;t be undone.
                    </DialogDescription>
                </DialogHeader>

                <ul className="text-text-secondary flex flex-col gap-1 text-sm">
                    {visible.map((title, idx) => (
                        <li
                            key={`${idx}-${title}`}
                            className="flex items-center gap-2">
                            <span className="bg-text-tertiary size-1.5 shrink-0 rounded-full" />
                            <span className="truncate">{title}</span>
                        </li>
                    ))}
                    {extra > 0 && (
                        <li className="text-text-tertiary pl-3.5 text-xs">
                            +{extra} more
                        </li>
                    )}
                </ul>

                <DialogFooter>
                    <Button
                        size="md"
                        variant="cancel"
                        onClick={() => magicModal.hide(false)}>
                        Cancel
                    </Button>

                    <Button
                        size="md"
                        variant="tertiary"
                        leftIcon={<TrashIcon />}
                        onClick={() => magicModal.hide(true)}>
                        {label}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
