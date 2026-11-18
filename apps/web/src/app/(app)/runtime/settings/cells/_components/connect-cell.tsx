"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { toast } from "@components/ui/toaster/use-toast";
import type {
    CellRegistrationToken,
    CellTopology,
} from "@services/runtime/contracts";
import {
    CELL_TOPOLOGIES,
    cellRegisterSteps,
} from "@services/runtime/model/cell-registration";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import { useCreateCellRegistrationToken } from "@services/runtime/queries";
import { CopyIcon, KeyRoundIcon } from "lucide-react";

const expiresAtLabel = (iso: string) =>
    new Date(iso).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
    });

const copy = async (text: string, what: string) => {
    try {
        await navigator.clipboard.writeText(text);
        toast({ variant: "success", title: `${what} copied` });
    } catch {
        toast({
            variant: "danger",
            title: `Couldn't copy the ${what.toLowerCase()}`,
        });
    }
};

/**
 * Makes a registration token and shows it once, with the commands to run on
 * the cell host. The commands never contain the token (it is pasted into a
 * hidden prompt), so they are safe to copy into a runbook.
 */
export const ConnectCell = ({
    defaultTopology,
}: {
    defaultTopology: CellTopology;
}) => {
    const [topology, setTopology] = useState<CellTopology>(defaultTopology);
    const [issued, setIssued] = useState<CellRegistrationToken>();
    const create = useCreateCellRegistrationToken();
    const chosen = CELL_TOPOLOGIES.find((t) => t.value === topology)!;

    const issue = () =>
        create.mutate(topology, {
            onSuccess: setIssued,
            onError: (error) =>
                toast({
                    variant: "danger",
                    title: "Couldn't create the registration token",
                    description: runtimeErrorMessage(error, {
                        fallback: "Try again in a moment.",
                        403: "Only the owner of the organization can connect a host.",
                    }),
                }),
        });

    if (issued) {
        const steps = cellRegisterSteps(issued.topology);
        return (
            <div className="border-card-lv3 flex flex-col gap-3 rounded-lg border p-4">
                <p className="text-sm">
                    The token works once and expires at{" "}
                    <strong>{expiresAtLabel(issued.expiresAt)}</strong>. It is
                    not shown again: copy it now.
                </p>
                <div className="flex flex-wrap items-center gap-3">
                    <code
                        aria-label="Registration token"
                        className="bg-card-lv2 max-w-full overflow-x-auto rounded-md px-3 py-2 font-mono text-xs">
                        {issued.token}
                    </code>
                    <Button
                        size="sm"
                        variant="primary"
                        leftIcon={<CopyIcon />}
                        onClick={() => copy(issued.token, "Token")}>
                        Copy token
                    </Button>
                </div>
                <p className="text-text-secondary text-sm">{steps.before}</p>
                <pre
                    aria-label="Registration commands"
                    className="bg-card-lv2 overflow-x-auto rounded-md p-3 font-mono text-xs">
                    {steps.commands.join("\n")}
                </pre>
                <p className="text-text-tertiary text-sm">
                    {steps.after} The host makes its own key, gets a 24-hour
                    certificate it renews by itself, and connects out to the
                    hub: nothing is opened to it. It shows up in the hosts of
                    the Environments page once connected.
                </p>
                <div className="flex flex-wrap gap-3">
                    <Button
                        size="md"
                        variant="secondary"
                        leftIcon={<CopyIcon />}
                        onClick={() =>
                            copy(steps.commands.join("\n"), "Commands")
                        }>
                        Copy commands
                    </Button>
                    <Button
                        size="md"
                        variant="cancel"
                        onClick={() => setIssued(undefined)}>
                        Done
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
                <div className="w-72">
                    <Select
                        value={topology}
                        onValueChange={(v) => setTopology(v as CellTopology)}>
                        <SelectTrigger aria-label="Where the host runs">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {CELL_TOPOLOGIES.map((t) => (
                                <SelectItem key={t.value} value={t.value}>
                                    {t.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <Button
                    size="md"
                    variant="primary"
                    leftIcon={<KeyRoundIcon />}
                    loading={create.isPending}
                    onClick={issue}>
                    Create registration token
                </Button>
            </div>
            <p className="text-text-tertiary text-sm">
                {chosen.hint} Single use, valid for 15 minutes.
            </p>
        </div>
    );
};
