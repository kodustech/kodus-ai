"use client";

import { Button } from "@components/ui/button";
import { Card, CardContent } from "@components/ui/card";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import { formatUsd } from "@services/usage/format";
import { CoinsIcon, KeyRoundIcon, PencilIcon } from "lucide-react";

import { isPlatformFundedProvider } from "../_data/platform-funded";
import { PROVIDER_LABELS } from "../_data/provider-labels";
import { useKodusCreditBalance } from "../_hooks/use-kodus-credit-balance";
import type { BYOKCredential } from "../_types";
import { maskKey } from "../_utils";
import { ProviderLogo } from "./provider-logo";

/**
 * Collapsible provider group. The credential lives on the HEADER (masked key +
 * [Rotate]) — never on the per-model rows below it (SLICE 2). Open by default
 * when the group is small (≤3 models); the parent can force it via `defaultOpen`
 * (e.g. auto-collapse a freshly added group once several providers exist).
 *
 * `credential.apiKey` is already the server-masked `••••` display string; it is
 * only ever rendered, never re-sent. [Rotate] hands control back to the parent,
 * which builds the v2 blob with the blank-key keep rule.
 */
export function ProviderGroupHeader({
    credential,
    modelCount,
    defaultOpen,
    onRotate,
    onOpenCredits,
    children,
}: {
    credential: BYOKCredential;
    modelCount: number;
    defaultOpen?: boolean;
    onRotate?: () => void;
    /** Kodus group only: open the wallet (Credits tab) to top up. */
    onOpenCredits?: () => void;
    children: React.ReactNode;
}) {
    const providerLabel =
        PROVIDER_LABELS[credential.provider] ?? credential.provider;
    const open = defaultOpen ?? modelCount <= 3;
    // A platform-funded credential (Kodus) carries no key: there is nothing
    // to mask and nothing to rotate — usage is billed to the org's credits.
    const platformFunded = isPlatformFundedProvider(credential.provider);
    // The Kodus group is the thing the balance pays for, so the balance sits
    // on it — where a key would sit for any other provider.
    const credits = useKodusCreditBalance();
    const balanceLabel =
        typeof credits.balanceUsd === "number"
            ? formatUsd(credits.balanceUsd)
            : "—";
    const balanceTone = credits.exhausted
        ? "text-danger"
        : credits.low
          ? "text-warning"
          : "text-text-tertiary";

    return (
        <Card color="lv1">
            <Collapsible defaultOpen={open}>
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                    <CollapsibleTrigger asChild>
                        <button
                            type="button"
                            className="group/trigger flex min-w-0 flex-1 items-center gap-3 text-left">
                            <CollapsibleIndicator />
                            <ProviderLogo
                                provider={credential.provider}
                                label={providerLabel}
                                className="size-9"
                            />
                            <span className="flex min-w-0 flex-col gap-0.5">
                                <span className="text-text-primary text-sm font-semibold text-balance">
                                    {providerLabel}
                                </span>
                                <span className="text-text-tertiary flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                                    {platformFunded ? (
                                        <span
                                            className={`flex items-center gap-1.5 tabular-nums ${balanceTone}`}
                                            data-testid="kodus-provider-balance">
                                            <CoinsIcon size={12} />
                                            {credits.exhausted
                                                ? `Credits used up · reviews paused`
                                                : `${balanceLabel} credits · no key needed`}
                                        </span>
                                    ) : (
                                        <span className="flex items-center gap-1.5 font-mono">
                                            <KeyRoundIcon size={12} />
                                            {maskKey(credential.apiKey)}
                                        </span>
                                    )}
                                    <span aria-hidden>·</span>
                                    <span className="tabular-nums">
                                        {modelCount}{" "}
                                        {modelCount === 1 ? "model" : "models"}
                                    </span>
                                </span>
                            </span>
                        </button>
                    </CollapsibleTrigger>

                    {platformFunded && onOpenCredits && (
                        <Button
                            size="xs"
                            variant={credits.exhausted ? "primary" : "helper"}
                            leftIcon={<CoinsIcon />}
                            onClick={onOpenCredits}>
                            Top up
                        </Button>
                    )}

                    {onRotate && !platformFunded && (
                        <Button
                            size="xs"
                            variant="helper"
                            leftIcon={<PencilIcon />}
                            onClick={onRotate}>
                            Edit provider
                        </Button>
                    )}
                </div>

                <CollapsibleContent className="px-4">
                    <CardContent className="p-0">{children}</CardContent>
                </CollapsibleContent>
            </Collapsible>
        </Card>
    );
}
