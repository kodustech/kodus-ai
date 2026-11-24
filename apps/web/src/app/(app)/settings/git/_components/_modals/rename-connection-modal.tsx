"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { Input } from "@components/ui/input";
import { magicModal } from "@components/ui/magic-modal";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { updateConnection } from "@services/codeManagement/fetch";

export const RenameConnectionModal = (props: {
    teamId: string;
    connectionId: string;
    currentName?: string | null;
}) => {
    const router = useRouter();
    const [name, setName] = useState(props.currentName ?? "");

    const [save, { loading }] = useAsyncAction(async () => {
        magicModal.lock();
        try {
            await updateConnection({
                teamId: props.teamId,
                connectionId: props.connectionId,
                name: name.trim() || null,
            });
            toast({ variant: "success", title: "Connection renamed" });
            router.refresh();
            magicModal.hide();
        } catch {
            magicModal.unlock();
            toast({
                variant: "warning",
                title: "Could not rename the connection",
                description: "Please try again later",
            });
        }
    });

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent className="w-md">
                <DialogHeader>
                    <DialogTitle>Rename Git connection</DialogTitle>
                </DialogHeader>

                <Input
                    autoFocus
                    maxLength={120}
                    value={name}
                    placeholder="e.g. Client repositories"
                    onChange={(e) => setName(e.target.value)}
                />

                <DialogFooter>
                    <Button
                        size="md"
                        variant="cancel"
                        onClick={() => magicModal.hide()}>
                        Cancel
                    </Button>
                    <Button
                        size="md"
                        variant="primary"
                        loading={loading}
                        onClick={save}>
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
