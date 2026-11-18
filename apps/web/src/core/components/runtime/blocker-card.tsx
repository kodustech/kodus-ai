"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { toast } from "@components/ui/toaster/use-toast";
import type {
    AppliedBlockerFix,
    BlockerFix,
    BlockerGroup,
} from "@services/runtime/contracts";
import { blockerKindLabel } from "@services/runtime/labels";
import {
    membershipFixOf,
    settingsFixLink,
    type MembershipFixAction,
} from "@services/runtime/model/blockers";
import { repositoryChangeError } from "@services/runtime/model/environment-repositories";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import {
    useAddEnvironmentRepository,
    useApplyBlockerFix,
} from "@services/runtime/queries";
import {
    ArrowRightIcon,
    ExternalLinkIcon,
    GitPullRequestIcon,
    PlayIcon,
    PlusIcon,
} from "lucide-react";

import { RelativeTime } from "./relative-time";
import { StatusChip } from "./status-chip";

// A blocker as a card (docs §4, ADR-015): what blocked the environment in
// plain words, the log line that shows it, and the fixes in order, the first
// recommended. Every text comes from the catalog's templates; repository text
// is only the redacted evidence line, shown as code, never as markup (S-23).

const WHO_LABEL: Record<BlockerFix["who"], string> = {
    one_click: "One click",
    dev: "In your repository",
    kody: "Kody",
    settings: "In Kodus",
};
/** The chip of a fix made in Kodus's settings (settingsFixLink). */
const IN_KODUS_LABEL = "In Kodus";

/** Where a fix worked before (ADR-018), in a few words. */
export const learnedLabel = (l: NonNullable<BlockerFix["learned"]>) =>
    `Worked before ${l.scope === "org" ? "in your org" : "in this repository"}${l.helped > 1 ? ` (${l.helped}×)` : ""}`;

/** What the button of a fix says, or null when the dev makes it by hand. */
export const fixButtonLabel = (fix: BlockerFix): string | null => {
    if (fix.who === "one_click") return fix.label;
    if (fix.recipeDiff) return "Open the setup file PR";
    return null;
};

const appliedMessage = (out: AppliedBlockerFix) =>
    "pullRequest" in out
        ? {
              title: `Setup file PR #${out.pullRequest.number} opened`,
              description: "Merge it and the next setup boots with the change.",
          }
        : out.action === "approve_host"
          ? {
                title: `${out.host} allowed`,
                description: "A new setup has started with it.",
            }
          : {
                title: "Setup started again",
                description: "This page updates when it finishes.",
            };

const DiffBlock = ({ diff }: { diff: string }) => (
    <pre
        aria-label="Setup file change"
        className="bg-background overflow-x-auto rounded-md p-3 font-mono text-xs leading-5">
        {diff.split("\n").map((line, i) => (
            <span
                key={i}
                className={
                    line.startsWith("+") && !line.startsWith("+++")
                        ? "text-success block"
                        : line.startsWith("-") && !line.startsWith("---")
                          ? "text-danger block"
                          : "text-text-tertiary block"
                }>
                {line || " "}
            </span>
        ))}
    </pre>
);

/**
 * A fix about the environment's repositories: add the one the recipe needs
 * (it is connected), or connect it to Kodus first. The add is the same call
 * as the Repositories section's, so the card clears once it is in.
 */
const MembershipFixRow = ({
    environmentId,
    fix,
    action,
    recommended,
    canApply,
}: {
    environmentId: string;
    fix: BlockerFix;
    action: MembershipFixAction;
    recommended: boolean;
    canApply: boolean;
}) => {
    const add = useAddEnvironmentRepository();
    return (
        <li
            className="bg-card-lv1 flex flex-col gap-2 rounded-lg p-3"
            aria-label={fix.label}>
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{fix.label}</span>
                {recommended && (
                    <StatusChip tone="success">Recommended</StatusChip>
                )}
                <StatusChip tone="neutral">
                    {action.kind === "add"
                        ? WHO_LABEL.one_click
                        : IN_KODUS_LABEL}
                </StatusChip>
            </div>
            {fix.detail && (
                <p className="text-text-secondary text-sm">{fix.detail}</p>
            )}
            {action.kind === "connect" ? (
                <Link
                    href={action.href}
                    className="flex w-fit items-center gap-1 text-sm">
                    Connect {action.repository} to Kodus
                    <ArrowRightIcon className="size-3.5" aria-hidden />
                </Link>
            ) : (
                <div className="flex flex-col gap-1.5">
                    <div>
                        <Button
                            size="sm"
                            variant={recommended ? "secondary" : "helper"}
                            leftIcon={<PlusIcon />}
                            loading={add.isPending}
                            disabled={!canApply || add.isSuccess}
                            onClick={() =>
                                add.mutate(
                                    {
                                        environmentId,
                                        repositoryId: action.repositoryId,
                                        ...(action.alias
                                            ? { alias: action.alias }
                                            : {}),
                                    },
                                    {
                                        onSuccess: () =>
                                            toast({
                                                variant: "success",
                                                title: `${action.repository} added`,
                                                description:
                                                    "A new setup started with it. Runs keep the last good setup until it boots.",
                                            }),
                                    },
                                )
                            }>
                            {fix.label}
                        </Button>
                    </div>
                    {!canApply && (
                        <p className="text-text-tertiary text-xs">
                            Only the owner of the organization can add
                            repositories to an environment.
                        </p>
                    )}
                    {add.isError && (
                        <p role="alert" className="text-danger text-xs">
                            {repositoryChangeError(add.error)}
                        </p>
                    )}
                </div>
            )}
        </li>
    );
};

const FixRow = ({
    environmentId,
    signature,
    fix,
    recommended,
    canApply,
}: {
    environmentId: string;
    signature: string;
    fix: BlockerFix;
    recommended: boolean;
    canApply: boolean;
}) => {
    const apply = useApplyBlockerFix();
    const [pr, setPr] = useState<{ number: number; url: string }>();
    // An allow-host fix allows reads only; full access is a second, explained step (egress-allowlist.md §9).
    const [fullAccess, setFullAccess] = useState(false);
    const button = fixButtonLabel(fix);
    const setting = settingsFixLink(fix, environmentId);

    const run = (mode?: "passthrough") =>
        apply.mutate(
            { environmentId, signature, fixId: fix.id, ...(mode ? { mode } : {}) },
            {
                onSuccess: (out) => {
                    if ("pullRequest" in out) setPr(out.pullRequest);
                    toast({ variant: "success", ...appliedMessage(out) });
                },
                onError: (error) =>
                    toast({
                        variant: "danger",
                        title: "Couldn't apply the fix",
                        description: runtimeErrorMessage(error, {
                            fallback: "Try again in a moment.",
                            403: "You need permission to manage this environment.",
                            503: "Kodus could not reach the Git platform. Check the Git integration and try again.",
                        }),
                    }),
            },
        );

    return (
        <li
            className="bg-card-lv1 flex flex-col gap-2 rounded-lg p-3"
            aria-label={fix.label}>
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{fix.label}</span>
                {recommended && (
                    <StatusChip tone="success">Recommended</StatusChip>
                )}
                <StatusChip tone="neutral">
                    {setting ? IN_KODUS_LABEL : WHO_LABEL[fix.who]}
                </StatusChip>
                {fix.learned && (
                    <StatusChip tone="info">
                        {learnedLabel(fix.learned)}
                    </StatusChip>
                )}
            </div>
            {fix.detail && (
                <p className="text-text-secondary text-sm">{fix.detail}</p>
            )}
            {fix.recipeDiff && <DiffBlock diff={fix.recipeDiff} />}
            {setting && (
                <Link
                    href={setting.href}
                    className="flex w-fit items-center gap-1 text-sm">
                    {setting.label}
                    <ArrowRightIcon className="size-3.5" aria-hidden />
                </Link>
            )}
            {pr ? (
                <Link
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-sm">
                    Setup file PR #{pr.number}
                    <ExternalLinkIcon className="size-3.5" />
                </Link>
            ) : (
                button && (
                    <div>
                        {/* The page's next step holds the one amber button: the recommended fix is emphasis without it. */}
                        <Button
                            size="sm"
                            variant={recommended ? "secondary" : "helper"}
                            leftIcon={
                                fix.recipeDiff ? (
                                    <GitPullRequestIcon />
                                ) : (
                                    <PlayIcon />
                                )
                            }
                            loading={apply.isPending}
                            disabled={!canApply}
                            onClick={() => run()}>
                            {button}
                        </Button>
                        {fix.action === "approve_host" && !fix.id.startsWith("approve_full:") && (
                            <ApproveHostSecondStep
                                host={fix.host}
                                open={fullAccess}
                                onOpen={() => setFullAccess(true)}
                                onConfirm={() => run("passthrough")}
                                disabled={!canApply || apply.isPending}
                            />
                        )}
                    </div>
                )
            )}
        </li>
    );
};

/** What one click allows, and full access behind a second step with the risk said plainly. */
export const APPROVE_READS_ONLY_NOTE =
    "One click lets the app's machines only download from this host (GET and HEAD): they cannot upload or publish there. An image build still reaches it uninspected, as it reaches every allowed host.";
export const FULL_ACCESS_RISK =
    "Full access lets the code send anything to this host, an upload or a publish included, and Kodus cannot see what it sends. Use it only for an API the app must call to boot.";

const ApproveHostSecondStep = ({
    host,
    open,
    onOpen,
    onConfirm,
    disabled,
}: {
    host?: string;
    open: boolean;
    onOpen: () => void;
    onConfirm: () => void;
    disabled: boolean;
}) => (
    <div className="mt-2 flex flex-col gap-1.5">
        <p className="text-text-tertiary text-xs">{APPROVE_READS_ONLY_NOTE}</p>
        {open ? (
            <div role="alert" className="flex flex-col gap-1.5">
                <p className="text-warning text-xs">{FULL_ACCESS_RISK}</p>
                <div>
                    <Button size="sm" variant="secondary" disabled={disabled} onClick={onConfirm}>
                        Allow full access to {host ?? "this host"}
                    </Button>
                </div>
            </div>
        ) : (
            <div>
                <Button size="sm" variant="helper" disabled={disabled} onClick={onOpen}>
                    It needs to send data there
                </Button>
            </div>
        )}
    </div>
);

export const BlockerCard = ({
    environmentId,
    group,
    canApply,
    detailsHref,
}: {
    environmentId: string;
    group: BlockerGroup;
    /** The viewer can manage the environment; otherwise the fixes are shown, not applied. */
    canApply: boolean;
    detailsHref?: string;
}) => {
    const fixes = group.fixes ?? [];
    return (
        <article
            aria-label={group.title ?? group.signature}
            className="bg-card-lv2 flex flex-col gap-3 rounded-lg p-4">
            <header className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-text-primary text-sm font-semibold">
                        {group.title ?? group.signature}
                    </h3>
                    <StatusChip tone="warning">
                        {blockerKindLabel(group.kind)}
                    </StatusChip>
                </div>
                <span className="text-text-secondary text-xs">
                    Seen {group.count}×
                    {group.lastPr ? `, last on PR #${group.lastPr}` : ""} ·{" "}
                    <RelativeTime at={group.lastAt} />
                    {detailsHref && (
                        <>
                            {" · "}
                            <Link
                                href={detailsHref}
                                className="text-text-secondary hover:text-primary-light text-xs">
                                Health
                            </Link>
                        </>
                    )}
                </span>
            </header>

            {group.evidence?.lines.length ? (
                <div className="flex flex-col gap-1">
                    <span className="text-text-tertiary text-xs">
                        {group.evidence.service
                            ? `From the ${group.evidence.service} logs`
                            : "What the machine reported"}
                    </span>
                    <pre className="bg-card-lv1 overflow-x-auto rounded-md p-3 font-mono text-xs">
                        {group.evidence.lines.join("\n")}
                    </pre>
                </div>
            ) : null}

            {group.tried?.length ? (
                <div className="flex flex-col gap-1">
                    <span className="text-text-tertiary text-xs">
                        Kody already tried
                    </span>
                    <ol
                        className="text-text-secondary flex list-decimal flex-col gap-0.5 pl-5 text-xs"
                        aria-label="Kody already tried">
                        {group.tried.map((t, i) => (
                            <li key={i}>{t}</li>
                        ))}
                    </ol>
                </div>
            ) : null}

            {fixes.length ? (
                <ol className="flex flex-col gap-2" aria-label="Fixes">
                    {fixes.map((fix, i) => {
                        const membership = membershipFixOf(fix);
                        return membership ? (
                            <MembershipFixRow
                                key={fix.id}
                                environmentId={environmentId}
                                fix={fix}
                                action={membership}
                                recommended={i === 0}
                                canApply={canApply}
                            />
                        ) : (
                            <FixRow
                                key={fix.id}
                                environmentId={environmentId}
                                signature={group.signature}
                                fix={fix}
                                recommended={i === 0}
                                canApply={canApply}
                            />
                        );
                    })}
                </ol>
            ) : (
                <p className="text-text-secondary text-sm">
                    There is nothing to apply: Kody stopped this on purpose.
                </p>
            )}
        </article>
    );
};
