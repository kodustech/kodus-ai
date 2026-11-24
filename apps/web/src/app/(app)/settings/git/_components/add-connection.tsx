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
                        reviewed with this workspace's settings, and it is
                        billed separately from the workspace's other
                        connections.
                    </DialogDescription>
                </DialogHeader>

                <Input
                    maxLength={120}
                    value={name}
                    placeholder="Name this connection (optional), e.g. Client repositories"
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
