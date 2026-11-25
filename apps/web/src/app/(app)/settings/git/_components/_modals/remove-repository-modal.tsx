"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { magicModal } from "@components/ui/magic-modal";
import { useAsyncAction } from "@hooks/use-async-action";
import { useTimeout } from "@hooks/use-timeout";
import type { Repository } from "@services/codeManagement/types";
import { repositoryFullName } from "src/core/utils/repository-name";

type DeleteMemberModalProps = {
    repository: Repository;
    saveFn: () => void | Promise<void>;
};

export const DeleteModal = ({ repository, saveFn }: DeleteMemberModalProps) => {
    const [enabled, setEnabled] = useState(false);

    useTimeout(() => {
        setEnabled(true);
    }, 3000);

    const [handleDelete, { loading }] = useAsyncAction(async () => {
        magicModal.lock();

        try {
            await saveFn();
        } finally {
            magicModal.hide();
        }
    });

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent className="w-md">
                <DialogHeader>
                    <DialogTitle>
                        Remove integration with this repository?
                    </DialogTitle>
                </DialogHeader>

                <p className="text-sm">
                    Are you sure you want to remove integration with{" "}
                    <strong className="text-danger">
                        {repositoryFullName(repository)}
                    </strong>
                    ?
                </p>

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
                        loading={!enabled || loading}
                        onClick={handleDelete}>
                        Remove integration
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
