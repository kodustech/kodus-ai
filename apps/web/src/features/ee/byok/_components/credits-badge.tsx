"use client";

import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { formatUsd } from "@services/usage/format";
import { AlertTriangle, CoinsIcon } from "lucide-react";

import {
    KODUS_CREDITS_PATH,
    useKodusCreditBalance,
} from "../_hooks/use-kodus-credit-balance";

/**
 * Navbar wallet chip — the balance an org burns when it routes models
 * through the Kodus provider. Sits next to the plan pill (the navbar's
 * "status strip") and renders ONLY for orgs that use the provider; for
 * everyone else the navbar is unchanged.
 *
 * Three tones, one word each: the number (fine), "Low" (amber, top up
 * soon), "Top up" (red, reviews on Kodus models are paused). Click lands on
 * the wallet (BYOK → Credits), where the money is managed.
 */
export const CreditsBadge = () => {
    const credits = useKodusCreditBalance();
    if (!credits.usesKodusProvider) return null;

    const known = typeof credits.balanceUsd === "number";
    const amount = known ? formatUsd(credits.balanceUsd!) : "—";

    const pill = credits.exhausted ? (
        <Button
            decorative
            size="sm"
            variant="error"
            leftIcon={<AlertTriangle />}
            data-testid="kodus-credits-badge"
            data-state="exhausted">
            Top up credits
        </Button>
    ) : credits.low ? (
        <Button
            decorative
            size="sm"
            variant="helper"
            leftIcon={<CoinsIcon />}
            className="text-warning ring-warning/50 tabular-nums ring-1 [--button-background:transparent]"
            data-testid="kodus-credits-badge"
            data-state="low">
            {amount}
        </Button>
    ) : (
        <Button
            decorative
            size="sm"
            variant="helper"
            leftIcon={<CoinsIcon />}
            className="ring-card-lv3 text-text-secondary tabular-nums ring-1 [--button-background:transparent]"
            data-testid="kodus-credits-badge"
            data-state="ok">
            {amount}
        </Button>
    );

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Link href={KODUS_CREDITS_PATH} noHoverUnderline>
                    {pill}
                </Link>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-64 text-xs">
                <div className="flex w-48 flex-col gap-2">
                    <div className="flex items-center gap-2">
                        <CoinsIcon className="text-text-tertiary size-3.5 shrink-0" />
                        <span className="text-text-secondary">
                            Kodus credits
                        </span>
                        <span className="text-text-primary ml-auto font-medium tabular-nums">
                            {amount}
                        </span>
                    </div>
                    <p className="border-card-lv3 text-text-tertiary border-t pt-2 leading-snug">
                        {credits.exhausted
                            ? "Used up — reviews on models routed by Kodus are paused until you top up."
                            : credits.low
                              ? "Running low. Models routed by Kodus stop when it hits zero."
                              : "Pays for the models Kodus routes for you. Click to manage."}
                    </p>
                </div>
            </TooltipContent>
        </Tooltip>
    );
};
