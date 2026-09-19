"use client";

import { getBYOK } from "@services/organizationParameters/fetch";
import { useQuery } from "@tanstack/react-query";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { getCreditBalanceAction } from "src/features/ee/subscription/_actions/credits";
import { useKodusCredits } from "src/features/ee/subscription/_hooks/use-kodus-credits";
import type {
    CreditAutoTopUp,
    CreditBalance,
} from "src/features/ee/subscription/_services/billing/types";

import { routesThroughKodus } from "../_utils";

/** Default commercial parameters until billing answers (mirrors the billing
 *  service's creditPricing config; only used to render, never to charge). */
const FALLBACK = {
    packsUsd: [20, 50, 100, 500],
    markupPct: 7,
    lowThresholdUsd: 5,
    minPurchaseUsd: 10,
    maxPurchaseUsd: 5000,
};

export type KodusCreditBalanceView = {
    /** A model on the Kodus provider is CONFIGURED. Cheap, and true even when
     *  nothing routes to it — do not raise an alarm on this alone. */
    usesKodusProvider: boolean;
    /** Routing actually reaches a Kodus model (org default, fallback or a
     *  per-task override), so an empty balance really does pause reviews.
     *  Only resolved when it can change what the user is told. */
    routedThroughKodus: boolean;
    /** Live balance from billing, falling back to the license snapshot. */
    balanceUsd: number | undefined;
    /** Billing actually answered with a number. Every state flag below is
     *  gated on it, so a screen that renders a balance MUST check this first:
     *  coercing the unknown to 0 prints a confident "$0.00" that no badge and
     *  no warning accompanies, because all of them are false while it's
     *  unknown. "We don't know yet" and "you have nothing" look identical to
     *  the reader and mean opposite things. */
    known: boolean;
    /** Balance known and at or below zero. */
    exhausted: boolean;
    /** Balance known, positive, and at or below the low-balance threshold. */
    low: boolean;
    /** The org never bought credits: the balance is empty because nothing was
     *  ever added, not because it was spent. Drives the "add credits to start"
     *  framing instead of "used up". */
    neverFunded: boolean;
    autoTopUp: CreditAutoTopUp | null;
    /** Billing's answer, or null when it has none / is unreachable. */
    balance: CreditBalance | null | undefined;
    loading: boolean;
    packsUsd: number[];
    markupPct: number;
    minPurchaseUsd: number;
    maxPurchaseUsd: number;
    lowThresholdUsd: number;
};

/** Query key shared by every wallet surface (chip, provider card, wallet) so
 *  one invalidation after a top-up refreshes all of them. */
export const kodusCreditBalanceKey = (teamId: string | undefined) => [
    "kodus-credits",
    "balance",
    teamId,
];

/**
 * The single source of the prepaid balance for the app chrome. Renders from
 * the license snapshot immediately (no flash), then swaps in billing's live
 * number. Fetches only for orgs that route through Kodus — everyone else
 * pays nothing for this hook.
 */
export const useKodusCreditBalance = (): KodusCreditBalanceView => {
    const { teamId } = useSelectedTeamId();
    const credits = useKodusCredits();

    const query = useQuery<CreditBalance | null>({
        queryKey: kodusCreditBalanceKey(teamId),
        queryFn: () => getCreditBalanceAction({ teamId }),
        enabled: !!teamId && credits.usesKodusProvider,
        staleTime: 30_000,
    });

    const balance = query.data;
    const balanceUsd =
        typeof balance?.balanceUsd === "number"
            ? balance.balanceUsd
            : credits.balanceUsd;
    const lowThresholdUsd =
        balance?.lowThresholdUsd ?? FALLBACK.lowThresholdUsd;
    const known = typeof balanceUsd === "number";

    const exhausted = known && balanceUsd <= 0;
    const low = known && balanceUsd > 0 && balanceUsd <= lowThresholdUsd;

    // Connecting Kodus is not the same as routing to it. Asked when the
    // balance is gone OR running out on an org that has Kodus configured —
    // the cases where the answer decides between "this threatens your
    // reviews" and "nothing happens here". It used to be asked for
    // `exhausted` alone, which quietly made `routedThroughKodus` always false
    // while merely low: anything gated on both could never fire.
    const routingQuery = useQuery({
        queryKey: ["kodus-credits", "routing", teamId],
        queryFn: () => getBYOK(),
        enabled: credits.usesKodusProvider && (exhausted || low),
        staleTime: 60_000,
    });

    return {
        usesKodusProvider: credits.usesKodusProvider,
        routedThroughKodus: routesThroughKodus(routingQuery.data),
        balanceUsd,
        known,
        exhausted,
        low,
        neverFunded:
            exhausted && !!balance && balance.lifetimePurchasedUsd === 0,
        autoTopUp: balance?.autoTopUp ?? null,
        balance,
        loading: query.isLoading && !known,
        packsUsd: balance?.packsUsd ?? FALLBACK.packsUsd,
        markupPct: balance?.markupPct ?? FALLBACK.markupPct,
        minPurchaseUsd: balance?.minPurchaseUsd ?? FALLBACK.minPurchaseUsd,
        maxPurchaseUsd: balance?.maxPurchaseUsd ?? FALLBACK.maxPurchaseUsd,
        lowThresholdUsd,
    };
};

/** The wallet's home: the Kodus provider card on the BYOK page. */
export const KODUS_CREDITS_PATH = "/byok#kodus";
