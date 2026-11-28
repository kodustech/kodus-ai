"use client";

import { useState } from "react";
import NextLink from "next/link";
import { Button } from "@components/ui/button";
import { ConfirmModal } from "@components/ui/confirm-modal";
import { toast } from "@components/ui/toaster/use-toast";
import type { RuntimeCell } from "@services/runtime/contracts";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import { useRevokeRuntimeCell } from "@services/runtime/queries";

/** Registering a cell of your own: the token and the commands are in Settings → Cells (the org owner's). */
export const ConnectCell = () => (
    <p className="text-text-secondary text-sm">
        Need the machines on a host of your own?{" "}
        <NextLink
            href="/runtime/settings/cells"
            className="text-primary-light font-medium hover:underline">
            Connect a host
        </NextLink>
        .
    </p>
);

/** Revoke a customer cell: the hub drops it and refuses its certificate; its machines go with its dead-man switch. */
export const RevokeCell = ({ cell }: { cell: RuntimeCell }) => {
    const [confirming, setConfirming] = useState(false);
    const revoke = useRevokeRuntimeCell();
    if (cell.owner !== "customer" || cell.status === "revoked") return null;
    return (
        <>
            <Button
                size="sm"
                variant="cancel"
                onClick={() => setConfirming(true)}>
                Revoke
            </Button>
            <ConfirmModal
                open={confirming}
                title={`Revoke host ${cell.name ?? cell.cellId}?`}
                description="The hub drops its connection at once and refuses its certificate. Runs on it end as errored, with Run again; its machines are destroyed by the host's own dead-man switch. Connecting it again needs a new registration token."
                confirmText="Revoke"
                loading={revoke.isPending}
                onCancel={() => setConfirming(false)}
                onConfirm={() =>
                    revoke.mutate(
                        { cellId: cell.cellId },
                        {
                            onSuccess: () => {
                                setConfirming(false);
                                toast({
                                    variant: "warning",
                                    title: "Host revoked",
                                });
                            },
                            onError: (error) =>
                                toast({
                                    variant: "danger",
                                    title: "Couldn't revoke the host",
                                    description: runtimeErrorMessage(error, {
                                        fallback: "Try again in a moment.",
                                        403: "Only the owner of the organization can revoke a host.",
                                    }),
                                }),
                        },
                    )
                }
            />
        </>
    );
};
