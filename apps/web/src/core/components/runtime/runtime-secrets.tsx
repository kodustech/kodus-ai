"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { SECRETS_SECTION_ID } from "@services/runtime/model/blockers";
import { RuntimeErrorState } from "@components/runtime/empty-state";
import { RuntimeSection } from "@components/runtime/section";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { ConfirmModal } from "@components/ui/confirm-modal";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { Input } from "@components/ui/input";
import { Label } from "@components/ui/label";
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
import { Textarea } from "@components/ui/textarea";
import { toast } from "@components/ui/toaster/use-toast";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import {
    hostsProblem,
    nameProblem,
    parseHostsInput,
    valueProblem,
} from "@services/runtime/model/secrets";
import {
    useCreateRuntimeSecret,
    useDeleteRuntimeSecret,
    useRuntimeSecrets,
    useUpdateRuntimeSecret,
    type RuntimeSecret,
} from "@services/runtime/secrets";
import { KeyRoundIcon, PlusIcon } from "lucide-react";

const when = (iso: string) => new Date(iso).toLocaleString();
const who = (a: { userId: string; email?: string }) => a.email ?? a.userId;

const errorText = (error: unknown) =>
    runtimeErrorMessage(error, {
        fallback: "Try again in a moment.",
        403: "Only the owner of the organization manages secrets.",
        503: "The secret store is unavailable; nothing was changed. Try again in a moment.",
    });

type FormMode =
    /** A new secret; name and host come prefilled from a "needs a credential" card (S-58). */
    | { kind: "create"; name?: string; host?: string }
    | { kind: "hosts"; secret: RuntimeSecret }
    | { kind: "value"; secret: RuntimeSecret };

/** One form for the three changes: a new secret, its hosts, or its value. The value field is never filled in from anywhere. */
const SecretForm = ({
    mode,
    onClose,
}: {
    mode: FormMode;
    onClose: () => void;
}) => {
    const create = useCreateRuntimeSecret();
    const update = useUpdateRuntimeSecret();
    const pending = create.isPending || update.isPending;
    const [name, setName] = useState(mode.kind === "create" ? (mode.name ?? "") : "");
    const [hostsText, setHostsText] = useState(
        mode.kind === "create" ? (mode.host ?? "") : mode.secret.hosts.join("\n"),
    );
    const [value, setValue] = useState("");
    const [submitted, setSubmitted] = useState(false);

    const asksName = mode.kind === "create";
    const asksHosts = mode.kind !== "value";
    const asksValue = mode.kind !== "hosts";
    const hosts = parseHostsInput(hostsText);
    const problems = {
        name: asksName ? nameProblem(name) : undefined,
        hosts: asksHosts ? hostsProblem(hosts) : undefined,
        value: asksValue ? valueProblem(value) : undefined,
    };
    const invalid = Object.values(problems).some(Boolean);

    const title =
        mode.kind === "create"
            ? "Add a secret"
            : mode.kind === "hosts"
              ? `Allowed hosts of ${mode.secret.name}`
              : `Replace the value of ${mode.secret.name}`;

    const done = (message: string) => {
        setValue("");
        toast({ variant: "success", title: message });
        onClose();
    };
    const failed = (message: string) => (error: unknown) =>
        toast({ variant: "danger", title: message, description: errorText(error) });

    const submit = () => {
        setSubmitted(true);
        if (invalid) return;
        if (mode.kind === "create") {
            create.mutate(
                { name, hosts, value },
                {
                    onSuccess: () => done(`${name} saved`),
                    onError: failed("Couldn't save the secret"),
                },
            );
            return;
        }
        update.mutate(
            mode.kind === "hosts"
                ? { secretId: mode.secret.secretId, hosts }
                : { secretId: mode.secret.secretId, value },
            {
                onSuccess: () =>
                    done(
                        mode.kind === "hosts"
                            ? "Allowed hosts saved"
                            : "Value replaced",
                    ),
                onError: failed("Couldn't save the change"),
            },
        );
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>
                        The value never enters Kody's machine. The machine only
                        sees a placeholder; Kodus puts the real value in the
                        request when it goes to one of the allowed hosts, and
                        nowhere else.
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        submit();
                    }}>
                    {asksName && (
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="secret-name">Name</Label>
                            <Input
                                id="secret-name"
                                placeholder="NPM_TOKEN"
                                autoComplete="off"
                                spellCheck={false}
                                value={name}
                                error={submitted && problems.name}
                                onChange={(e) =>
                                    setName(e.target.value.toUpperCase())
                                }
                            />
                            <p className="text-text-tertiary text-xs">
                                The environment variable the machine reads. It
                                holds the placeholder, not the value.
                            </p>
                            {submitted && problems.name && (
                                <p className="text-danger text-xs" role="alert">
                                    {problems.name}
                                </p>
                            )}
                        </div>
                    )}
                    {asksHosts && (
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="secret-hosts">Allowed hosts</Label>
                            <Textarea
                                id="secret-hosts"
                                rows={3}
                                placeholder={"npm.your-company.com\nghcr.io"}
                                spellCheck={false}
                                value={hostsText}
                                onChange={(e) => setHostsText(e.target.value)}
                            />
                            <p className="text-text-tertiary text-xs">
                                One per line, exact names: no wildcards, no IP
                                addresses. These hosts become reachable from the
                                machine.
                            </p>
                            {submitted && problems.hosts && (
                                <p className="text-danger text-xs" role="alert">
                                    {problems.hosts}
                                </p>
                            )}
                        </div>
                    )}
                    {asksValue && (
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="secret-value">
                                {mode.kind === "value" ? "New value" : "Value"}
                            </Label>
                            <Input
                                id="secret-value"
                                type="password"
                                autoComplete="new-password"
                                spellCheck={false}
                                value={value}
                                error={submitted && problems.value}
                                onChange={(e) => setValue(e.target.value)}
                            />
                            <p className="text-text-tertiary text-xs">
                                Stored in the secret store. Nobody can read it
                                back, here or anywhere in Kodus; to change it,
                                replace it.
                            </p>
                            {submitted && problems.value && (
                                <p className="text-danger text-xs" role="alert">
                                    {problems.value}
                                </p>
                            )}
                        </div>
                    )}
                    <DialogFooter>
                        <Button
                            type="button"
                            size="md"
                            variant="cancel"
                            onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            size="md"
                            variant="primary"
                            loading={pending}>
                            Save
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};

const SecretRow = ({
    secret,
    onEdit,
    onDelete,
}: {
    secret: RuntimeSecret;
    onEdit: (mode: FormMode) => void;
    onDelete: (secret: RuntimeSecret) => void;
}) => (
    <TableRow>
        <TableCell className="font-mono text-sm">{secret.name}</TableCell>
        <TableCell>
            <div className="flex flex-wrap gap-1">
                {secret.hosts.map((h) => (
                    <Badge key={h} variant="helper">
                        {h}
                    </Badge>
                ))}
            </div>
        </TableCell>
        <TableCell className="text-text-secondary text-sm">
            {when(secret.valueSetAt)}
        </TableCell>
        <TableCell className="text-text-secondary text-sm">
            {who(secret.updatedBy)}, {when(secret.updatedAt)}
        </TableCell>
        <TableCell>
            <div className="flex justify-end gap-2">
                <Button
                    size="sm"
                    variant="helper"
                    onClick={() => onEdit({ kind: "hosts", secret })}>
                    Hosts
                </Button>
                <Button
                    size="sm"
                    variant="helper"
                    onClick={() => onEdit({ kind: "value", secret })}>
                    Replace value
                </Button>
                <Button
                    size="sm"
                    variant="error"
                    onClick={() => onDelete(secret)}>
                    Delete
                </Button>
            </div>
        </TableCell>
    </TableRow>
);

/**
 * The organization's Runtime secrets: credentials Kody's machines use outward
 * (a private registry, a test API key), each bound to the hosts it may go to.
 * The owner of the organization sees and changes them; nobody sees a value.
 */
export const RuntimeSecretsSection = () => {
    const secrets = useRuntimeSecrets();
    const remove = useDeleteRuntimeSecret();
    // A "needs a credential" card links here with the name and host to prefill (S-58).
    const params = useSearchParams();
    const asked = params?.get("secretName") ?? undefined;
    const askedHost = params?.get("secretHost") ?? undefined;
    const [form, setForm] = useState<FormMode | undefined>(
        asked || askedHost ? { kind: "create", ...(asked ? { name: asked } : {}), ...(askedHost ? { host: askedHost } : {}) } : undefined,
    );
    const [deleting, setDeleting] = useState<RuntimeSecret>();

    const configured = secrets.data?.configured;
    return (
        <RuntimeSection
            id={SECRETS_SECTION_ID}
            title="Secrets"
            description="Credentials Kody's machines use on your behalf, such as a private package registry or a test API key. The value never enters the machine: it holds a placeholder, and Kodus swaps in the value only on requests to the hosts you allow."
            aside={
                configured && (
                    <Button
                        size="md"
                        variant="primary"
                        leftIcon={<PlusIcon />}
                        onClick={() => setForm({ kind: "create" })}>
                        Add secret
                    </Button>
                )
            }>
            {secrets.isLoading ? (
                <Skeleton className="h-24 w-full" />
            ) : secrets.isError ? (
                <RuntimeErrorState
                    what="the secrets"
                    error={secrets.error}
                    onRetry={() => secrets.refetch()}
                />
            ) : !configured ? (
                <p className="text-text-secondary text-sm">
                    This Kodus has no secret store yet. Whoever runs your Kodus
                    installation sets one up (OpenBao); until then, machines get
                    no secrets.
                </p>
            ) : secrets.data!.secrets.length === 0 ? (
                <div className="text-text-secondary flex items-center gap-2 text-sm">
                    <KeyRoundIcon className="size-4" />
                    No secrets yet. Add one when a setup or a Run needs to reach
                    a private host.
                </div>
            ) : (
                <TableContainer>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Name</TableHead>
                                <TableHead>Allowed hosts</TableHead>
                                <TableHead>Value set</TableHead>
                                <TableHead>Last change</TableHead>
                                <TableHead className="sr-only">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {secrets.data!.secrets.map((s) => (
                                <SecretRow
                                    key={s.secretId}
                                    secret={s}
                                    onEdit={setForm}
                                    onDelete={setDeleting}
                                />
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}
            {form && configured && (
                <SecretForm mode={form} onClose={() => setForm(undefined)} />
            )}
            <ConfirmModal
                open={!!deleting}
                title={`Delete ${deleting?.name ?? "the secret"}?`}
                description="Machines stop receiving it on their next request, including Runs in progress. This cannot be undone; to use it again, add it again with its value."
                confirmText="Delete"
                loading={remove.isPending}
                onCancel={() => setDeleting(undefined)}
                onConfirm={() =>
                    deleting &&
                    remove.mutate(deleting.secretId, {
                        onSuccess: () => {
                            toast({
                                variant: "success",
                                title: `${deleting.name} deleted`,
                            });
                            setDeleting(undefined);
                        },
                        onError: (error) =>
                            toast({
                                variant: "danger",
                                title: "Couldn't delete the secret",
                                description: errorText(error),
                            }),
                    })
                }
            />
        </RuntimeSection>
    );
};
