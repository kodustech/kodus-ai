"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { magicModal } from "@components/ui/magic-modal";
import { Markdown } from "@components/ui/markdown";
import { Separator } from "@components/ui/separator";
import { toast } from "@components/ui/toaster/use-toast";
import { useTimeout } from "@hooks/use-timeout";
import { deleteKodyRule } from "@services/kodyRules/fetch";
import type { KodyRule } from "@services/kodyRules/types";
import { isCentralizedPrResponse } from "@services/parameters/types";
import { TrashIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { getCentralizedPrToastPayload } from "../_utils/centralized-pr-feedback";

type DeleteKodyRuleModalProps = {
    rule: KodyRule;
    onSuccess?: () => void;
};

export const DeleteKodyRuleConfirmationModal = ({
    rule,
    onSuccess,
}: DeleteKodyRuleModalProps) => {
    const { teamId } = useSelectedTeamId();
    const [enabled, setEnabled] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);

    useTimeout(() => {
        setEnabled(true);
    }, 3000);

    const handleDelete = async () => {
        if (!rule.uuid) return;

        setIsDeleting(true);
        magicModal.lock();

        try {
            const mutationResult = await deleteKodyRule(rule.uuid, teamId);

            magicModal.hide(true);
            onSuccess?.();

            if (isCentralizedPrResponse(mutationResult)) {
                toast(
                    getCentralizedPrToastPayload(
                        mutationResult,
                        "Kody Rule removal proposed through centralized pull request.",
                    ),
                );
            } else {
                toast({
                    description: "Kody Rule successfully removed.",
                    variant: "success",
                });
            }
        } catch (error) {
            console.error("Error removing Kody Rule:", error);

            toast({
                title: "Error",
                description:
                    "An error occurred while removing the Kody Rule. Please try again.",
                variant: "danger",
            });

            magicModal.hide();
        } finally {
            setIsDeleting(false);
        }
    };

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Remove this Kody Rule?</DialogTitle>
                    <DialogDescription>
                        This action cannot be undone!
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                    <p className="text-sm">
                        Are you sure you want to remove{" "}
                        <strong className="text-danger">{rule.title}</strong>?
                    </p>

                    <Separator />

                    {rule.path && (
                        <p className="text-text-secondary text-sm">
                            <strong>Path:</strong> {rule.path}
                        </p>
                    )}

                    <div className="flex flex-col gap-1">
                        <strong className="text-text-primary text-sm">
                            Instructions:
                        </strong>

                        <Card className="max-h-75 overflow-y-scroll">
                            <CardHeader className="py-4">
                                <Markdown>{rule.rule}</Markdown>
                            </CardHeader>
                        </Card>
                    </div>
                </div>

                <DialogFooter>
                    <Button
                        size="md"
                        variant="cancel"
                        onClick={() => magicModal.hide()}>
                        Cancel
                    </Button>

                    <Button
                        size="md"
                        variant="tertiary"
                        loading={!enabled || isDeleting}
                        leftIcon={<TrashIcon />}
                        onClick={handleDelete}>
                        Remove
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
