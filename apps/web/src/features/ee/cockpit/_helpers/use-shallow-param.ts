"use client";

import { useCallback } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Shallow URL-synced state for in-card cockpit filters (segmented toggles,
 * search boxes). The value lives in the query string so the view is
 * shareable, but changing it only updates the URL via
 * `history.replaceState` — no server round-trip, since these filters act
 * on already-loaded data.
 *
 * The URL is the single source of truth: the value is derived from
 * `searchParams` every render, so browser back/forward (and any other URL
 * change) stay in sync. The param is dropped from the URL when it equals
 * the default, keeping shared links clean.
 *
 * `allowed` guards against a hand-edited/stale param selecting an invalid
 * option — it falls back to the default instead.
 */
export function useShallowParam<T extends string>(
    key: string,
    defaultValue: T,
    allowed?: readonly T[],
): [T, (next: T) => void] {
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const raw = searchParams.get(key) as T | null;
    const value: T =
        raw && (!allowed || allowed.includes(raw)) ? raw : defaultValue;

    const set = useCallback(
        (next: T) => {
            // Build from the LIVE query string, not a captured
            // `searchParams` snapshot: other shallow updates in the same
            // render cycle would otherwise be clobbered, breaking the
            // combined shareable link.
            const params = new URLSearchParams(window.location.search);
            if (next === defaultValue) params.delete(key);
            else params.set(key, next);

            const qs = params.toString();
            window.history.replaceState(
                null,
                "",
                qs ? `${pathname}?${qs}` : pathname,
            );
        },
        [key, defaultValue, pathname],
    );

    return [value, set];
}
