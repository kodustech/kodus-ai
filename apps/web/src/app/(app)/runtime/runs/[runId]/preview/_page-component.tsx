"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import NextLink from "next/link";
import { RuntimeEmptyState } from "@components/runtime/empty-state";
import { Page } from "@components/ui/page";
import type { PreviewSide, RuntimePreview } from "@services/runtime/contracts";
import {
    checkPreviewGrantUrl,
    PreviewGrantUrlRefused,
    previewErrorMessage,
    previewSideLabel,
    previewStep,
} from "@services/runtime/model/preview";
import {
    useGrantRunPreview,
    useOpenEnvironmentPreview,
    useOpenRunPreview,
    useRunPreview,
} from "@services/runtime/queries";

/**
 * /runtime/runs/:runId/preview?side=pr|base: opens the preview of one side
 * of a Run, waits for its record, then sends this tab to the preview host
 * with a single-use grant (docs/runtime/preview-urls.md §6.4, §8.2). The
 * Run page opens this page in a new tab with rel="noopener noreferrer", so
 * the preview never reaches the Kodus tab.
 */
export function RunPreviewPage({
    runId,
    side,
    navigate,
}: {
    runId: string;
    side: PreviewSide | null;
    /** Where the grant URL goes: replace, so it never stays in this tab's history. */
    navigate?: (url: string) => void;
}) {
    const open = useOpenRunPreview();
    const backToRun = (
        <NextLink
            href={`/runtime/runs/${encodeURIComponent(runId)}`}
            className="text-primary-light underline-offset-2 hover:underline">
            Back to the Run
        </NextLink>
    );
    return (
        <PreviewLauncher
            title={`Preview of the ${side ? previewSideLabel(side) : "Run"}`}
            what={side ? `the ${previewSideLabel(side)} of this Run` : "this Run"}
            back={backToRun}
            start={side ? () => open.mutateAsync({ runId, side }) : undefined}
            missing={
                <RuntimeEmptyState title="Choose a side to preview" role="alert">
                    <p>Open the preview from the Run page: the PR version or the base. {backToRun}</p>
                </RuntimeEmptyState>
            }
            {...(navigate ? { navigate } : {})}
        />
    );
}

/**
 * /runtime/environments/:environmentId/preview: the environment's own
 * preview, its base at the commit its last setup baked (§8.3), opened the
 * same way as a Run's.
 */
export function EnvironmentPreviewPage({
    environmentId,
    navigate,
}: {
    environmentId: string;
    navigate?: (url: string) => void;
}) {
    const open = useOpenEnvironmentPreview();
    const back = (
        <NextLink
            href={`/runtime/environments/${encodeURIComponent(environmentId)}`}
            className="text-primary-light underline-offset-2 hover:underline">
            Back to the environment
        </NextLink>
    );
    return (
        <PreviewLauncher
            title="Preview of the environment"
            what="the environment at its last setup"
            back={back}
            start={() => open.mutateAsync(environmentId)}
            {...(navigate ? { navigate } : {})}
        />
    );
}

/**
 * Open once, read until it can be entered, grant once, and replace this tab
 * with the preview host. The open's and the grant's results are taken from
 * their promises into this component's state, never through the mutation
 * observer: React mounts, unmounts and mounts a component again under
 * StrictMode (and on any remount), and a result or callback bound to the
 * first mount's observer is dropped with it, which left the page on
 * "Starting preview…" (dev VM, 2026-11-13).
 */
function PreviewLauncher({
    title,
    what,
    back,
    start,
    missing,
    navigate = (url) => window.location.replace(url),
}: {
    title: string;
    what: string;
    back: ReactNode;
    start?: () => Promise<RuntimePreview>;
    missing?: ReactNode;
    navigate?: (url: string) => void;
}) {
    const grant = useGrantRunPreview();
    const [opened, setOpened] = useState<RuntimePreview>();
    const [openError, setOpenError] = useState<unknown>();
    const [grantError, setGrantError] = useState<unknown>();
    const didOpen = useRef(false);
    const granted = useRef(false);

    useEffect(() => {
        if (!start || didOpen.current) return;
        didOpen.current = true;
        start().then(setOpened, setOpenError);
    }, [start]);

    const status = useRunPreview(opened?.previewId);
    const view = status.data ?? opened;
    const step = previewStep(view);

    useEffect(() => {
        if (step.kind !== "grant" || !view || granted.current) return;
        granted.current = true;
        grant.mutateAsync(view.previewId).then(({ redirectUrl }) => {
            const checked = checkPreviewGrantUrl(redirectUrl, {
                host: view.host,
                appOrigin: window.location.origin,
            });
            if (checked.ok) navigate(checked.url);
            else setGrantError(new PreviewGrantUrlRefused());
        }, setGrantError);
    }, [grant, navigate, step.kind, view]);

    const error = openError ?? status.error ?? grantError;

    let body: ReactNode;
    if (!start) {
        body = missing;
    } else if (error) {
        body = (
            <RuntimeEmptyState title="The preview could not open" role="alert">
                <p>
                    {previewErrorMessage(error)} {back}
                </p>
            </RuntimeEmptyState>
        );
    } else if (step.kind === "blocked" || step.kind === "ended") {
        body = (
            <RuntimeEmptyState
                title={step.kind === "blocked" ? "The preview is not ready" : "The preview has ended"}
                role="status">
                <p>
                    {step.message} {back}
                </p>
            </RuntimeEmptyState>
        );
    } else {
        body = (
            <RuntimeEmptyState title="Starting preview…" role="status">
                <p>
                    Kodus boots {what} on its own machines; it takes about as
                    long as the Run&apos;s boot. This tab moves to the preview
                    when it is ready to open. It stops after{" "}
                    {view?.idleMinutes ?? 15} minutes without use.
                </p>
            </RuntimeEmptyState>
        );
    }

    return (
        <Page.Root>
            <Page.Header>
                <Page.Title>{title}</Page.Title>
            </Page.Header>
            <Page.Content>{body}</Page.Content>
        </Page.Root>
    );
}
