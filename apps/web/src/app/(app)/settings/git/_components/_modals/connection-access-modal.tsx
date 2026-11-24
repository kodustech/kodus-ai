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
import { UserRole } from "@enums";
import { useAsyncAction } from "@hooks/use-async-action";
import {
    getConnectionAccess,
    setConnectionAccess,
} from "@services/codeManagement/fetch";
import { SETUP_PATHS } from "@services/setup";
import type { MembersSetup, TeamMembersResponse } from "@services/setup/types";
import { axiosAuthorized } from "src/core/utils/axios";

type Member = { userId: string; name: string; email: string };

/** Owners choose which members read this Git connection's repositories. */
export const ConnectionAccessModal = (props: {
    teamId: string;
    connectionId: string;
    connectionLabel: string;
}) => {
    const [members, setMembers] = useState<Member[]>();
    const [granted, setGranted] = useState<Set<string>>(new Set());

    useEffect(() => {
        let alive = true;
        Promise.all([
            axiosAuthorized.fetcher<{ data: TeamMembersResponse }>(
                SETUP_PATHS.TEAM_MEMBERS,
                { params: { teamId: props.teamId } },
            ),
            getConnectionAccess(props.teamId, props.connectionId),
        ])
            .then(([membersResponse, userIds]) => {
                if (!alive) return;
                const list = (
                    (membersResponse?.data?.members ?? []) as MembersSetup[]
                )
                    .filter(
                        (member: MembersSetup) =>
                            member.userId && member.role !== UserRole.OWNER,
                    )
                    .map((member: MembersSetup) => ({
                        userId: member.userId!,
                        name: member.name,
                        email: member.email,
                    }));
                setMembers(list);
                setGranted(new Set(userIds));
            })
            .catch(() => {
                if (!alive) return;
                setMembers([]);
                toast({
                    variant: "warning",
                    title: "Could not load who reads this connection",
                });
            });
        return () => {
            alive = false;
        };
    }, [props.teamId, props.connectionId]);

    const [save, { loading }] = useAsyncAction(async () => {
        magicModal.lock();
        try {
            await setConnectionAccess(props.teamId, props.connectionId, [
                ...granted,
            ]);
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
        setGranted((current) => {
            const next = new Set(current);
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
                        Members you select see this connection&apos;s repositories,
                        reviews and metrics. Owners always see every connection.
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
                                    checked={granted.has(member.userId)}
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
                        disabled={!members}
                        onClick={save}>
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
