"use client";

import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import { Link } from "@components/ui/link";
import { formatUsd } from "@services/usage/format";
import { ArrowRightIcon, CoinsIcon } from "lucide-react";
import {
    KODUS_CREDITS_PATH,
    useKodusCreditBalance,
} from "src/features/ee/byok/_hooks/use-kodus-credit-balance";

/**
 * Pointer from the plan page to the wallet. Someone who paid for a credit
 * pack looks for it under "Subscription" first — this row tells them the
 * balance and where it is managed (BYOK → Credits, next to the Kodus
 * provider it funds). It is a signpost, not a second wallet: no top-up, no
 * ledger here. Renders nothing for an org that does not use the provider.
 */
export const CreditsCard = () => {
    const credits = useKodusCreditBalance();
    if (!credits.usesKodusProvider) return null;

    const amount =
        typeof credits.balanceUsd === "number"
            ? formatUsd(credits.balanceUsd)
            : "—";

    return (
        <Card color="lv1" className="w-full">
            <CardHeader className="flex flex-row items-center justify-between gap-4 py-4">
                <div className="flex min-w-0 items-center gap-3">
                    <CoinsIcon
                        size={16}
                        className="text-text-tertiary shrink-0"
                    />
                    <div className="flex min-w-0 flex-col">
                        <span className="text-text-primary text-sm font-medium">
                            Kodus credits
                            <span className="text-text-secondary ml-2 font-normal tabular-nums">
                                {amount}
                            </span>
                        </span>
                        <span className="text-text-tertiary text-xs text-pretty">
                            Separate from your plan. Pays for the models Kodus
                            routes for you; managed with the Kodus provider.
                        </span>
                    </div>
                </div>
                <Link href={KODUS_CREDITS_PATH} noHoverUnderline>
                    <Button
                        decorative
                        size="sm"
                        variant={credits.exhausted ? "primary" : "helper"}
                        rightIcon={<ArrowRightIcon />}>
                        {credits.exhausted ? "Top up" : "Manage credits"}
                    </Button>
                </Link>
            </CardHeader>
        </Card>
    );
};
