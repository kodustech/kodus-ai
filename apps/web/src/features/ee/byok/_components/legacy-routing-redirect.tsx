"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@components/ui/spinner";

import { routingHref } from "./routing/routing-state";

/** Fragments never reach the server. Read one before replacing the old URL. */
export function LegacyRoutingRedirect() {
    const router = useRouter();
    useEffect(() => {
        let anchor: string | undefined;
        try {
            anchor = decodeURIComponent(window.location.hash.slice(1));
        } catch {
            // A malformed fragment still opens the canonical screen.
        }
        router.replace(routingHref(anchor));
    }, [router]);
    return <Spinner />;
}
