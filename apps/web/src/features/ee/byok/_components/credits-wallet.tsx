"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@components/ui/sheet";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { listKodusCreditCharges } from "@services/kodus-credits/fetch";
import type { KodusCreditCharge } from "@services/kodus-credits/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { formatUsd } from "@services/usage/format";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
    AlertTriangleIcon,
    CoinsIcon,
    CreditCardIcon,
    ReceiptTextIcon,
    RefreshCwIcon,
    SparklesIcon,
} from "lucide-react";
import { SkeletonRows } from "@components/system/page-skeletons";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { cn } from "src/core/utils/components";
import {
    createCreditCheckoutAction,
    createCreditPaymentMethodCheckoutAction,
    listCreditLedgerAction,
    removeCreditPaymentMethodAction,
    updateCreditAutoTopUpAction,
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
        return `${meta.auto ? "Auto top-up" : "Credit pack"}${charge}`;
    }
    return ENTRY_LABEL[entry.type];
};

/** Thresholds offered for auto top-up ("when the balance drops below…"). */
const THRESHOLDS_USD = [5, 10, 25, 50];

/**
 * The wallet, inside the Kodus provider card: one strip with the balance on
 * the left and the ways to add money on the right, plus the auto top-up row.
 * The balance is an attribute of this provider — it pays for nothing else —
 * so it lives on the card, not on a tab of its own. Stripe sends the user
 * back to this card. History (money ledger + charges by review) opens in a
 * drawer.
 */
export const CreditsWalletStrip = () => {
    const { teamId } = useSelectedTeamId();
    const router = useRouter();
    const searchParams = useSearchParams();
    const queryClient = useQueryClient();
    const credits = useKodusCreditBalance();
    const canEdit = usePermission(Action.Update, ResourceType.Billing);
    const [customAmount, setCustomAmount] = useState("");
    // Which amount is selected. The packs and "Other" are values of ONE
    // parameter, so they share one piece of state — they were four separate
    // buttons with one arbitrarily marked `primary`, which read as a
    // recommendation nobody asked for and made the other three look demoted.
    const [selected, setSelected] = useState<number | "other" | null>(null);
    const [ledgerOpen, setLedgerOpen] = useState(false);

    const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: ["kodus-credits"] });
        router.refresh();
    };

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
        } else if (creditsParam === "card_saved") {
            toast({
                variant: "success",
                title: "Card saved",
                description:
                    "You can turn on auto top-up now — it will show up in a moment.",
            });
        }
        const t =
            creditsParam === "success" || creditsParam === "card_saved"
                ? setTimeout(refresh, 3000)
                : undefined;
        router.replace(KODUS_CREDITS_PATH);
        return () => {
            if (t) clearTimeout(t);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [creditsParam]);

    // Which amount is being checked out, so the spinner lands on the button
    // that was pressed instead of every pack at once.
    const [pendingAmount, setPendingAmount] = useState<number | null>(null);
    const [topUp, { loading: checkingOut }] = useAsyncAction(
        async (creditUsd: number) => {
            setPendingAmount(creditUsd);
            try {
                const { url } = await createCreditCheckoutAction({
                    teamId,
                    creditUsd,
                });
                window.location.href = url;
            } finally {
                setPendingAmount(null);
            }
        },
    );

    // NOT `?? 0`. Billing failing to answer is not the same fact as an empty
    // wallet, and every state flag here (exhausted / low / neverFunded) is
    // gated on `known` — so coercing the unknown to zero used to print a
    // confident "$0.00" with no badge and no warning beside it, which is the
    // single most alarming thing this component can say. The provider header
    // one row above prints "—" for the same value, so the screen contradicted
    // itself. Unknown stays unknown, and buying is held until we can say what
    // the balance is.
    const { known, packsUsd: packs, markupPct: markup } = credits;
    const balanceUsd = credits.balanceUsd;
    const min = credits.minPurchaseUsd;
    const max = credits.maxPurchaseUsd;
    const custom = Number(customAmount);
    const customValid =
        customAmount.trim() !== "" &&
        Number.isFinite(custom) &&
        custom >= min &&
        custom <= max;
    // The pre-selected amount: the smallest pack on a first funding, the
    // second otherwise. A DEFAULT SELECTION, not a styled recommendation —
    // the difference matters, because the old version dressed this one pack
    // as `primary` and the other three as `helper`, which is the visual
    // language for "this action outranks those" and not for "this value is
    // pre-filled".
    const defaultPack = credits.neverFunded ? packs[0] : packs[1];
    const options: Array<number | "other"> = [...packs, "other"];
    const selectedOption = selected ?? defaultPack;
    // The amount actually being bought, whichever way it was chosen.
    const amount =
        selectedOption === "other"
            ? customValid
                ? Math.round(custom * 100) / 100
                : null
            : selectedOption;
    const amountValid = typeof amount === "number" && amount > 0;
    // What the card is actually charged, the fee included. The packs are
    // labelled with what lands in the wallet; this is what leaves the account,
    // and until now it appeared on screen only for custom amounts — so the
    // one-click path was the one path that never showed its price.
    const charged = (amount: number) => usd(amount * (1 + markup / 100));
    // Nothing is buyable while the balance is unknown: topping up blind is how
    // someone double-funds an account that was already full.
    const canBuy = canEdit && known;

    return (
        <div
            id="kodus-credits"
            data-testid="kodus-credits-wallet"
            /* No surface of its own: this sits inside the provider group's
               card, and the notices inside it carry surfaces too, so a tinted
               panel here made three nested boxes. A rule and space separate it
               just as well — what AutoTopUpRow already does below. */
            className="border-card-lv3/60 mb-3 flex flex-col gap-3 border-b px-1 pb-4">
            {credits.neverFunded && (
                <div
                    className="bg-primary-light/10 text-text-primary flex items-start gap-2 rounded-md px-3 py-2 text-sm"
                    data-testid="kodus-credits-never-funded">
                    <SparklesIcon size={16} className="mt-0.5 shrink-0" />
                    <span>
                        <strong className="font-semibold">
                            Add credits to start reviewing.
                        </strong>{" "}
                        Your Kodus model is set up, but reviews on it won&apos;t
                        run until the balance is funded. $20 covers hundreds of
                        reviews on the default model.
                    </span>
                </div>
            )}

            {/* Full width on purpose: the actions align to the same right edge
                as the "Edit model" buttons on the rows below. Capping the row
                instead left the cluster floating mid-card, out of step with
                everything under it. The left column carries its own measure. */}
            <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
                <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-text-secondary flex items-center gap-2 text-xs">
                        <CoinsIcon size={13} />
                        Kodus credits
                        {!known && !credits.loading ? (
                            <Badge variant="helper" size="xs">
                                Unavailable
                            </Badge>
                        ) : credits.neverFunded ? (
                            <Badge variant="helper" size="xs">
                                Not funded
                            </Badge>
                        ) : credits.exhausted ? (
                            <Badge variant="error" size="xs">
                                Used up
                            </Badge>
                        ) : credits.low ? (
                            <Badge variant="helper" size="xs">
                                Running low
                            </Badge>
                        ) : null}
                        {/* Reading past charges is not a way to spend money.
                            Sat in the buy cluster it was the loudest control
                            there — a drawer link outranking the purchase. It
                            belongs beside the label it reports on. */}
                        <Button
                            size="xs"
                            variant="cancel"
                            className="text-text-tertiary h-auto px-1.5 py-0"
                            leftIcon={<ReceiptTextIcon />}
                            onClick={() => setLedgerOpen(true)}>
                            History
                        </Button>
                    </span>
                    <span
                        className={cn(
                            "text-2xl font-semibold tabular-nums",
                            known ? "text-text-primary" : "text-text-tertiary",
                        )}
                        data-testid="kodus-credits-balance">
                        {credits.loading
                            ? "…"
                            : known
                              ? usd(balanceUsd as number)
                              : "—"}
                    </span>
                    <span className="text-text-tertiary max-w-md text-xs text-pretty">
                        {known || credits.loading ? (
                            <>
                                Pays for the models below, per token at the list
                                price shown on each model. A {markup}% platform
                                fee is added when you top up.
                            </>
                        ) : (
                            <>
                                We couldn&apos;t reach billing, so we can&apos;t
                                show your balance — it hasn&apos;t changed.
                                Topping up is held until we can read it again.
                            </>
                        )}
                    </span>
                </div>

                <div className="flex min-w-0 flex-col items-stretch gap-2 sm:shrink-0 sm:items-end">
                    {/* One form, one width. The selector, the field, the
                        confirm and the fine print all share the same left and
                        right edge — laid out as three right-aligned rows of
                        different widths they made a staircase that read as an
                        accident. And the selected chip no longer borrows the
                        accent: selection and "this is the button you press"
                        were the same colour, so two things competed to look
                        like the action. Selection is a filled surface; the
                        accent belongs to the button alone. */}
                    <div className="flex w-full flex-col gap-2 sm:w-80">
                        <div
                            role="radiogroup"
                            aria-label="Amount to add"
                            className="border-card-lv3/60 bg-card-lv1 grid grid-cols-5 gap-1 rounded-lg border p-1"
                            onKeyDown={(event) => {
                                const dir =
                                    event.key === "ArrowRight" ||
                                    event.key === "ArrowDown"
                                        ? 1
                                        : event.key === "ArrowLeft" ||
                                            event.key === "ArrowUp"
                                          ? -1
                                          : 0;
                                if (!dir) return;
                                event.preventDefault();
                                const at = options.indexOf(
                                    selectedOption as never,
                                );
                                const next =
                                    options[
                                        (at + dir + options.length) %
                                            options.length
                                    ];
                                setSelected(next);
                            }}>
                            {options.map((option) => {
                                const active = option === selectedOption;
                                return (
                                    <button
                                        key={String(option)}
                                        type="button"
                                        role="radio"
                                        aria-checked={active}
                                        tabIndex={active ? 0 : -1}
                                        disabled={!canBuy || checkingOut}
                                        onClick={() => setSelected(option)}
                                        className={cn(
                                            "focus-visible:ring-primary-light rounded-md px-1 py-1.5 text-center text-xs tabular-nums transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
                                            active
                                                ? "bg-card-lv3 text-text-primary ring-text-tertiary/30 font-semibold shadow-sm ring-1 ring-inset"
                                                : "text-text-secondary hover:text-text-primary hover:bg-card-lv3/40",
                                        )}>
                                        {option === "other"
                                            ? "Other"
                                            : usd(option, 0)}
                                    </button>
                                );
                            })}
                        </div>

                        {selectedOption === "other" && (
                            <div className="relative">
                                <span
                                    aria-hidden
                                    className="text-text-tertiary pointer-events-none absolute top-1/2 left-3 z-10 -translate-y-1/2 text-sm">
                                    $
                                </span>
                                <Input
                                    autoFocus
                                    size="md"
                                    className="w-full pl-7 tabular-nums"
                                    inputMode="decimal"
                                    placeholder={`${min}–${max}`}
                                    aria-label={`Custom amount, ${usd(min, 0)} to ${usd(max, 0)}`}
                                    value={customAmount}
                                    disabled={!canBuy}
                                    onChange={(e) =>
                                        setCustomAmount(e.target.value)
                                    }
                                />
                            </div>
                        )}

                        {/* The only accent on this surface, and it says what
                            it costs. */}
                        <Button
                            size="md"
                            variant="primary"
                            className="w-full"
                            disabled={!canBuy || checkingOut || !amountValid}
                            loading={
                                pendingAmount !== null &&
                                pendingAmount === amount
                            }
                            onClick={() => amount && topUp(amount)}>
                            {amountValid
                                ? `Top up ${charged(amount as number)}`
                                : "Top up"}
                        </Button>

                        <span className="text-text-tertiary text-right text-xs tabular-nums">
                            {selectedOption === "other" && !amountValid
                                ? `Enter ${usd(min, 0)}–${usd(max, 0)}`
                                : amountValid
                                  ? `Adds ${usd(amount as number, 2)} in credits · ${markup}% fee included`
                                  : `${markup}% fee added at checkout`}
                        </span>
                    </div>
                </div>
            </div>

            {credits.exhausted && !credits.neverFunded && (
                <div
                    className={cn(
                        "text-text-primary flex items-start gap-2 rounded-md px-3 py-2 text-xs",
                        credits.routedThroughKodus
                            ? "bg-danger/10"
                            : "bg-card-lv2",
                    )}>
                    {/* A sparkle on "your reviews are paused" is decoration
                        pretending to be a status. Reviews stopping is a
                        warning; the icon should say so. */}
                    {credits.routedThroughKodus ? (
                        <AlertTriangleIcon
                            size={14}
                            className="text-danger mt-0.5 shrink-0"
                        />
                    ) : (
                        <CoinsIcon size={14} className="mt-0.5 shrink-0" />
                    )}
                    <span>
                        {credits.routedThroughKodus
                            ? "Reviews on the models below are paused until you top up. Your own provider keys keep working."
                            : "Nothing routes here right now, so an empty balance changes nothing. Top up before you send a task to one of the models below."}
                    </span>
                </div>
            )}

            <AutoTopUpRow canEdit={canEdit} onChanged={refresh} />

            <CreditsLedgerDrawer
                open={ledgerOpen}
                onOpenChange={setLedgerOpen}
            />
        </div>
    );
};

/**
 * "Add $X when the balance drops below $Y" — what keeps a team from stalling
 * mid-week. Needs a saved card: the first pack purchase saves one
 * automatically; otherwise a Stripe setup session does.
 */
const AutoTopUpRow = ({
    canEdit,
    onChanged,
}: {
    canEdit: boolean;
    onChanged: () => void;
}) => {
    const { teamId } = useSelectedTeamId();
    const credits = useKodusCreditBalance();
    const auto = credits.autoTopUp;
    const packs = credits.packsUsd;
    const [threshold, setThreshold] = useState<number | null>(null);
    const [amount, setAmount] = useState<number | null>(null);

    const effectiveThreshold =
        threshold ?? auto?.thresholdUsd ?? credits.lowThresholdUsd;
    const effectiveAmount = amount ?? auto?.amountUsd ?? packs[1] ?? packs[0];

    const [save, { loading: saving }] = useAsyncAction(
        async (
            enabled: boolean,
            next?: { thresholdUsd?: number; amountUsd?: number },
        ) => {
            const thresholdUsd = next?.thresholdUsd ?? effectiveThreshold;
            const amountUsd = next?.amountUsd ?? effectiveAmount;
            try {
                await updateCreditAutoTopUpAction({
                    teamId,
                    enabled,
                    thresholdUsd,
                    amountUsd,
                });
                toast({
                    variant: "success",
                    title: enabled ? "Auto top-up on" : "Auto top-up off",
                    description: enabled
                        ? `We'll add ${usd(amountUsd, 0)} whenever the balance drops below ${usd(thresholdUsd, 0)}.`
                        : undefined,
                });
                onChanged();
            } catch (error) {
                if (
                    error instanceof Error &&
                    error.message === "NO_PAYMENT_METHOD"
                ) {
                    toast({
                        variant: "warning",
                        title: "Save a card first",
                        description:
                            "Auto top-up charges a saved card. Add one and try again.",
                    });
                    return;
                }
                toast({
                    variant: "danger",
                    title: "Couldn't save auto top-up",
                });
            }
        },
    );

    const [saveCard, { loading: savingCard }] = useAsyncAction(async () => {
        const { url } = await createCreditPaymentMethodCheckoutAction({
            teamId,
        });
        window.location.href = url;
    });

    const [removeCard, { loading: removingCard }] = useAsyncAction(async () => {
        await removeCreditPaymentMethodAction({ teamId });
        toast({ variant: "info", title: "Card removed" });
        onChanged();
    });

    if (!auto) return null;
    const enabled = auto.enabled;
    const busy = saving || savingCard || removingCard;

    return (
        <div
            className="border-card-lv3/60 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3 text-xs"
            data-testid="kodus-auto-topup">
            <label className="text-text-primary flex items-center gap-2 font-medium">
                <Switch
                    size="sm"
                    checked={enabled}
                    disabled={!canEdit || busy}
                    onCheckedChange={(next) => save(next)}
                    aria-label="Auto top-up"
                    data-testid="kodus-auto-topup-switch"
                />
                <RefreshCwIcon size={13} className="text-text-tertiary" />
                Auto top-up
            </label>

            <span className="text-text-secondary flex flex-wrap items-center gap-2">
                add
                <Select
                    value={String(effectiveAmount)}
                    disabled={!canEdit || busy}
                    onValueChange={(v) => {
                        const amountUsd = Number(v);
                        setAmount(amountUsd);
                        if (enabled) void save(true, { amountUsd });
                    }}>
                    <SelectTrigger
                        size="xs"
                        className="w-24 tabular-nums"
                        aria-label="Auto top-up amount">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {packs.map((p) => (
                            <SelectItem key={p} value={String(p)}>
                                {usd(p, 0)}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                when below
                <Select
                    value={String(effectiveThreshold)}
                    disabled={!canEdit || busy}
                    onValueChange={(v) => {
                        const thresholdUsd = Number(v);
                        setThreshold(thresholdUsd);
                        if (enabled) void save(true, { thresholdUsd });
                    }}>
                    <SelectTrigger
                        size="xs"
                        className="w-20 tabular-nums"
                        aria-label="Auto top-up threshold">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {THRESHOLDS_USD.map((t) => (
                            // A threshold above the amount would re-trigger
                            // right after every top-up; billing rejects it.
                            <SelectItem
                                key={t}
                                value={String(t)}
                                disabled={t > effectiveAmount}>
                                {usd(t, 0)}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </span>

            <span className="ml-auto flex items-center gap-2">
                {auto.paymentMethod ? (
                    <>
                        <span
                            className="text-text-secondary flex items-center gap-1.5"
                            data-testid="kodus-auto-topup-card">
                            <CreditCardIcon size={13} />
                            {auto.paymentMethod}
                        </span>
                        <Button
                            size="xs"
                            variant="cancel"
                            disabled={!canEdit || busy}
                            onClick={() => saveCard()}>
                            Change
                        </Button>
                        <Button
                            size="xs"
                            variant="cancel"
                            disabled={!canEdit || busy}
                            onClick={() => removeCard()}>
                            Remove
                        </Button>
                    </>
                ) : (
                    <Button
                        size="xs"
                        variant="helper"
                        leftIcon={<CreditCardIcon />}
                        disabled={!canEdit || busy}
                        loading={savingCard}
                        onClick={() => saveCard()}>
                        Save a card
                    </Button>
                )}
            </span>

            {auto.lastError && (
                <span
                    className="text-danger flex w-full items-center gap-1.5"
                    data-testid="kodus-auto-topup-error">
                    <AlertTriangleIcon size={13} />
                    Last automatic charge failed:{" "}
                    {auto.lastError.replace(/\.+$/, "")}. Update the card or top
                    up manually.
                </span>
            )}
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
                className="bg-card-lv1 flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
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

                <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-5">
                    <section className="flex flex-col gap-2">
                        <h3 className="text-text-primary text-sm font-semibold">
                            Money movements
                        </h3>
                        {ledgerQuery.isLoading ? (
                            <SkeletonRows rows={3} />
                        ) : ledger.length === 0 ? (
                            <p className="text-text-tertiary text-xs">
                                No top-ups or debits yet.
                            </p>
                        ) : (
                            <div className="-mx-1 overflow-x-auto px-1">
                                <table className="w-full min-w-[26rem] text-xs">
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
                            </div>
                        )}
                    </section>

                    <section className="flex flex-col gap-2">
                        <h3 className="text-text-primary text-sm font-semibold">
                            Charges by review
                        </h3>
                        {chargesQuery.isLoading ? (
                            <SkeletonRows rows={3} />
                        ) : (
                            <p className="text-text-tertiary text-xs">
                                {runs.length === 0
                                    ? "No Kodus-routed usage metered yet."
                                    : `${runs.length} run${runs.length === 1 ? "" : "s"} · ${formatUsd(total)} in the last ${chargesQuery.data?.length ?? 0} charges, newest first.`}
                            </p>
                        )}
                        {runs.length > 0 && (
                            <>
                                <div className="-mx-1 overflow-x-auto px-1">
                                <table className="w-full min-w-[26rem] text-xs">
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
                            </div>
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
