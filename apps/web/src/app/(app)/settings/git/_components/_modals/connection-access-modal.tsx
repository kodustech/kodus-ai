"use client";

import { useEffect, useState } from "react";
import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { magicModal } from "@components/ui/magic-modal";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import {
    useConnectionAccess,
    useSetConnectionAccess,
} from "@services/codeManagement/hooks/use-connection-access";

/** Owners choose which members read this Git connection's repositories. */
export const ConnectionAccessModal = (props: {
    teamId: string;
    connectionId: string;
    connectionLabel: string;
}) => {
    const access = useConnectionAccess(props.teamId, props.connectionId);
    const saveAccess = useSetConnectionAccess(props.teamId, props.connectionId);
    // The member's edits, over what the connection grants now.
    const [edited, setEdited] = useState<Set<string>>();
    const granted =
        edited ?? (access.data ? new Set(access.data.userIds) : undefined);
    // Saving after a failed load would revoke everyone it could not show.
    const loadFailed = access.isError;
    const members = access.data?.members ?? (loadFailed ? [] : undefined);

    useEffect(() => {
        if (loadFailed) {
            toast({
                variant: "warning",
                title: "Could not load who reads this connection",
            });
        }
    }, [loadFailed]);

    const [save, { loading }] = useAsyncAction(async () => {
        magicModal.lock();
        try {
            await saveAccess.mutateAsync([...(granted ?? [])]);
            toast({ variant: "success", title: "Access updated" });
            magicModal.hide();
        } catch {
            magicModal.unlock();
            toast({
                variant: "warning",
                title: "Could not update access",
                description: "Please try again later",
            });
        }
    });

    const toggle = (userId: string, on: boolean) =>
        setEdited((current) => {
            const next = new Set(current ?? granted ?? []);
            if (on) next.add(userId);
            else next.delete(userId);
            return next;
        });

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent className="w-md">
                <DialogHeader>
                    <DialogTitle>Who reads {props.connectionLabel}</DialogTitle>
                    <DialogDescription>
                        Members you select see this connection&apos;s
                        repositories, reviews and metrics. Owners always see
                        every connection.
                    </DialogDescription>
                </DialogHeader>

                {!members ? (
                    <div className="flex justify-center py-6">
                        <Spinner />
                    </div>
                ) : members.length === 0 ? (
                    <p className="text-text-secondary text-sm">
                        This workspace has no members besides its owners.
                    </p>
                ) : (
                    <ul className="flex max-h-80 flex-col gap-3 overflow-y-auto">
                        {members.map((member) => (
                            <li
                                key={member.userId}
                                className="flex items-center gap-3">
                                <Checkbox
                                    id={`access-${member.userId}`}
                                    checked={
                                        granted?.has(member.userId) ?? false
                                    }
                                    onCheckedChange={(checked) =>
                                        toggle(member.userId, checked === true)
                                    }
                                />
                                <label
                                    htmlFor={`access-${member.userId}`}
                                    className="flex flex-col text-sm">
                                    <span>{member.name || member.email}</span>
                                    <span className="text-text-secondary text-xs">
                                        {member.email}
                                    </span>
                                </label>
                            </li>
                        ))}
                    </ul>
                )}

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
                        disabled={!members || !granted || loadFailed}
                        onClick={save}>
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
