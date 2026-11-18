"use client";

import NextLink from "next/link";
import { RuntimeSection, RuntimeSubsection } from "@components/runtime/section";
import { Button } from "@components/ui/button";
import { toast } from "@components/ui/toaster/use-toast";
import { usePermission, usePermissionOnEvery } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type {
    PreviewSide,
    RuntimePreview,
    RuntimePreviewOffer,
    RuntimeRun,
} from "@services/runtime/contracts";
import { repositoryIdsOfRun } from "@services/runtime/model/environment-repositories";
import {
    mayStopPreview,
    previewErrorMessage,
    previewHref,
    previewSideStatus,
    previewStopsHint,
    type PreviewTone,
} from "@services/runtime/model/preview";
import { useRunPreviews, useStopRunPreview } from "@services/runtime/queries";
import { ExternalLinkIcon, SquareIcon } from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";

const TONE: Record<PreviewTone, string> = {
    neutral: "text-text-secondary",
    busy: "text-warning",
    ok: "text-success",
    warn: "text-danger",
};

/** An "open in a new tab" link to this app's preview page: never the preview host, never with an opener. */
export const PreviewOpenLink = ({
    href,
    label,
    disabled,
}: {
    href: string;
    label: string;
    disabled?: boolean;
}) =>
    disabled ? (
        <span className="bg-card-lv2 text-text-placeholder inline-flex min-h-10 items-center gap-2 rounded-xl px-5 text-sm font-semibold">
            {label}
        </span>
    ) : (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-card-lv2 text-text-primary focus-visible:ring-ring inline-flex min-h-10 items-center gap-2 rounded-xl px-5 text-sm font-semibold hover:brightness-120 focus-visible:ring-3 focus-visible:outline-none">
            {label}
            <ExternalLinkIcon className="size-4" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
        </a>
    );

/** Stop: the opener or an owner; gives the machines back and ends every session. */
export const PreviewStopButton = ({ view }: { view: RuntimePreview }) => {
    const stop = useStopRunPreview();
    return (
        <Button
            size="sm"
            variant="helper"
            leftIcon={<SquareIcon />}
            loading={stop.isPending}
            onClick={() =>
                stop.mutate(view.previewId, {
                    onError: (error) =>
                        toast({
                            variant: "danger",
                            title: "Couldn't stop the preview",
                            description: previewErrorMessage(error),
                        }),
                })
            }>
            Stop
        </Button>
    );
};

/** One side of a preview: its button, its state, and Stop for those who may. */
export const PreviewSideRow = ({
    title,
    href,
    view,
    refusal,
}: {
    title: string;
    href: string;
    view?: RuntimePreview;
    /** Why this side does not open (a fork's PR side): shown instead of the button. */
    refusal?: string;
}) => {
    const { userId } = useAuth();
    const isOwner = usePermission(Action.Manage, ResourceType.RuntimePreview);
    const status = previewSideStatus(view);
    return (
        <div className="bg-card-lv2/40 flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-text-primary text-sm font-semibold">{title}</span>
                <span className={`text-xs ${refusal ? "text-text-secondary" : TONE[status.tone]}`} role="status">
                    {refusal ?? status.label}
                </span>
            </div>
            {!refusal && (
                <div className="flex items-center gap-2">
                    {view && mayStopPreview(view, userId, isOwner) && <PreviewStopButton view={view} />}
                    <PreviewOpenLink href={href} label={view?.state === "sleeping" ? "Wake and open" : "Open"} disabled={!status.canOpen} />
                </div>
            )}
        </div>
    );
};

/** What the card says under its rows: when it stops, and secrets. */
export const PreviewFootnote = ({
    offer,
    views,
}: {
    offer: RuntimePreviewOffer;
    views: Array<RuntimePreview | undefined>;
}) => {
    const withoutSecrets = views.some((v) => v?.withoutSecrets) || offer.secrets === "none";
    return (
        <p className="text-text-tertiary text-xs">
            {previewStopsHint(offer)} Each side boots again on its own machines; your Run is not touched.
            {withoutSecrets && (
                <>
                    {" "}
                    Started without your organization&apos;s secrets, so integrations that need one may fail.
                </>
            )}
        </p>
    );
};

/**
 * The Run page's preview card (docs/runtime/preview-urls.md §8.2): each
 * side's state (not started, starting, ready, sleeping, stopped, expired),
 * Open in a new tab through this app, Stop for its opener or an owner, and
 * why it cannot open in plain words (previews off, a halted Run, a
 * multi-repository environment, a fork). Repo-scoped like the API.
 */
export const RunPreviewCard = ({
    run,
    embedded = false,
}: {
    run: Pick<RuntimeRun, "runId" | "repositoryId" | "state"> & Partial<Pick<RuntimeRun, "workspace">>;
    /** Inside a section that already has a panel ("What was running"). */
    embedded?: boolean;
}) => {
    const allowed = usePermissionOnEvery(Action.Read, ResourceType.RuntimePreview, repositoryIdsOfRun(run));
    const isOwner = usePermission(Action.Manage, ResourceType.RuntimePreview);
    const previews = useRunPreviews(run.runId, allowed);
    if (!allowed || !previews.data) return null;
    const { offer, sides } = previews.data;
    // Off on the deployment: nothing to offer here, and nothing an owner of the org can change.
    if (!offer.available && offer.code === "preview_off") return null;
    const side = (s: PreviewSide) => sides[s];
    const Section = embedded ? RuntimeSubsection : RuntimeSection;

    return (
        <Section
            id="preview"
            title="Preview"
            description="Open the app this Run booted in your browser, to click through the change yourself."
            aside={
                isOwner ? (
                    <NextLink href="/runtime/settings#preview" className="text-primary-light text-sm hover:underline">
                        Preview settings
                    </NextLink>
                ) : undefined
            }>
            {offer.available ? (
                <div className="flex flex-col gap-2">
                    <PreviewSideRow title="PR version" href={previewHref(run.runId, "pr")} view={side("pr")} refusal={offer.prReason} />
                    <PreviewSideRow title="Base version" href={previewHref(run.runId, "base")} view={side("base")} />
                    <PreviewFootnote offer={offer} views={[side("pr"), side("base")]} />
                </div>
            ) : (
                <p className="text-text-secondary text-sm" role="status">
                    {offer.reason}
                </p>
            )}
        </Section>
    );
};
