"use client";

import { useState } from "react";
import { RuntimeErrorState } from "@components/runtime/empty-state";
import { RelativeTime } from "@components/runtime/relative-time";
import { StatusChip } from "@components/runtime/status-chip";
import { Button } from "@components/ui/button";
import { ConfirmModal } from "@components/ui/confirm-modal";
import { Skeleton } from "@components/ui/skeleton";
import {
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableHeader,
    TableRow,
} from "@components/ui/table";
import { toast } from "@components/ui/toaster/use-toast";
import type { CellRegistrationTokenView } from "@services/runtime/contracts";
import {
    canRevokeCellToken,
    cellTokenStateLabel,
    cellTokenStateTone,
    cellTopologyLabel,
} from "@services/runtime/model/cell-registration";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import {
    useCellRegistrationTokens,
    useRevokeCellRegistrationToken,
} from "@services/runtime/queries";

const RevokeToken = ({ token }: { token: CellRegistrationTokenView }) => {
    const [confirming, setConfirming] = useState(false);
    const revoke = useRevokeCellRegistrationToken();
    if (!canRevokeCellToken(token.state)) return null;
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
                title="Revoke this registration token?"
                description="No host can register with it from now on. A host that already registered with it is not touched: revoke that host on the Environments page."
                confirmText="Revoke"
                loading={revoke.isPending}
                onCancel={() => setConfirming(false)}
                onConfirm={() =>
                    revoke.mutate(token.id, {
                        onSuccess: () => {
                            setConfirming(false);
                            toast({
                                variant: "warning",
                                title: "Registration token revoked",
                            });
                        },
                        onError: (error) =>
                            toast({
                                variant: "danger",
                                title: "Couldn't revoke the token",
                                description: runtimeErrorMessage(error, {
                                    fallback: "Try again in a moment.",
                                    409: "The token was used or expired meanwhile; a host it registered is revoked on the Environments page.",
                                    404: "The token is no longer listed.",
                                }),
                            }),
                    })
                }
            />
        </>
    );
};

/** The org's tokens of the last 24 hours: never the token itself, which is not stored. */
export const RegistrationTokens = ({
    currentUserId,
}: {
    currentUserId?: string;
}) => {
    const tokens = useCellRegistrationTokens();
    if (tokens.isLoading) return <Skeleton className="h-20 w-full" />;
    if (tokens.isError)
        return (
            <RuntimeErrorState
                what="registration tokens"
                error={tokens.error}
                onRetry={() => tokens.refetch()}
            />
        );
    if (!tokens.data?.length)
        return (
            <p className="text-text-secondary text-sm">
                No registration token in the last 24 hours.
            </p>
        );
    return (
        <TableContainer>
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Created</TableHead>
                        <TableHead>Where</TableHead>
                        <TableHead>By</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>Expires</TableHead>
                        <TableHead>
                            <span className="sr-only">Actions</span>
                        </TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {tokens.data.map((t) => (
                        <TableRow key={t.id}>
                            <TableCell>
                                <RelativeTime at={t.issuedAt} />
                            </TableCell>
                            <TableCell>
                                {cellTopologyLabel(t.topology)}
                            </TableCell>
                            <TableCell className="text-sm">
                                {t.issuedBy === currentUserId ? (
                                    "You"
                                ) : (
                                    <span className="font-mono text-xs">
                                        {t.issuedBy}
                                    </span>
                                )}
                            </TableCell>
                            <TableCell>
                                <StatusChip tone={cellTokenStateTone(t.state)}>
                                    {cellTokenStateLabel(t.state)}
                                </StatusChip>
                            </TableCell>
                            <TableCell>
                                {t.state === "pending" ? (
                                    <RelativeTime at={t.expiresAt} />
                                ) : (
                                    "—"
                                )}
                            </TableCell>
                            <TableCell className="text-right">
                                <RevokeToken token={t} />
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </TableContainer>
    );
};
