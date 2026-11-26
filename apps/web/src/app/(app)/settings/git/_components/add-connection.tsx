"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { Input } from "@components/ui/input";
import { magicModal } from "@components/ui/magic-modal";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { PlusIcon } from "lucide-react";
import { isSelfHosted } from "src/core/utils/self-hosted";

import { GitProviders } from "./_providers";

const AddConnectionModal = () => {
    const [name, setName] = useState("");

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Add a Git connection</DialogTitle>
                    <DialogDescription>
                        Connect another organization, group or account, on the
                        same provider or a different one. Its repositories are
                        reviewed with this workspace&apos;s settings.{" "}
                        {isSelfHosted
                            ? "Its seats count toward the instance license."
                            : "It is billed separately: it starts on the free plan with its own seats, and you subscribe to it from Subscription. The trial and prepaid credits stay shared by the workspace."}
                    </DialogDescription>
                </DialogHeader>

                <label
                    htmlFor="new-connection-name"
                    className="text-sm font-medium">
                    Name (optional)
                </label>
                <Input
                    id="new-connection-name"
                    maxLength={120}
                    value={name}
                    placeholder="e.g. Client repositories"
                    onChange={(e) => setName(e.target.value)}
                />

                <GitProviders newConnection={{ name }} />
            </DialogContent>
        </Dialog>
    );
};

export const AddConnectionButton = () => {
    const canCreate = usePermission(Action.Create, ResourceType.GitSettings);

    if (!canCreate) return null;

    return (
        <Button
            size="sm"
            variant="helper"
            leftIcon={<PlusIcon />}
            onClick={() => magicModal.show(() => <AddConnectionModal />)}>
            Add connection
        </Button>
    );
};
