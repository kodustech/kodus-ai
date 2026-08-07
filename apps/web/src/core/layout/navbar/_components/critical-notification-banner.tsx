"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@components/ui/button";
import {
    useMarkNotificationRead,
    useNotificationConfig,
    useNotifications,
} from "@services/notifications/hooks";
import type { UserNotification } from "@services/notifications/types";
import { AlertTriangleIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

/** The one page-severity event we summarise + allow dismissing per session. */
const BYOK_ERROR_EVENT = "byok.llm_errors_threshold";
const DISMISSED_STORAGE_KEY = "byok-error-banner-dismissed";

/** Raw provider ids ("moonshot", "openai_compatible") → human labels. */
const PROVIDER_DISPLAY: Record<string, string> = {
    anthropic: "Anthropic",
    anthropic_compatible: "Anthropic-compatible",
    openai: "OpenAI",
    openai_compatible: "OpenAI-compatible",
    google_gemini: "Google",
    google_vertex: "Google Vertex AI",
    amazon_bedrock: "Amazon Bedrock",
    azure: "Azure OpenAI",
    openrouter: "OpenRouter",
    open_router: "OpenRouter",
    novita: "Novita",
    moonshot: "Moonshot",
    z_ai: "Z.ai",
};

const prettyProvider = (raw: unknown): string => {
    if (typeof raw !== "string" || !raw.trim()) return "your provider";
    const key = raw.trim();
    if (PROVIDER_DISPLAY[key]) return PROVIDER_DISPLAY[key];
    // Title-case the fallback so a raw id never renders lowercase.
    return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
};

const readDismissed = (): Set<string> => {
    if (typeof window === "undefined") return new Set();
    try {
        const raw = window.sessionStorage.getItem(DISMISSED_STORAGE_KEY);
        return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
        return new Set();
    }
};

/**
 * Sticky banner at the top of the app shell for any unread notification whose
 * event is declared as `pageSeverity` in the catalog (billing failures,
 * security alerts, etc.).
 *
 * Most page-severity events are non-dismissible by design — the user resolves
 * them via the CTA. The BYOK LLM-error event is the exception: its backend copy
 * leaks raw account/key identifiers and a lowercase provider id, so here we
 * render a plain-language summary, capitalise the provider, tuck the raw
 * message behind "Show details", and let the user dismiss it for the session.
 */
export const CriticalNotificationBanner = () => {
    const router = useRouter();
    const { data: notifications } = useNotifications(1, 20, true);
    const { data: config } = useNotificationConfig();
    const markRead = useMarkNotificationRead();

    const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);
    const [showDetails, setShowDetails] = useState(false);

    const pageSeverityEvents = useMemo(() => {
        const set = new Set<string>();
        for (const entry of config?.events ?? []) {
            if (entry.pageSeverity) set.add(entry.event);
        }
        return set;
    }, [config]);

    const actionLabelByEvent = useMemo(() => {
        const map = new Map<string, string>();
        for (const entry of config?.events ?? []) {
            if (entry.actionLabel) map.set(entry.event, entry.actionLabel);
        }
        return map;
    }, [config]);

    const banner: UserNotification | null = useMemo(() => {
        const list = notifications?.data ?? [];
        // Most-recent unread page-severity notification. The query already
        // filters unreadOnly; we cross-check the catalog and skip a BYOK-error
        // banner the user has dismissed this session.
        return (
            list.find(
                (n) =>
                    pageSeverityEvents.has(n.delivery.event) &&
                    !(
                        n.delivery.event === BYOK_ERROR_EVENT &&
                        dismissed.has(n.uuid)
                    ),
            ) ?? null
        );
    }, [notifications, pageSeverityEvents, dismissed]);

    if (!banner) return null;

    const isByokError = banner.delivery.event === BYOK_ERROR_EVENT;
    const provider = isByokError
        ? prettyProvider(banner.delivery.metadata?.provider)
        : null;

    const title = isByokError
        ? `Your ${provider} key is failing`
        : banner.delivery.title;
    const body = isByokError
        ? `${provider} rejected recent requests — often an insufficient balance or a suspended/expired account. Reviews using this key may fail until it's fixed.`
        : banner.delivery.body;

    const handleAction = () => {
        markRead.mutate(banner.uuid);
        if (banner.delivery.ctaUrl) {
            router.push(banner.delivery.ctaUrl);
        }
    };

    const handleDismiss = () => {
        const next = new Set(dismissed).add(banner.uuid);
        setDismissed(next);
        setShowDetails(false);
        try {
            window.sessionStorage.setItem(
                DISMISSED_STORAGE_KEY,
                JSON.stringify([...next]),
            );
        } catch {
            /* sessionStorage unavailable — dismissal just won't persist */
        }
    };

    const actionLabel =
        actionLabelByEvent.get(banner.delivery.event) ?? "View";

    return (
        <div
            role="alert"
            aria-live="assertive"
            className={cn(
                "border-b-red-500/40 bg-red-500/10 sticky top-0 z-30",
                "flex items-start gap-3 border-b px-4 py-3 sm:px-6",
            )}>
            <AlertTriangleIcon
                aria-hidden
                className="mt-0.5 size-5 shrink-0 text-red-400"
            />
            <div className="min-w-0 flex-1">
                <p className="text-text-primary text-sm font-semibold text-balance">
                    {title}
                </p>
                <p className="text-text-secondary text-pretty text-xs">
                    {body}
                </p>

                {isByokError && (
                    <div className="mt-1.5 flex flex-col gap-1.5">
                        <button
                            type="button"
                            aria-expanded={showDetails}
                            onClick={() => setShowDetails((v) => !v)}
                            className="text-text-tertiary hover:text-text-primary flex items-center gap-1 self-start text-xs transition-colors">
                            <ChevronDownIcon
                                size={12}
                                className={cn(
                                    "transition-transform",
                                    showDetails && "rotate-180",
                                )}
                            />
                            {showDetails ? "Hide details" : "Show details"}
                        </button>
                        {showDetails && (
                            <p className="text-text-tertiary bg-card-lv2 rounded-md px-2.5 py-1.5 font-mono text-[11px] break-words">
                                {banner.delivery.body}
                            </p>
                        )}
                    </div>
                )}
            </div>

            {banner.delivery.ctaUrl && (
                <Button
                    size="xs"
                    variant="primary"
                    onClick={handleAction}
                    disabled={markRead.isPending}>
                    {actionLabel}
                </Button>
            )}

            {isByokError && (
                <button
                    type="button"
                    aria-label="Dismiss for this session"
                    onClick={handleDismiss}
                    className="text-text-tertiary hover:text-text-primary -mr-1 mt-0.5 shrink-0 transition-colors">
                    <XIcon className="size-4" />
                </button>
            )}
        </div>
    );
};
