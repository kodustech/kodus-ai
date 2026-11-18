"use client";

import { useEffect, useState, type ReactNode } from "react";
import { toast } from "@components/ui/toaster/use-toast";
import { getRunEvidenceUrl } from "@services/runtime/api";
import type { EvidenceSide, EvidenceType } from "@services/runtime/contracts";
import { checkEvidenceUrl } from "@services/runtime/model/evidence-url";
import { ExternalLinkIcon } from "lucide-react";

/** The API mints URLs for 5 minutes; stop offering one a little before. */
const FALLBACK_TTL_MS = 4 * 60_000;

const openInNewTab = (url: string) => {
    // A real anchor with noopener + noreferrer: the new tab gets no handle on
    // this window and no Referer with the Run's URL.
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.click();
};

/**
 * Asks the API for the step's evidence (a URL valid for 5 minutes, on the
 * isolated evidence origin), checks it, and opens it. If the browser blocks
 * the new tab, the minted link stays on screen until it expires.
 */
export const EvidenceLink = ({
    runId,
    stepId,
    side,
    type,
    children,
}: {
    runId: string;
    stepId: string;
    side: EvidenceSide;
    type?: EvidenceType;
    children: ReactNode;
}) => {
    const [loading, setLoading] = useState(false);
    const [minted, setMinted] = useState<{ url: string; until: number }>();

    useEffect(() => {
        if (!minted) return;
        const timer = setTimeout(
            () => setMinted(undefined),
            Math.max(0, minted.until - Date.now()),
        );
        return () => clearTimeout(timer);
    }, [minted]);

    if (minted) {
        return (
            <a
                href={minted.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary-light inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline">
                {children}
                <ExternalLinkIcon className="size-3" aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
            </a>
        );
    }

    return (
        <button
            type="button"
            disabled={loading}
            aria-busy={loading}
            className="text-primary-light text-xs underline-offset-2 hover:underline disabled:opacity-60"
            onClick={async () => {
                setLoading(true);
                try {
                    const res = await getRunEvidenceUrl({
                        runId,
                        stepId,
                        side,
                        type,
                    });
                    const checked = checkEvidenceUrl(res.url, {
                        appOrigin: window.location.origin,
                    });
                    if (!checked.ok) {
                        console.warn("[Kody Runtime] evidence URL refused", {
                            runId,
                            stepId,
                            reason: checked.reason,
                        });
                        throw new Error(checked.reason);
                    }
                    const expires = res.expiresAt
                        ? Date.parse(res.expiresAt) - 15_000
                        : NaN;
                    setMinted({
                        url: checked.url,
                        until: Number.isFinite(expires)
                            ? expires
                            : Date.now() + FALLBACK_TTL_MS,
                    });
                    openInNewTab(checked.url);
                } catch {
                    toast({
                        variant: "danger",
                        title: "Evidence unavailable",
                        description:
                            "It may have expired (30 days) or this step kept none.",
                    });
                } finally {
                    setLoading(false);
                }
            }}>
            {children}
        </button>
    );
};
