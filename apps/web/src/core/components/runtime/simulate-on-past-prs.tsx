"use client";

import { useId, useState } from "react";
import NextLink from "next/link";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { toast } from "@components/ui/toaster/use-toast";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import {
    MAX_SIMULATED_PULL_REQUESTS,
    parsePullRequestRefs,
} from "@services/runtime/model/pull-request-ref";
import { useSimulateRun } from "@services/runtime/queries";
import { FlaskConicalIcon } from "lucide-react";

type Result = { prNumber: number; runId?: string; error?: string };

/**
 * Simulate: Kody Runtime on past pull requests with the current setup;
 * nothing is posted on them. One field takes up to five PRs (numbers or
 * URLs of this repository); each gets its own Run and its own result.
 */
export const SimulateOnPastPrs = ({
    environmentId,
    repositoryName,
    repositories = [],
    canEdit,
}: {
    environmentId?: string;
    /** The primary repository's full name. */
    repositoryName?: string;
    /**
     * Every repository of a multi-repository environment, the primary first:
     * the PRs can be of any of them. One or none: the primary's PRs only.
     */
    repositories?: ReadonlyArray<{
        repositoryId: string;
        fullName: string;
        role: "primary" | "member";
    }>;
    canEdit: boolean;
}) => {
    const [value, setValue] = useState("");
    const [results, setResults] = useState<Result[]>([]);
    const [running, setRunning] = useState(false);
    const [repositoryId, setRepositoryId] = useState<string>();
    const simulate = useSimulateRun();
    const inputId = useId();
    const errorId = useId();
    const chosen = repositories.find((r) => r.repositoryId === repositoryId);
    // The primary's PRs go without a repository; a member's name it.
    const member = chosen?.role === "member" ? chosen : undefined;
    const name = chosen?.fullName ?? repositoryName;
    const parsed = parsePullRequestRefs(value, name);
    const showError = !!value.trim() && !parsed.ok;
    const canRun = canEdit && !!environmentId && parsed.ok && !running;

    const run = async () => {
        if (!environmentId || !parsed.ok) return;
        setRunning(true);
        const settled = await Promise.allSettled(
            parsed.prNumbers.map((prNumber) =>
                simulate.mutateAsync({
                    environmentId,
                    prNumber,
                    ...(member ? { repositoryId: member.repositoryId } : {}),
                }),
            ),
        );
        setRunning(false);
        const next: Result[] = settled.map((r, i) =>
            r.status === "fulfilled"
                ? { prNumber: parsed.prNumbers[i], runId: r.value.runId }
                : {
                      prNumber: parsed.prNumbers[i],
                      error: runtimeErrorMessage(r.reason, {
                          fallback: "Couldn't start",
                      }),
                  },
        );
        setResults(next);
        if (next.some((r) => r.error))
            toast({ variant: "warning", title: "Some runs did not start" });
    };

    return (
        <div className="flex flex-col gap-3">
            <form
                className="flex flex-wrap items-start gap-3"
                onSubmit={(e) => {
                    e.preventDefault();
                    if (canRun) run();
                }}>
                {repositories.length > 1 && (
                    <Select
                        value={repositoryId ?? repositories[0].repositoryId}
                        onValueChange={(next) => {
                            setRepositoryId(next);
                            setResults([]);
                        }}
                        disabled={!canEdit || !environmentId}>
                        <SelectTrigger
                            className="w-64"
                            aria-label="Repository of the pull requests">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {repositories.map((r) => (
                                <SelectItem
                                    key={r.repositoryId}
                                    value={r.repositoryId}>
                                    {r.fullName}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                )}
                <div className="flex min-w-64 flex-1 flex-col gap-1">
                    <label htmlFor={inputId} className="sr-only">
                        Pull requests, up to {MAX_SIMULATED_PULL_REQUESTS}
                    </label>
                    <Input
                        id={inputId}
                        value={value}
                        onChange={(e) => {
                            setValue(e.target.value);
                            setResults([]);
                        }}
                        placeholder={`482, #479 or https://github.com/${name ?? "owner/repo"}/pull/471`}
                        aria-invalid={showError}
                        aria-describedby={showError ? errorId : undefined}
                        disabled={!canEdit || !environmentId}
                    />
                    {showError && !parsed.ok && (
                        <span id={errorId} className="text-danger text-xs">
                            {parsed.error}
                        </span>
                    )}
                    {!environmentId && (
                        <span className="text-text-secondary text-xs">
                            Set up an environment first.
                        </span>
                    )}
                </div>
                <Button
                    type="submit"
                    size="md"
                    variant="secondary"
                    leftIcon={<FlaskConicalIcon />}
                    disabled={!canRun}
                    loading={running}>
                    Simulate
                </Button>
            </form>
            {results.length > 0 && (
                <ul className="flex flex-col gap-1 text-sm" aria-live="polite">
                    {results.map((r) => (
                        <li key={r.prNumber} className="flex gap-2">
                            <span className="font-mono">#{r.prNumber}</span>
                            {r.runId ? (
                                <NextLink
                                    href={`/runtime/runs/${encodeURIComponent(r.runId)}`}
                                    className="text-primary-light hover:underline">
                                    Queued · watch the run
                                </NextLink>
                            ) : (
                                <span className="text-danger">{r.error}</span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};
