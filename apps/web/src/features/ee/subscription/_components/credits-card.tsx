"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import { Input } from "@components/ui/input";
import { Link } from "@components/ui/link";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CoinsIcon, SparklesIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import {
    createCreditCheckoutAction,
    getCreditBalanceAction,
    listCreditLedgerAction,
} from "../_actions/credits";
import { useKodusCredits } from "../_hooks/use-kodus-credits";
import type {
    CreditBalance,
    CreditLedgerEntry,
} from "../_services/billing/types";

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
 * Prepaid credits for "Kodus as the provider": balance, top-up, and the
 * ledger. Money comes from the billing service through server actions (the
 * org id is session-derived server-side). Renders nothing for an org that
 * neither routes through Kodus nor ever bought credits, so the plan card
 * stays clean for everyone else.
 */
export const CreditsCard = () => {
    const { teamId } = useSelectedTeamId();
    const router = useRouter();
    const searchParams = useSearchParams();
    const queryClient = useQueryClient();
    const credits = useKodusCredits();
    const canEdit = usePermission(Action.Update, ResourceType.Billing);
    const [customAmount, setCustomAmount] = useState("");

    const balanceQuery = useQuery<CreditBalance | null>({
        queryKey: ["kodus-credits", "balance", teamId],
        queryFn: () => getCreditBalanceAction({ teamId }),
        enabled: !!teamId,
        staleTime: 30_000,
    });
    const ledgerQuery = useQuery<CreditLedgerEntry[]>({
        queryKey: ["kodus-credits", "ledger", teamId],
        queryFn: () => listCreditLedgerAction({ teamId, limit: 15 }),
        enabled: !!teamId,
        staleTime: 30_000,
    });

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
            router.replace("/settings/subscription");
            return () => clearTimeout(t);
        }
        if (creditsParam === "cancel") {
            router.replace("/settings/subscription");
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

    const balance = balanceQuery.data;
    const relevant =
        credits.usesKodusProvider ||
        (balance &&
            (balance.lifetimePurchasedUsd > 0 || balance.balanceUsd !== 0));
    if (!relevant) return null;

    const balanceUsd = balance?.balanceUsd ?? credits.balanceUsd ?? 0;
    const low =
        balance !== undefined &&
        balance !== null &&
        balanceUsd > 0 &&
        balanceUsd <= balance.lowThresholdUsd;
    const exhausted = balanceUsd <= 0;
    const packs = balance?.packsUsd ?? [20, 50, 100, 500];
    const markup = balance?.markupPct ?? 7;
    const min = balance?.minPurchaseUsd ?? 10;
    const max = balance?.maxPurchaseUsd ?? 5000;
    const custom = Number(customAmount);
    const customValid =
        customAmount.trim() !== "" &&
        Number.isFinite(custom) &&
        custom >= min &&
        custom <= max;

    return (
        <Card className="w-full">
            <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                    <CardDescription className="flex items-center gap-2 text-sm">
                        <CoinsIcon size={14} />
                        Kodus credits
                        {exhausted ? (
                            <Badge variant="error" size="xs">
                                Used up
                            </Badge>
                        ) : low ? (
                            <Badge variant="helper" size="xs">
                                Running low
                            </Badge>
                        ) : null}
                    </CardDescription>
                    <CardTitle className="text-3xl tabular-nums">
                        {balanceQuery.isLoading && balance === undefined
                            ? "…"
                            : usd(balanceUsd)}
                    </CardTitle>
                    <p className="text-text-secondary text-sm text-pretty">
                        Prepaid balance for models routed by Kodus. Usage is
                        debited at the provider&apos;s list price; you pay a{" "}
                        {markup}% platform fee when you top up.
                        {credits.usesKodusProvider ? null : (
                            <>
                                {" "}
                                <Link href="/byok" className="font-medium">
                                    Pick a Kodus model
                                </Link>{" "}
                                to use it.
                            </>
                        )}
                    </p>
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
                            className="w-32"
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
                    </div>
                    {customValid && (
                        <span className="text-text-tertiary text-xs tabular-nums">
                            You&apos;ll pay {usd(custom * (1 + markup / 100))}
                        </span>
                    )}
                </div>
            </CardHeader>

            {exhausted && credits.usesKodusProvider && (
                <CardContent className="pt-0">
                    <div className="bg-danger/10 text-text-primary flex items-start gap-2 rounded-md px-3 py-2 text-sm">
                        <SparklesIcon size={16} className="mt-0.5 shrink-0" />
                        <span>
                            Reviews on Kodus-routed models are paused until you
                            top up. Your own provider keys keep working.
                        </span>
                    </div>
                </CardContent>
            )}

            {(ledgerQuery.data?.length ?? 0) > 0 && (
                <CardContent className="pt-0">
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="text-text-tertiary border-card-lv3 border-b text-left">
                                <th className="py-2 pr-4 font-medium">When</th>
                                <th className="py-2 pr-4 font-medium">Type</th>
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
                            {ledgerQuery.data!.map((entry) => (
                                <tr key={entry.id}>
                                    <td className="text-text-secondary py-2 pr-4 whitespace-nowrap tabular-nums">
                                        {formatWhen(entry.createdAt)}
                                    </td>
                                    <td className="text-text-primary py-2 pr-4">
                                        {ENTRY_LABEL[entry.type] ?? entry.type}
                                    </td>
                                    <td className="text-text-secondary max-w-72 truncate py-2 pr-4">
                                        {describeEntry(entry)}
                                    </td>
                                    <td
                                        className={`py-2 pr-4 text-right font-mono ${entry.amountUsd < 0 ? "text-text-primary" : "text-success"}`}>
                                        {entry.amountUsd < 0 ? "−" : "+"}
                                        {usd(
                                            Math.abs(entry.amountUsd),
                                            entry.type === "debit" ? 4 : 2,
                                        )}
                                    </td>
                                    <td className="text-text-secondary py-2 text-right font-mono">
                                        {usd(entry.balanceAfterUsd)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p className="text-text-tertiary mt-2 text-xs">
                        Latest {ledgerQuery.data!.length} entries. Per-PR detail
                        is on the{" "}
                        <Link href="/byok?tab=credits" className="font-medium">
                            BYOK → Credits
                        </Link>{" "}
                        tab.
                    </p>
                </CardContent>
            )}
        </Card>
    );
};
