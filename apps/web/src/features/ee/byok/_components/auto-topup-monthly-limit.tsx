"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import type { CreditAutoTopUp } from "src/features/ee/subscription/_services/billing/types";

export function AutoTopUpMonthlyLimit({
    auto,
    disabled,
    onSave,
}: {
    auto: CreditAutoTopUp;
    disabled: boolean;
    onSave: (limit: number | null) => void;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    // An old billing deployment cannot enforce this setting. Wait for its
    // budget response rather than offering a limit it would silently ignore.
    if (auto.monthlyPurchasedUsd === undefined) return null;

    const value = draft ?? String(auto.monthlyLimitUsd ?? "");
    const limit = value.trim() === "" ? null : Number(value);
    const valid =
        limit === null ||
        (Number.isSafeInteger(limit) && limit >= 0 && limit <= 99999999);
    const changed = valid && limit !== (auto.monthlyLimitUsd ?? null);
    const money = (n: number) =>
        `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    const resets = auto.resetsAt
        ? new Date(auto.resetsAt).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              timeZone: "UTC",
          })
        : "next month";

    return (
        <div className="flex w-full flex-col gap-2 pt-2">
            <div className="flex flex-wrap items-center gap-2">
                <label
                    htmlFor="auto-topup-monthly-limit"
                    className="text-text-primary font-medium">
                    Monthly auto top-up limit (USD)
                </label>
                <Input
                    id="auto-topup-monthly-limit"
                    size="md"
                    type="number"
                    min={0}
                    max={99999999}
                    step={1}
                    placeholder="No limit"
                    value={value}
                    disabled={disabled}
                    aria-invalid={!valid}
                    aria-describedby="auto-topup-monthly-limit-help"
                    className="w-28"
                    onChange={(event) => setDraft(event.target.value)}
                />
                <Button
                    size="xs"
                    variant="helper"
                    disabled={disabled || !changed}
                    onClick={() => {
                        if (valid) onSave(limit);
                    }}>
                    Save limit
                </Button>
            </div>
            <p
                id="auto-topup-monthly-limit-help"
                className="text-text-secondary">
                Limit credits added automatically, before the platform fee.
                Manual top-ups are separate. Leave blank for no limit; use 0 to
                pause automatic purchases. Resets {resets} (UTC).
            </p>
            {!valid && (
                <p role="alert" className="text-danger">
                    Enter a whole dollar amount from 0 to 99,999,999.
                </p>
            )}
            <p className="text-text-secondary" aria-live="polite">
                This month: {money(auto.monthlyPurchasedUsd)} added
                automatically
                {(auto.monthlyReservedUsd ?? 0) > 0
                    ? ` · ${money(auto.monthlyReservedUsd!)} pending`
                    : ""}
                {auto.monthlyLimitUsd != null
                    ? ` · limit ${money(auto.monthlyLimitUsd)}`
                    : " · no limit"}
                .
            </p>
            {auto.enabled && auto.monthlyLimitReached && (
                <p role="status" className="text-warning">
                    Monthly limit blocks the next auto top-up. Increase the
                    limit or wait until {resets} (UTC).
                </p>
            )}
        </div>
    );
}
