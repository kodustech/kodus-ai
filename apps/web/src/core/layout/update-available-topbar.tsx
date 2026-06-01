"use client";

import { Link } from "@components/ui/link";
import { ArrowRightIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { isSelfHosted } from "src/core/utils/self-hosted";

/**
 * Top-of-app banner that nudges self-hosted owners to upgrade when a
 * newer `selfhosted-*` release is available on GitHub.
 *
 * Implementation notes:
 *   - Plain `fetch` inside `useEffect`. We deliberately avoid React
 *     Query here even though the navbar already prefetches the same
 *     `/api/version`: an earlier iteration that called `useQuery` from
 *     this component (rendered in the shared `(app)/layout.tsx`) was
 *     correlated with Turbopack 15.5.15 silently exiting the dev
 *     server during heavy route compilations (e.g. /cockpit). The
 *     plain-fetch version drops the dependency on the QueryClient
 *     context entirely.
 *   - All side effects gated behind `isSelfHosted && isOwner`, so
 *     cloud users never trigger the fetch and members never trigger
 *     it either.
 *   - Dismissal stored per-version in localStorage. A newer release
 *     unsets the dismissal automatically.
 */

const RELEASES_URL = "https://github.com/kodustech/kodus-ai/releases";
const DISMISS_KEY = "kodus.update-banner.dismissed-version";

type VersionData = {
    current: string;
    latest: string | null;
    hasUpdate: boolean;
};

export const UpdateAvailableTopbar = ({ isOwner }: { isOwner: boolean }) => {
    const [data, setData] = useState<VersionData | null>(null);
    const [dismissedVersion, setDismissedVersion] = useState<string | null>(
        null,
    );

    useEffect(() => {
        if (!isSelfHosted || !isOwner) return;

        try {
            setDismissedVersion(window.localStorage.getItem(DISMISS_KEY));
        } catch {
            // localStorage may be unavailable (private mode, etc) — fine.
        }

        const ac = new AbortController();
        fetch("/api/version", { signal: ac.signal })
            .then((r) => (r.ok ? (r.json() as Promise<VersionData>) : null))
            .then((json) => {
                if (json) setData(json);
            })
            .catch(() => {
                // Silent: the banner is best-effort. If GitHub is
                // unreachable or the endpoint hiccups, we just don't
                // show anything.
            });

        return () => ac.abort();
    }, [isOwner]);

    if (!isSelfHosted || !isOwner) return null;
    if (!data?.hasUpdate || !data.latest) return null;
    if (dismissedVersion === data.latest) return null;

    const onDismiss = () => {
        try {
            window.localStorage.setItem(DISMISS_KEY, data.latest!);
        } catch {
            // ignore
        }
        setDismissedVersion(data.latest);
    };

    return (
        <div className="bg-primary-light/15 flex items-center justify-center gap-3 px-4 py-2 text-center text-sm">
            <span>
                Update available:{" "}
                <code className="bg-card-lv2 rounded px-1 py-0.5 font-mono text-xs">
                    {data.current}
                </code>{" "}
                →{" "}
                <code className="bg-card-lv2 rounded px-1 py-0.5 font-mono text-xs">
                    {data.latest}
                </code>
            </span>
            <Link
                href={RELEASES_URL}
                target="_blank"
                className="font-bold underline-offset-2 hover:underline">
                Release notes
                <ArrowRightIcon className="ml-1 inline size-4" />
            </Link>
            <button
                type="button"
                aria-label="Dismiss update banner"
                onClick={onDismiss}
                className="text-text-tertiary hover:text-text-secondary ml-2 transition">
                <XIcon className="size-4" />
            </button>
        </div>
    );
};
