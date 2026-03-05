"use client";

import { useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import { ConfirmModal } from "@components/ui/confirm-modal";
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
import { Page } from "@components/ui/page";
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
import {
    createCLIKey,
    listCLIKeys,
    revokeCLIKey,
} from "@services/cliKeys/fetch";
import type { CLIKey } from "@services/cliKeys/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { format, formatDistanceToNow } from "date-fns";
import {
    CopyIcon,
    KeyRoundIcon,
    RefreshCcwIcon,
    TerminalIcon,
    Trash2Icon,
} from "lucide-react";
import { useAllTeams } from "src/core/providers/all-teams-context";
import { ClipboardHelpers } from "src/core/utils/clipboard";

export const CliKeysPage = ({
    teamId,
    initialKeys,
}: {
    teamId: string;
    initialKeys: CLIKey[];
}) => {
    const { teams } = useAllTeams();
    const canManage = usePermission(
        Action.Update,
        ResourceType.OrganizationSettings,
    );

    const [keys, setKeys] = useState<CLIKey[]>(initialKeys);
    const [newKeyName, setNewKeyName] = useState("");
    const [isCreating, setIsCreating] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [revokingKeyId, setRevokingKeyId] = useState<string | null>(null);
    const [keyToRevoke, setKeyToRevoke] = useState<CLIKey | null>(null);
    const [createdKey, setCreatedKey] = useState<string | null>(null);
    const [createdMessage, setCreatedMessage] = useState<string | undefined>();
    const [showKeyModal, setShowKeyModal] = useState(false);

    const teamName = teams.find((team) => team.uuid === teamId)?.name;

    const handleRefresh = async () => {
        setIsRefreshing(true);
        try {
            const latestKeys = await listCLIKeys(teamId);
            setKeys(latestKeys ?? []);
        } catch (error) {
            toast({
                variant: "danger",
                title: "Failed to refresh keys",
            });
            console.error(error);
        } finally {
            setIsRefreshing(false);
        }
    };

    const handleCreate = async () => {
        const trimmedName = newKeyName.trim();
        if (!trimmedName) {
            toast({
                variant: "danger",
                title: "Name is required",
                description: "Add a descriptive name before generating a key.",
            });
            return;
        }

        setIsCreating(true);
        try {
            const response = await createCLIKey({
                teamId,
                name: trimmedName,
            });

            if (!response?.key) {
                throw new Error("Missing key from response");
            }

            setCreatedKey(response.key);
            setCreatedMessage(
                response.message ??
                    "Save this key securely. It will not be shown again.",
            );
            setShowKeyModal(true);
            setNewKeyName("");
            await handleRefresh();
        } catch (error: any) {
            toast({
                variant: "danger",
                title: "Failed to create CLI key",
                description: error?.message ?? "Try again in a moment.",
            });
            console.error(error);
        } finally {
            setIsCreating(false);
        }
    };

    const handleConfirmRevoke = async () => {
        if (!keyToRevoke) return;

        setRevokingKeyId(keyToRevoke.uuid);
        try {
            const response = await revokeCLIKey({
                teamId,
                keyId: keyToRevoke.uuid,
            });

            if (!response) {
                throw new Error("The key could not be revoked");
            }

            toast({
                variant: "success",
                title: "CLI key revoked",
            });

            await handleRefresh();
        } catch (error: any) {
            toast({
                variant: "danger",
                title: "Failed to revoke CLI key",
                description: error?.message ?? "Try again in a moment.",
            });
            console.error(error);
        } finally {
            setRevokingKeyId(null);
            setKeyToRevoke(null);
        }
    };

    const handleCopyKey = async () => {
        if (!createdKey) return;

        try {
            await ClipboardHelpers.copyTextToClipboard(createdKey);
            toast({ variant: "success", title: "CLI key copied" });
        } catch (error) {
            toast({
                variant: "danger",
                title: "Failed to copy key",
            });
            console.error(error);
        }
    };

    const getInstallCommand = (key: string) =>
        `curl -fsSL https://review-skill.com/install | bash -s -- --team-key ${key}`;

    const handleCopyInstallCommand = async () => {
        if (!createdKey) return;

        try {
            await ClipboardHelpers.copyTextToClipboard(
                getInstallCommand(createdKey),
            );
            toast({ variant: "success", title: "Install command copied" });
        } catch (error) {
            toast({
                variant: "danger",
                title: "Failed to copy command",
            });
            console.error(error);
        }
    };

    const formatLastUsed = (value?: string | null) => {
        if (!value) return "Never used";
        return formatDistanceToNow(new Date(value), { addSuffix: true });
    };

    return (
        <Page.Root>
            <Page.Header>
                <Page.TitleContainer>
                    <Page.Title className="text-balance">CLI keys</Page.Title>
                    <Page.Description className="text-pretty">
                        Manage CLI access tokens for the selected workspace
                        {teamName ? ` (${teamName})` : ""}. Keys are shown only
                        once on creation.
                    </Page.Description>
                </Page.TitleContainer>
                <Page.HeaderActions>
                    <Button
                        size="md"
                        variant="helper"
                        leftIcon={<RefreshCcwIcon />}
                        onClick={handleRefresh}
                        loading={isRefreshing}>
                        Refresh
                    </Button>
                </Page.HeaderActions>
            </Page.Header>

            <Page.Content className="flex flex-col gap-6">
                <Card color="lv1" className="max-w-3xl">
                    <CardHeader>
                        <CardTitle className="text-balance">
                            Generate a new CLI key
                        </CardTitle>
                        <CardDescription className="text-pretty">
                            Only organization owners can generate CLI keys.
                            Store the key value securely after creation.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                        <FormControl.Root className="max-w-xl">
                            <FormControl.Label htmlFor="cli-key-name">
                                Key name
                            </FormControl.Label>
                            <FormControl.Input>
                                <Input
                                    id="cli-key-name"
                                    placeholder="e.g., CI pipeline deploy key"
                                    value={newKeyName}
                                    onChange={(event) =>
                                        setNewKeyName(event.target.value)
                                    }
                                    disabled={!canManage}
                                />
                            </FormControl.Input>
                            <FormControl.Helper>
                                Use a descriptive name to identify where this
                                key will be used.
                            </FormControl.Helper>
                        </FormControl.Root>

                        <div className="flex flex-wrap items-center gap-3">
                            <Button
                                size="md"
                                variant="primary"
                                leftIcon={<KeyRoundIcon />}
                                onClick={handleCreate}
                                disabled={
                                    !canManage ||
                                    !newKeyName.trim() ||
                                    isCreating
                                }
                                loading={isCreating}>
                                Generate key
                            </Button>

                            {!canManage && (
                                <span className="text-text-secondary text-sm">
                                    You need owner permissions to manage CLI
                                    keys.
                                </span>
                            )}
                        </div>
                    </CardContent>
                </Card>

                <Card color="lv1">
                    <CardHeader className="flex flex-col gap-1">
                        <CardTitle className="text-balance">
                            Existing CLI keys
                        </CardTitle>
                        <CardDescription className="text-pretty">
                            Keys stay active until revoked. Only metadata is
                            shown here—the key value is never displayed again.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        {keys.length === 0 ? (
                            <div className="text-text-secondary text-sm text-pretty">
                                No CLI keys yet. Generate a key to start using
                                the CLI.
                            </div>
                        ) : (
                            <TableContainer>
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Name</TableHead>
                                            <TableHead>Status</TableHead>
                                            <TableHead>Last used</TableHead>
                                            <TableHead>Created at</TableHead>
                                            <TableHead>Created by</TableHead>
                                            <TableHead align="right">
                                                Actions
                                            </TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {keys.map((cliKey) => (
                                            <TableRow key={cliKey.uuid}>
                                                <TableCell className="font-semibold">
                                                    {cliKey.name}
                                                </TableCell>
                                                <TableCell>
                                                    <Badge
                                                        variant={
                                                            cliKey.active
                                                                ? "success"
                                                                : "error"
                                                        }>
                                                        {cliKey.active
                                                            ? "Active"
                                                            : "Revoked"}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell className="tabular-nums">
                                                    {formatLastUsed(
                                                        cliKey.lastUsedAt,
                                                    )}
                                                </TableCell>
                                                <TableCell className="tabular-nums">
                                                    {format(
                                                        new Date(
                                                            cliKey.createdAt,
                                                        ),
                                                        "PPpp",
                                                    )}
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex flex-col">
                                                        <span className="font-medium">
                                                            {cliKey.createdBy
                                                                ?.name || "—"}
                                                        </span>
                                                        <span className="text-text-secondary text-xs">
                                                            {cliKey.createdBy
                                                                ?.email || "—"}
                                                        </span>
                                                    </div>
                                                </TableCell>
                                                <TableCell align="right">
                                                    <div className="flex items-center justify-end gap-2">
                                                        <Button
                                                            size="sm"
                                                            variant="error"
                                                            leftIcon={
                                                                <Trash2Icon />
                                                            }
                                                            onClick={() =>
                                                                setKeyToRevoke(
                                                                    cliKey,
                                                                )
                                                            }
                                                            disabled={
                                                                !canManage ||
                                                                !cliKey.active ||
                                                                revokingKeyId ===
                                                                    cliKey.uuid
                                                            }
                                                            loading={
                                                                revokingKeyId ===
                                                                cliKey.uuid
                                                            }>
                                                            Revoke
                                                        </Button>
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </TableContainer>
                        )}
                    </CardContent>
                </Card>
            </Page.Content>

            <Dialog
                open={showKeyModal}
                onOpenChange={(open) => {
                    setShowKeyModal(open);
                    if (!open) {
                        setCreatedKey(null);
                        setCreatedMessage(undefined);
                    }
                }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="text-balance">
                            CLI key created
                        </DialogTitle>
                        <DialogDescription className="text-pretty">
                            {createdMessage ||
                                "Save this key securely. It will not be shown again."}
                        </DialogDescription>
                    </DialogHeader>

                    {createdKey && (
                        <div className="flex flex-col gap-4">
                            <div className="bg-card-lv2 border-card-lv1 flex items-center gap-3 rounded-xl border p-4">
                                <span className="font-mono text-sm break-all">
                                    {createdKey}
                                </span>
                                <Button
                                    size="icon-sm"
                                    variant="helper"
                                    aria-label="Copy CLI key"
                                    onClick={handleCopyKey}>
                                    <CopyIcon />
                                </Button>
                            </div>

                            <div className="flex flex-col gap-2">
                                <span className="text-text-secondary text-sm font-medium">
                                    Share with your team
                                </span>
                                <div className="bg-card-lv2 border-card-lv1 flex items-center gap-3 rounded-xl border p-4">
                                    <TerminalIcon className="text-text-secondary size-4 shrink-0" />
                                    <code className="text-sm break-all">
                                        {getInstallCommand(createdKey)}
                                    </code>
                                    <Button
                                        size="icon-sm"
                                        variant="helper"
                                        aria-label="Copy install command"
                                        className="shrink-0"
                                        onClick={handleCopyInstallCommand}>
                                        <CopyIcon />
                                    </Button>
                                </div>
                            </div>
                        </div>
                    )}

                    <DialogFooter>
                        <Button
                            size="md"
                            variant="primary-dark"
                            onClick={() => setShowKeyModal(false)}>
                            Close
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <ConfirmModal
                open={!!keyToRevoke}
                title="Revoke CLI key"
                description="Revoking immediately disables this CLI key. This action cannot be undone."
                confirmText="Revoke key"
                variant="primary-dark"
                loading={!!revokingKeyId}
                onConfirm={handleConfirmRevoke}
                onCancel={() => setKeyToRevoke(null)}
            />
        </Page.Root>
    );
};
