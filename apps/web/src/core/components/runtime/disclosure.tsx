"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Heading } from "@components/ui/heading";
import { decodeRouteParam } from "@services/runtime/route-params";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

// Native <details>/<summary>, as the other Runtime screens use: the summary is
// the button (keyboard and expanded state come with it), and it carries the
// takeaway, so a closed section still says what is inside. `defaultOpen` is
// read once: a Run that ends while the page is open never closes a section
// under the reader.

const SUMMARY =
    "focus-visible:ring-ring flex cursor-pointer list-none rounded-xl hover:brightness-120 focus-visible:ring-3 focus-visible:outline-none [&::-webkit-details-marker]:hidden";

/** Opens a disclosure by its id: an in-page link (the cost stat, the verdict's "Open the finding"). */
export const openDisclosure = (id: string) => {
    const el = document.getElementById(id);
    if (el instanceof HTMLDetailsElement) el.open = true;
};

/** The id of what is happening now inside a section (`<section>-live`: the setup step that runs), when there is one. */
export const liveId = (section: string) => `${section}-live`;

/**
 * Follows an in-page link to a section: opens it, then brings into view what runs in it now (`liveId`), else the
 * section itself. Without it a link to a section that is already open and on screen looks like it does nothing.
 */
export const followSection = (id: string) => {
    openDisclosure(id);
    requestAnimationFrame(() => {
        const target =
            document.getElementById(liveId(id)) ?? document.getElementById(id);
        target?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    });
};

/**
 * Opens the disclosure when the URL's fragment names it, or a section inside
 * it (`inner`), on load and on every change. An inner section is scrolled to
 * once open: the browser scrolled while it was still hidden.
 */
const useOpenOnHash = (id: string | undefined, inner: readonly string[]) => {
    const ref = useRef<HTMLDetailsElement>(null);
    const innerKey = inner.join(" ");
    useEffect(() => {
        const inside = innerKey ? innerKey.split(" ") : [];
        if (!id && !inside.length) return;
        const open = () => {
            const hash = decodeRouteParam(window.location.hash.slice(1));
            if (!ref.current || !hash) return;
            if (hash === id) ref.current.open = true;
            else if (inside.includes(hash)) {
                ref.current.open = true;
                requestAnimationFrame(() =>
                    document
                        .getElementById(hash)
                        ?.scrollIntoView?.({ behavior: "smooth" }),
                );
            }
        };
        open();
        window.addEventListener("hashchange", open);
        return () => window.removeEventListener("hashchange", open);
    }, [id, innerKey]);
    return ref;
};

const NO_INNER: readonly string[] = [];

/** A section of the Run page closed by default, its title and takeaway on the summary. */
export const RuntimeDisclosure = ({
    id,
    title,
    summary,
    defaultOpen = false,
    openFor = NO_INNER,
    children,
}: {
    id?: string;
    title: string;
    /** One line that says what is inside, read while the section is closed. */
    summary?: ReactNode;
    defaultOpen?: boolean;
    /** Ids of sections inside it: a link to one of them opens it. */
    openFor?: readonly string[];
    children: ReactNode;
}) => {
    const ref = useOpenOnHash(id, openFor);
    const [initialOpen] = useState(defaultOpen);
    return (
        <details
            ref={ref}
            id={id}
            open={initialOpen}
            className="group/section bg-card-lv1 scroll-mt-24 rounded-xl">
            <summary className={cn(SUMMARY, "items-start gap-3 px-6 py-4")}>
                <ChevronRightIcon
                    aria-hidden
                    className="text-text-secondary mt-0.5 size-4 shrink-0 transition-transform duration-200 group-open/section:rotate-90"
                />
                <span className="flex min-w-0 flex-col gap-1">
                    <Heading variant="h2" className="text-base">
                        {title}
                    </Heading>
                    {summary && (
                        <span className="text-text-secondary max-w-3xl text-sm">
                            {summary}
                        </span>
                    )}
                </span>
            </summary>
            <div className="flex flex-col gap-4 px-6 pb-6">{children}</div>
        </details>
    );
};

/**
 * A closed block inside a card ("Evidence", "Step-by-step replay"), its
 * takeaway on the summary. No panel of its own: what it opens already has
 * one, and a card inside a card inside a card reads as noise.
 */
export const InlineDisclosure = ({
    label,
    summary,
    defaultOpen = false,
    children,
}: {
    label: string;
    summary?: ReactNode;
    defaultOpen?: boolean;
    children: ReactNode;
}) => {
    const [initialOpen] = useState(defaultOpen);
    return (
        <details open={initialOpen} className="group/inline">
            <summary
                className={cn(
                    SUMMARY,
                    "-mx-2 min-h-11 items-start gap-2 px-2 py-2",
                )}>
                <ChevronRightIcon
                    aria-hidden
                    className="text-text-secondary mt-0.5 size-4 shrink-0 transition-transform duration-200 group-open/inline:rotate-90"
                />
                <span className="flex min-w-0 flex-col gap-0.5 text-sm">
                    <span className="text-text-primary font-medium">
                        {label}
                    </span>
                    {summary && (
                        <span className="text-text-secondary">{summary}</span>
                    )}
                </span>
            </summary>
            <div className="flex flex-col gap-3 pt-2">{children}</div>
        </details>
    );
};
