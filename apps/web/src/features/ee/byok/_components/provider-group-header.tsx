"use client";

import { Button } from "@components/ui/button";
import { Card, CardContent } from "@components/ui/card";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import { KeyRoundIcon, RotateCwIcon } from "lucide-react";

import type { BYOKCredential } from "../_types";
import { maskKey } from "../_utils";
import { PROVIDER_LABELS } from "./catalog/model-card";

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
    children,
}: {
    credential: BYOKCredential;
    modelCount: number;
    defaultOpen?: boolean;
    onRotate?: () => void;
    children: React.ReactNode;
}) {
    const providerLabel =
        PROVIDER_LABELS[credential.provider] ?? credential.provider;
    const open = defaultOpen ?? modelCount <= 3;

    return (
        <Card color="lv1">
            <Collapsible defaultOpen={open}>
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                    <CollapsibleTrigger asChild>
                        <button
                            type="button"
                            className="group/trigger flex min-w-0 flex-1 items-center gap-3 text-left">
                            <CollapsibleIndicator />
                            <span className="text-text-primary text-sm font-semibold text-balance">
                                {providerLabel}
                            </span>
                            <span className="text-text-tertiary flex items-center gap-1.5 font-mono text-xs">
                                <KeyRoundIcon size={12} />
                                {maskKey(credential.apiKey)}
                            </span>
                        </button>
                    </CollapsibleTrigger>

                    {onRotate && (
                        <Button
                            size="xs"
                            variant="helper"
                            leftIcon={<RotateCwIcon />}
                            onClick={onRotate}>
                            Rotate
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
