"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import {
    Sheet,
    SheetClose,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from "@components/ui/sheet";
import { Textarea } from "@components/ui/textarea";
import type { RiskCriterion } from "@services/risk-assessment/types";
import { X } from "lucide-react";

import { FilePatternsField } from "../../general/_components/file-patterns-field";

export function CriterionDialog({
    criterion,
    onApply,
    onClose,
}: {
    criterion?: RiskCriterion;
    onApply: (criterion: RiskCriterion) => void;
    onClose: () => void;
}) {
    const [draft, setDraft] = useState<RiskCriterion>(
        () =>
            criterion ?? {
                id: crypto.randomUUID(),
                name: "",
                enabled: true,
                instructions: "",
            },
    );
    return (
        <Sheet
            open
            onOpenChange={(open) => {
                if (!open) onClose();
            }}>
            <SheetContent
                side="right"
                className="w-full gap-0 py-0 sm:max-w-xl">
                <SheetHeader className="border-card-lv3 shrink-0 border-b py-5">
                    <div className="flex items-center justify-between gap-3">
                        <SheetTitle>
                            {criterion ? "Edit criterion" : "Add criterion"}
                        </SheetTitle>
                        <SheetClose asChild>
                            <Button
                                type="button"
                                variant="cancel"
                                size="icon-sm"
                                aria-label="Close criterion editor">
                                <X className="size-4" />
                            </Button>
                        </SheetClose>
                    </div>
                    <SheetDescription>
                        Define what counts as risk for your team.
                    </SheetDescription>
                </SheetHeader>
                <div
                    role="region"
                    aria-label="Criterion settings"
                    className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
                    <FormControl.Root>
                        <FormControl.Label htmlFor="risk-criterion-name">
                            Name
                        </FormControl.Label>
                        <Input
                            id="risk-criterion-name"
                            autoFocus
                            placeholder="e.g. Access control"
                            value={draft.name}
                            maxLength={120}
                            onChange={(event) =>
                                setDraft({ ...draft, name: event.target.value })
                            }
                        />
                    </FormControl.Root>
                    <FormControl.Root>
                        <FormControl.Label htmlFor="risk-criterion-instructions">
                            What should Kody consider?
                        </FormControl.Label>
                        <Textarea
                            id="risk-criterion-instructions"
                            value={draft.instructions}
                            maxLength={4000}
                            className="min-h-32"
                            placeholder="Flag changes that expose one account’s data to another."
                            onChange={(event) =>
                                setDraft({
                                    ...draft,
                                    instructions: event.target.value,
                                })
                            }
                        />
                    </FormControl.Root>
                    <FilePatternsField
                        label="Included files"
                        purpose="include"
                        value={draft.includedFiles ?? []}
                        hint="Limit this criterion to matching files."
                        onChange={(includedFiles) =>
                            setDraft({ ...draft, includedFiles })
                        }
                    />
                    <FilePatternsField
                        label="Excluded files"
                        purpose="exclude"
                        value={draft.excludedFiles ?? []}
                        onChange={(excludedFiles) =>
                            setDraft({ ...draft, excludedFiles })
                        }
                    />
                </div>
                <SheetFooter className="border-card-lv3 shrink-0 flex-row justify-end border-t py-4">
                    <Button
                        type="button"
                        size="md"
                        variant="cancel"
                        onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        size="md"
                        variant="primary"
                        disabled={
                            !draft.name.trim() || !draft.instructions.trim()
                        }
                        onClick={() =>
                            onApply({
                                ...draft,
                                name: draft.name.trim(),
                                instructions: draft.instructions.trim(),
                            })
                        }>
                        Apply
                    </Button>
                </SheetFooter>
            </SheetContent>
        </Sheet>
    );
}
