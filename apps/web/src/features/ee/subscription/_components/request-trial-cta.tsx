"use client";

import { useEffect, useState } from "react";
import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { ArrowUpRightIcon } from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";

import {
    buildTrialRequestUrl,
    type TrialRequestContext,
} from "../_utils/trial-request";

/**
 * Way out of the dead end an unlicensed self-hosted instance lands in:
 * the license card asks for a key without saying how to get one.
 *
 * The form itself lives outside the product (see
 * SELF_HOSTED_TRIAL_REQUEST_URL) — a self-hosted instance stays on a
 * pinned version for months, so an in-app form would freeze with it. Only
 * the button ships here, carrying the context we already know so nobody
 * retypes their org id.
 *
 * Note the network shape: the browser opens the link, the instance never
 * calls out. An instance with no egress of its own still works, as long as
 * the operator's machine has internet — the common "airgapped" case.
 */
export const RequestTrialCta = () => {
    const { email, organizationId } = useAuth();
    const [version, setVersion] = useState<string>();

    useEffect(() => {
        const ac = new AbortController();

        fetch("/api/version", { signal: ac.signal })
            .then((res) => (res.ok ? (res.json() as Promise<unknown>) : null))
            .then((json) => {
                const current = (json as { current?: string } | null)?.current;
                if (current && current !== "unknown") setVersion(current);
            })
            .catch(() => {
                // Best-effort: the version only enriches the request, and
                // this endpoint reaches out to GitHub. Never block the CTA.
            });

        return () => ac.abort();
    }, []);

    const context: TrialRequestContext = { organizationId, email, version };
    const requestUrl = buildTrialRequestUrl(context);

    return (
        <Link href={requestUrl} target="_blank" noHoverUnderline>
            {/* `decorative` renders a span: the Link already provides the
                anchor, and <a><button> is invalid nesting. */}
            <Button
                decorative
                size="md"
                variant="primary"
                rightIcon={<ArrowUpRightIcon />}>
                Request a trial
            </Button>
        </Link>
    );
};
