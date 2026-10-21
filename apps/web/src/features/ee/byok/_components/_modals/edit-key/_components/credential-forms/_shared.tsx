"use client";

import { Badge } from "@components/ui/badge";

/** Shared notice for newer, less battle-tested provider integrations. */
export const BetaProviderNotice = () => (
    <div className="border-card-lv2 bg-card-lv2/40 flex items-center gap-2 rounded-md border px-3 py-2 text-xs text-pretty">
        <Badge variant="helper" size="xs">
            Beta
        </Badge>
        <span className="text-text-secondary">
            This integration is newer and less battle-tested than other
            providers. Report any issues you hit — we iterate fast.
        </span>
    </div>
);
