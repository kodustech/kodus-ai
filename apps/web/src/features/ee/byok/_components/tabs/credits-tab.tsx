"use client";

import { useMemo, useState } from "react";
import { Button } from "@components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import { listKodusCreditCharges } from "@services/kodus-credits/fetch";
import type { KodusCreditCharge } from "@services/kodus-credits/types";
import { formatUsd } from "@services/usage/format";
import { useQuery } from "@tanstack/react-query";

import { CreditsWallet } from "../credits-wallet";

const INITIAL = 12;
const CAP = 200;

const formatTokens = (t: number) => {
    if (t === 0) return "0";
    if (t < 1000) return t.toString();
    if (t < 1_000_000) return `${(t / 1000).toFixed(1)}K`;
    return `${(t / 1_000_000).toFixed(1)}M`;
};

const formatWhen = (iso?: string) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
};

type RunRow = {
    key: string;
    prNumber?: number;
    startedAt: string;
    models: string[];
    tokens: number;
    cost: number;
    pending: boolean;
};

/**
 * The wallet's home. The money (balance, top-up, ledger) on top; below it the
 * per-review view — charges from the API's metering journal grouped by review
 * run, so a debit on the balance can be traced to the PR and model that
 * produced it.
 */
export const CreditsTab = () => {
    const [expanded, setExpanded] = useState(false);

    const chargesQuery = useQuery<KodusCreditCharge[]>({
        queryKey: ["kodus-credits", "charges"],
        queryFn: () => listKodusCreditCharges({ limit: 500 }),
        staleTime: 30_000,
    });

    const runs = useMemo<RunRow[]>(() => {
        const byRun = new Map<string, RunRow>();
        for (const c of chargesQuery.data ?? []) {
            const key = c.correlationId ?? c.spanId;
            const existing = byRun.get(key);
            const tokens = c.tokens.input + c.tokens.output;
            if (!existing) {
                byRun.set(key, {
                    key,
                    prNumber: c.prNumber,
                    startedAt: c.spanAt,
                    models: [c.model],
                    tokens,
                    cost: c.amountUsd,
                    pending: c.status === "pending",
                });
            } else {
                existing.tokens += tokens;
                existing.cost += c.amountUsd;
                existing.pending = existing.pending || c.status === "pending";
                if (!existing.models.includes(c.model))
                    existing.models.push(c.model);
                if (c.spanAt < existing.startedAt)
                    existing.startedAt = c.spanAt;
            }
        }
        return Array.from(byRun.values()).sort((a, b) =>
            b.startedAt.localeCompare(a.startedAt),
        );
    }, [chargesQuery.data]);

    const total = runs.reduce((s, r) => s + r.cost, 0);
    const limit = expanded ? CAP : INITIAL;
    const visible = runs.slice(0, limit);

    return (
        <div className="flex flex-col gap-4">
            <CreditsWallet />

            <Card color="lv1">
                <CardHeader>
                    <CardTitle className="text-sm">Charges by review</CardTitle>
                    <CardDescription className="text-xs">
                        {runs.length === 0
                            ? "No Kodus-routed usage metered yet."
                            : `${runs.length} run${runs.length === 1 ? "" : "s"} · ${formatUsd(total)} in the last ${chargesQuery.data?.length ?? 0} charges, newest first.`}
                    </CardDescription>
                </CardHeader>
                {runs.length > 0 && (
                    <CardContent>
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="text-text-tertiary border-card-lv3 border-b text-left">
                                    <th className="py-2 pr-4 font-medium">
                                        PR
                                    </th>
                                    <th className="py-2 pr-4 font-medium">
                                        Started
                                    </th>
                                    <th className="py-2 pr-4 font-medium">
                                        Models
                                    </th>
                                    <th className="py-2 pr-4 text-right font-medium">
                                        Tokens
                                    </th>
                                    <th className="py-2 text-right font-medium">
                                        Cost
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-card-lv3/60 divide-y">
                                {visible.map((run) => (
                                    <tr key={run.key}>
                                        <td className="text-text-primary py-2 pr-4 tabular-nums">
                                            {run.prNumber != null
                                                ? `#${run.prNumber}`
                                                : "—"}
                                        </td>
                                        <td className="text-text-secondary py-2 pr-4 whitespace-nowrap tabular-nums">
                                            {formatWhen(run.startedAt)}
                                        </td>
                                        <td className="text-text-secondary max-w-64 truncate py-2 pr-4">
                                            {run.models.join(", ")}
                                        </td>
                                        <td className="text-text-primary py-2 pr-4 text-right font-mono">
                                            {formatTokens(run.tokens)}
                                        </td>
                                        <td className="text-text-primary py-2 text-right font-mono">
                                            {formatUsd(run.cost)}
                                            {run.pending && (
                                                <span
                                                    className="text-text-tertiary ml-1"
                                                    title="Not yet debited from the balance">
                                                    ·
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {runs.length > INITIAL && (
                            <div className="mt-3 flex items-center justify-center">
                                <Button
                                    size="xs"
                                    variant="helper"
                                    onClick={() => setExpanded((e) => !e)}>
                                    {expanded
                                        ? "Show less"
                                        : `Show all (${Math.min(runs.length, CAP)})`}
                                </Button>
                            </div>
                        )}
                    </CardContent>
                )}
            </Card>
        </div>
    );
};
