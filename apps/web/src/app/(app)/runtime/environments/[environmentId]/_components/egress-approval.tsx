"use client";

import { useId, useState } from "react";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import { toast } from "@components/ui/toaster/use-toast";
import { checkEgressHost } from "@services/runtime/model/egress-host";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import { useApproveEgressHost } from "@services/runtime/queries";
import { CheckIcon } from "lucide-react";

// A host outside the default allowlist, approved for this environment only
// (docs §7, org owner). The API refuses denied hosts; the toast says why.

const useApprove = (environmentId: string) => {
    const approve = useApproveEgressHost();
    const run = (host: string, onDone?: () => void) =>
        approve.mutate(
            { environmentId, host },
            {
                onSuccess: () => {
                    toast({
                        variant: "success",
                        title: `${host} approved for this environment`,
                        description: "The app's machines may only download from it (GET and HEAD). Full access is the blocker card's second step.",
                    });
                    onDone?.();
                },
                onError: (error) =>
                    toast({
                        variant: "danger",
                        title: `Couldn't approve ${host}`,
                        description: runtimeErrorMessage(error, {
                            fallback: "Try again in a moment.",
                            403: "Only the owner, or a repo admin when the org allows it, can approve hosts.",
                        }),
                    }),
            },
        );
    return { run, isPending: approve.isPending };
};

export const ApproveHostButton = ({
    environmentId,
    host,
}: {
    environmentId: string;
    host: string;
}) => {
    const { run, isPending } = useApprove(environmentId);
    // One per row of the blocked list: a check icon with the host in its name, not a labelled button down the column.
    return (
        <Button
            size="icon-xs"
            variant="helper"
            loading={isPending}
            aria-label={`Approve ${host}`}
            title={`Approve ${host} for this environment`}
            onClick={() => run(host)}>
            <CheckIcon />
        </Button>
    );
};

export const ApproveHostForm = ({
    environmentId,
}: {
    environmentId: string;
}) => {
    const [host, setHost] = useState("");
    const { run, isPending } = useApprove(environmentId);
    const checked = checkEgressHost(host);
    const showError = !!host.trim() && !checked.ok;
    const inputId = useId();
    const errorId = useId();
    return (
        <form
            className="flex flex-wrap items-start gap-3"
            onSubmit={(event) => {
                event.preventDefault();
                if (checked.ok) run(checked.host, () => setHost(""));
            }}>
            <div className="flex flex-col gap-1">
                <label htmlFor={inputId} className="sr-only">
                    Host to approve
                </label>
                <Input
                    id={inputId}
                    placeholder="api.example.com"
                    value={host}
                    aria-invalid={showError}
                    aria-describedby={showError ? errorId : undefined}
                    onChange={(event) => setHost(event.target.value)}
                    className="w-72"
                />
                {showError && !checked.ok && (
                    <span id={errorId} className="text-danger text-xs">
                        {checked.error}
                    </span>
                )}
            </div>
            <Button
                type="submit"
                size="md"
                variant="helper"
                disabled={!checked.ok}
                loading={isPending}>
                Approve host
            </Button>
        </form>
    );
};
