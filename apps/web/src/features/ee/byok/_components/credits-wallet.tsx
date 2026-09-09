"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@components/ui/sheet";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { listKodusCreditCharges } from "@services/kodus-credits/fetch";
import type { KodusCreditCharge } from "@services/kodus-credits/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { formatUsd } from "@services/usage/format";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CoinsIcon, ReceiptTextIcon, SparklesIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import {
    createCreditCheckoutAction,
    listCreditLedgerAction,
} from "src/features/ee/subscription/_actions/credits";
import type { CreditLedgerEntry } from "src/features/ee/subscription/_services/billing/types";

import {
    KODUS_CREDITS_PATH,
    useKodusCreditBalance,
} from "../_hooks/use-kodus-credit-balance";

const usd = (n: number | undefined | null, digits = 2) =>
    `$${(n ?? 0).toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    })}`;

const formatWhen = (iso?: string) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
};

const formatTokens = (t: number) => {
    if (t === 0) return "0";
    if (t < 1000) return t.toString();
    if (t < 1_000_000) return `${(t / 1000).toFixed(1)}K`;
    return `${(t / 1_000_000).toFixed(1)}M`;
};

const ENTRY_LABEL: Record<CreditLedgerEntry["type"], string> = {
    purchase: "Top-up",
    debit: "Usage",
    adjustment: "Adjustment",
    refund: "Refund",
};

const describeEntry = (entry: CreditLedgerEntry): string => {
    const meta = (entry.metadata ?? {}) as Record<string, unknown>;
    if (entry.type === "debit") {
        const model = typeof meta.model === "string" ? meta.model : undefined;
        const pr =
            typeof meta.prNumber === "number"
                ? `PR #${meta.prNumber}`
                : undefined;
        return [model, pr].filter(Boolean).join(" · ") || "Model usage";
    }
    if (entry.type === "purchase") {
        const charge =
            typeof meta.chargeUsd === "number"
                ? ` (paid ${usd(meta.chargeUsd)})`
                : "";
        return `Credit pack${charge}`;
    }
    return ENTRY_LABEL[entry.type];
};

/**
 * The wallet, inside the Kodus provider card: one strip with the balance on
 * the left and the ways to add money on the right. The balance is an
 * attribute of this provider — it pays for nothing else — so it lives on the
 * card, not on a tab of its own. Stripe sends the user back to this card.
 * History (money ledger + charges by review) opens in a drawer.
 */
export const CreditsWalletStrip = () => {
    const { teamId } = useSelectedTeamId();
    const router = useRouter();
    const searchParams = useSearchParams();
    const queryClient = useQueryClient();
    const credits = useKodusCreditBalance();
    const canEdit = usePermission(Action.Update, ResourceType.Billing);
    const [customAmount, setCustomAmount] = useState("");
    const [ledgerOpen, setLedgerOpen] = useState(false);

    // Back from Stripe: the webhook lands a moment after the redirect, so
    // refetch once and tell the user what happened.
    const creditsParam = searchParams.get("credits");
    useEffect(() => {
        if (!creditsParam) return;
        if (creditsParam === "success") {
            toast({
                variant: "success",
                title: "Payment received",
                description:
                    "Your credits will show up here within a few seconds.",
            });
            const t = setTimeout(() => {
                void queryClient.invalidateQueries({
                    queryKey: ["kodus-credits"],
                });
                router.refresh();
            }, 3000);
            router.replace(KODUS_CREDITS_PATH);
            return () => clearTimeout(t);
        }
        if (creditsParam === "cancel") {
            router.replace(KODUS_CREDITS_PATH);
        }
    }, [creditsParam, queryClient, router]);

    const [topUp, { loading: checkingOut }] = useAsyncAction(
        async (creditUsd: number) => {
            const { url } = await createCreditCheckoutAction({
                teamId,
                creditUsd,
            });
            window.location.href = url;
        },
    );

    const balanceUsd = credits.balanceUsd ?? 0;
    const { packsUsd: packs, markupPct: markup } = credits;
    const min = credits.minPurchaseUsd;
    const max = credits.maxPurchaseUsd;
    const custom = Number(customAmount);
    const customValid =
        customAmount.trim() !== "" &&
        Number.isFinite(custom) &&
        custom >= min &&
        custom <= max;

    return (
        <div
            id="kodus-credits"
            data-testid="kodus-credits-wallet"
            className="bg-card-lv2/60 mb-3 flex flex-col gap-3 rounded-lg px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-text-secondary flex items-center gap-2 text-xs">
                        <CoinsIcon size={13} />
                        Kodus credits
                        {credits.exhausted ? (
                            <Badge variant="error" size="xs">
                                Used up
                            </Badge>
                        ) : credits.low ? (
                            <Badge variant="helper" size="xs">
                                Running low
                            </Badge>
                        ) : null}
                    </span>
                    <span
                        className="text-text-primary text-2xl font-semibold tabular-nums"
                        data-testid="kodus-credits-balance">
                        {credits.loading ? "…" : usd(balanceUsd)}
                    </span>
                    <span className="text-text-tertiary max-w-md text-xs text-pretty">
                        Pays for the models below, per token at the
                        provider&apos;s list price. A {markup}% platform fee is
                        added when you top up.
                    </span>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-2">
                    <div className="flex flex-wrap justify-end gap-2">
                        {packs.map((pack) => (
                            <Button
                                key={pack}
                                size="md"
                                variant={
                                    pack === packs[1] ? "primary" : "helper"
                                }
                                disabled={!canEdit || checkingOut}
                                loading={checkingOut}
                                onClick={() => topUp(pack)}>
                                +{usd(pack, 0)}
                            </Button>
                        ))}
                    </div>
                    <div className="flex items-center gap-2">
                        <Input
                            size="md"
                            className="w-40"
                            inputMode="decimal"
                            placeholder={`Custom (${usd(min, 0)}–${usd(max, 0)})`}
                            value={customAmount}
                            onChange={(e) => setCustomAmount(e.target.value)}
                        />
                        <Button
                            size="md"
                            variant="helper"
                            disabled={!canEdit || checkingOut || !customValid}
                            onClick={() =>
                                topUp(Math.round(custom * 100) / 100)
                            }>
                            Top up
                        </Button>
                        <Button
                            size="md"
                            variant="cancel"
                            leftIcon={<ReceiptTextIcon />}
                            onClick={() => setLedgerOpen(true)}>
                            History
                        </Button>
                    </div>
                    {customValid && (
                        <span className="text-text-tertiary text-xs tabular-nums">
                            You&apos;ll pay {usd(custom * (1 + markup / 100))}
                        </span>
                    )}
                </div>
            </div>

            {credits.exhausted && (
                <div className="bg-danger/10 text-text-primary flex items-start gap-2 rounded-md px-3 py-2 text-xs">
                    <SparklesIcon size={14} className="mt-0.5 shrink-0" />
                    <span>
                        Reviews on the models below are paused until you top up.
                        Your own provider keys keep working.
                    </span>
                </div>
            )}

            <CreditsLedgerDrawer
                open={ledgerOpen}
                onOpenChange={setLedgerOpen}
            />
        </div>
    );
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

const INITIAL_RUNS = 12;
const RUN_CAP = 200;

/**
 * History drawer: the money ledger (top-ups, debits, adjustments) and the
 * per-review charges from the API's metering journal grouped by review run,
 * so a debit can be traced to the PR and model that produced it.
 */
export const CreditsLedgerDrawer = ({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) => {
    const { teamId } = useSelectedTeamId();
    const credits = useKodusCreditBalance();
    const [expanded, setExpanded] = useState(false);

    const ledgerQuery = useQuery<CreditLedgerEntry[]>({
        queryKey: ["kodus-credits", "ledger", teamId],
        queryFn: () => listCreditLedgerAction({ teamId, limit: 25 }),
        enabled: open && !!teamId,
        staleTime: 30_000,
    });
    const chargesQuery = useQuery<KodusCreditCharge[]>({
        queryKey: ["kodus-credits", "charges"],
        queryFn: () => listKodusCreditCharges({ limit: 500 }),
        enabled: open,
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
    const visibleRuns = runs.slice(0, expanded ? RUN_CAP : INITIAL_RUNS);
    const ledger = ledgerQuery.data ?? [];

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent
                side="right"
                className="bg-card-lv1 flex w-full max-w-2xl flex-col gap-0 p-0">
                <SheetHeader className="border-card-lv3 flex flex-col gap-1 border-b px-6 py-4">
                    <SheetTitle className="text-text-primary flex items-center gap-2 text-base">
                        <CoinsIcon size={16} />
                        Kodus credits · history
                    </SheetTitle>
                    <SheetDescription className="text-text-secondary text-xs">
                        Balance{" "}
                        <span className="text-text-primary font-medium tabular-nums">
                            {typeof credits.balanceUsd === "number"
                                ? formatUsd(credits.balanceUsd)
                                : "—"}
                        </span>
                        . Debits are per token at the provider&apos;s list
                        price; top-ups include the {credits.markupPct}% platform
                        fee.
                    </SheetDescription>
                </SheetHeader>

                <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-5">
                    <section className="flex flex-col gap-2">
                        <h3 className="text-text-primary text-sm font-semibold">
                            Money movements
                        </h3>
                        {ledgerQuery.isLoading ? (
                            <p className="text-text-tertiary text-xs">
                                Loading…
                            </p>
                        ) : ledger.length === 0 ? (
                            <p className="text-text-tertiary text-xs">
                                No top-ups or debits yet.
                            </p>
                        ) : (
                            <table className="w-full text-xs">
                                <thead>
                                    <tr className="text-text-tertiary border-card-lv3 border-b text-left">
                                        <th className="py-2 pr-4 font-medium">
                                            When
                                        </th>
                                        <th className="py-2 pr-4 font-medium">
                                            Type
                                        </th>
                                        <th className="py-2 pr-4 font-medium">
                                            Detail
                                        </th>
                                        <th className="py-2 pr-4 text-right font-medium">
                                            Amount
                                        </th>
                                        <th className="py-2 text-right font-medium">
                                            Balance
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="divide-card-lv3/60 divide-y">
                                    {ledger.map((entry) => (
                                        <tr key={entry.id}>
                                            <td className="text-text-secondary py-2 pr-4 whitespace-nowrap tabular-nums">
                                                {formatWhen(entry.createdAt)}
                                            </td>
                                            <td className="text-text-primary py-2 pr-4">
                                                {ENTRY_LABEL[entry.type] ??
                                                    entry.type}
                                            </td>
                                            <td className="text-text-secondary max-w-56 truncate py-2 pr-4">
                                                {describeEntry(entry)}
                                            </td>
                                            <td
                                                className={`py-2 pr-4 text-right font-mono ${entry.amountUsd < 0 ? "text-text-primary" : "text-success"}`}>
                                                {entry.amountUsd < 0
                                                    ? "−"
                                                    : "+"}
                                                {usd(
                                                    Math.abs(entry.amountUsd),
                                                    entry.type === "debit"
                                                        ? 4
                                                        : 2,
                                                )}
                                            </td>
                                            <td className="text-text-secondary py-2 text-right font-mono">
                                                {usd(entry.balanceAfterUsd)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </section>

                    <section className="flex flex-col gap-2">
                        <h3 className="text-text-primary text-sm font-semibold">
                            Charges by review
                        </h3>
                        <p className="text-text-tertiary text-xs">
                            {chargesQuery.isLoading
                                ? "Loading…"
                                : runs.length === 0
                                  ? "No Kodus-routed usage metered yet."
                                  : `${runs.length} run${runs.length === 1 ? "" : "s"} · ${formatUsd(total)} in the last ${chargesQuery.data?.length ?? 0} charges, newest first.`}
                        </p>
                        {runs.length > 0 && (
                            <>
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
                                        {visibleRuns.map((run) => (
                                            <tr key={run.key}>
                                                <td className="text-text-primary py-2 pr-4 tabular-nums">
                                                    {run.prNumber != null
                                                        ? `#${run.prNumber}`
                                                        : "—"}
                                                </td>
                                                <td className="text-text-secondary py-2 pr-4 whitespace-nowrap tabular-nums">
                                                    {formatWhen(run.startedAt)}
                                                </td>
                                                <td className="text-text-secondary max-w-48 truncate py-2 pr-4">
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
                                {runs.length > INITIAL_RUNS && (
                                    <div className="flex items-center justify-center">
                                        <Button
                                            size="xs"
                                            variant="helper"
                                            onClick={() =>
                                                setExpanded((e) => !e)
                                            }>
                                            {expanded
                                                ? "Show less"
                                                : `Show all (${Math.min(runs.length, RUN_CAP)})`}
                                        </Button>
                                    </div>
                                )}
                            </>
                        )}
                    </section>
                </div>
            </SheetContent>
        </Sheet>
    );
};
