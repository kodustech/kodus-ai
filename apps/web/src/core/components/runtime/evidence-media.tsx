"use client";

import {
    forwardRef,
    useEffect,
    useRef,
    useState,
    type RefObject,
    type VideoHTMLAttributes,
} from "react";
import { getRunEvidenceUrl } from "@services/runtime/api";
import type { EvidenceSide, EvidenceType } from "@services/runtime/contracts";
import { checkEvidenceUrl } from "@services/runtime/model/evidence-url";
import { cn } from "src/core/utils/components";

// A screenshot or a recording of a browser round (ADR-071), shown ONLY by
// the signed URL the API mints on the isolated evidence origin, as the src
// of an <img> or a <video>. Nothing of the artifact is ever read into this
// page or inlined into its DOM: the browser fetches it from that origin,
// which answers it as an attachment with a sandbox CSP. The URL lives five
// minutes; it is minted again a little before it ends.

const REFRESH_EARLY_MS = 30_000;
const FALLBACK_TTL_MS = 4 * 60_000;

type Media = { url?: string; failed: boolean };

/**
 * Whether the element is on screen: false inside a closed <details> or
 * scrolled away. Without IntersectionObserver (old browsers, tests), always
 * true.
 */
export const useOnScreen = (ref: RefObject<Element | null>) => {
    const [onScreen, setOnScreen] = useState(
        () => typeof IntersectionObserver === "undefined",
    );
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver(
            (entries) => setOnScreen(entries.some((e) => e.isIntersecting)),
            { rootMargin: "200px" },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [ref]);
    return onScreen;
};

/**
 * The signed URL of one artifact, checked against this app's origin and kept
 * fresh while it is on screen. Off screen (a closed "Evidence", a finding
 * scrolled away) nothing is minted (WP9: every closed finding minted each of
 * its screenshots and recordings every 4.5 minutes). Shown again, a URL that
 * is still valid is kept, so a recording does not restart (N5); one past its
 * refresh time is minted again.
 */
export const useEvidenceMedia = (input: {
    runId: string;
    stepId: string;
    side: EvidenceSide;
    type?: EvidenceType;
    onScreen?: boolean;
}): Media => {
    const { runId, stepId, side, type } = input;
    const onScreen = input.onScreen ?? true;
    const [media, setMedia] = useState<Media>({ failed: false });
    const held = useRef<{ key: string; url: string; refreshAt: number } | null>(
        null,
    );
    useEffect(() => {
        if (!type || !onScreen) return;
        const key = [runId, stepId, side, type].join("|");
        let alive = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const mint = async () => {
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
                if (!checked.ok) throw new Error(checked.reason);
                if (!alive) return;
                setMedia({ url: checked.url, failed: false });
                const until = res.expiresAt
                    ? Date.parse(res.expiresAt) - REFRESH_EARLY_MS
                    : NaN;
                const refreshAt = Number.isFinite(until)
                    ? until
                    : Date.now() + FALLBACK_TTL_MS;
                held.current = { key, url: checked.url, refreshAt };
                timer = setTimeout(
                    mint,
                    Math.max(15_000, refreshAt - Date.now()),
                );
            } catch {
                held.current = null;
                if (alive) setMedia({ failed: true });
            }
        };
        const kept =
            held.current?.key === key && held.current.refreshAt > Date.now()
                ? held.current
                : null;
        if (kept) {
            setMedia({ url: kept.url, failed: false });
            timer = setTimeout(mint, kept.refreshAt - Date.now());
        } else {
            setMedia({ failed: false });
            void mint();
        }
        return () => {
            alive = false;
            if (timer) clearTimeout(timer);
        };
    }, [runId, stepId, side, type, onScreen]);
    return media;
};

const Placeholder = ({
    children,
    className,
}: {
    children: string;
    className?: string;
}) => (
    <div
        className={cn(
            "bg-background text-text-tertiary flex aspect-video w-full items-center justify-center rounded-md text-xs",
            className,
        )}>
        {children}
    </div>
);

/** One screenshot (or pixel diff), from the evidence origin. */
export const EvidenceImage = ({
    runId,
    stepId,
    side,
    type,
    alt,
    className,
}: {
    runId: string;
    stepId: string;
    side: EvidenceSide;
    type?: EvidenceType;
    alt: string;
    className?: string;
}) => {
    const box = useRef<HTMLDivElement>(null);
    const onScreen = useOnScreen(box);
    const media = useEvidenceMedia({ runId, stepId, side, type, onScreen });
    return (
        <div ref={box}>
            {!type ? (
                <Placeholder className={className}>
                    No screenshot at this step
                </Placeholder>
            ) : media.failed ? (
                <Placeholder className={className}>
                    Screenshot unavailable
                </Placeholder>
            ) : !media.url ? (
                <Placeholder className={className}>Loading…</Placeholder>
            ) : (
                // eslint-disable-next-line @next/next/no-img-element -- a signed URL on another origin, never optimized or proxied
                <img
                    src={media.url}
                    alt={alt}
                    referrerPolicy="no-referrer"
                    draggable={false}
                    loading="lazy"
                    className={cn("block w-full rounded-md", className)}
                />
            )}
        </div>
    );
};

/** One round's recording, from the evidence origin. */
export const EvidenceVideo = forwardRef<
    HTMLVideoElement,
    {
        runId: string;
        stepId: string;
        side: EvidenceSide;
        label: string;
        available: boolean;
    } & Pick<
        VideoHTMLAttributes<HTMLVideoElement>,
        "onTimeUpdate" | "onPlay" | "onPause"
    >
>(function EvidenceVideo(
    { runId, stepId, side, label, available, ...events },
    ref,
) {
    const box = useRef<HTMLDivElement>(null);
    const onScreen = useOnScreen(box);
    const media = useEvidenceMedia({
        runId,
        stepId,
        side,
        type: available ? "video" : undefined,
        onScreen,
    });
    return (
        <div ref={box}>
            {!available ? (
                <Placeholder>No recording for this side</Placeholder>
            ) : media.failed ? (
                <Placeholder>Recording unavailable</Placeholder>
            ) : !media.url ? (
                <Placeholder>Loading…</Placeholder>
            ) : (
                <video
                    ref={ref}
                    src={media.url}
                    aria-label={label}
                    muted
                    playsInline
                    // Only its length and first frame until the reader plays it.
                    preload="metadata"
                    controls
                    className="bg-background block w-full rounded-md"
                    {...events}
                />
            )}
        </div>
    );
});
