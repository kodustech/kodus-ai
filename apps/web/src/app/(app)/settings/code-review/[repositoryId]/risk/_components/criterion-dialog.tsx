"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { Textarea } from "@components/ui/textarea";
import type { RiskCriterion } from "@services/risk-assessment/types";

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
        <Dialog
            open
            onOpenChange={(open) => {
                if (!open) onClose();
            }}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>
                        {criterion ? "Edit criterion" : "Add criterion"}
                    </DialogTitle>
                    <DialogDescription>
                        Add context to Kody’s risk assessment.
                    </DialogDescription>
                </DialogHeader>
                <FormControl.Root>
                    <FormControl.Label htmlFor="risk-criterion-name">
                        Name
                    </FormControl.Label>
                    <Input
                        id="risk-criterion-name"
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
                        placeholder="Permission changes can expose data across accounts. Distinguish them from equivalent refactors."
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
                    hint="Leave empty for all files."
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
                <DialogFooter>
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
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
