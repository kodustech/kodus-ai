"use client";

import { useEffect, useState } from "react";
import NextLink from "next/link";
import { RuntimeSection, RuntimeSubsection } from "@components/runtime/section";
import { Button } from "@components/ui/button";
import { Label } from "@components/ui/label";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import {
    ENVIRONMENT_SECTION,
    environmentHref,
} from "@services/runtime/model/environment";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import {
    environmentSuiteFacts,
    selectionBanner,
} from "@services/runtime/model/suite";
import {
    useEnvironmentSuite,
    useResumeSuiteSelection,
    useUpdateEnvironmentSettings,
} from "@services/runtime/queries";
import { TriangleAlertIcon } from "lucide-react";

// Settings, e2e suite (docs/runtime/e2e-suites.md section 13). The recipe owns what the command is, the shard ceiling and the gate: they are
// shown here and edited in `.kodus/workspace.yaml`. The environment owns two switches. Selection is the Runtime's state (the shadow check can
// pause it), so "Resume selection" and the selection switch ask the Runtime and this screen reads the answer back.

/** How long the screen waits, reading again, for the Runtime to apply a resume. */
const RESUME_WAIT_MS = 30_000;
const RESUME_POLL_MS = 2_000;

const SelectionPaused = ({
    environmentId,
    canManage,
    title,
    body,
    awaiting,
    onResumed,
}: {
    environmentId: string;
    canManage: boolean;
    title: string;
    body: string;
    awaiting: boolean;
    onResumed: () => void;
}) => {
    const resume = useResumeSuiteSelection();
    return (
        <section
            aria-label="Selection paused"
            className="border-warning/30 bg-warning/10 flex flex-wrap items-start gap-4 rounded-xl border p-5">
            <TriangleAlertIcon
                aria-hidden
                className="text-warning size-5 shrink-0"
            />
            <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1">
                <p className="text-text-primary text-sm font-semibold">
                    {title}
                </p>
                <p className="text-text-secondary text-sm">{body}</p>
            </div>
            {canManage && (
                <Button
                    size="md"
                    variant="secondary"
                    loading={resume.isPending || awaiting}
                    onClick={() =>
                        resume.mutate(environmentId, {
                            onSuccess: () => {
                                onResumed();
                                toast({
                                    variant: "success",
                                    title: "Resuming spec selection",
                                    description:
                                        "The Runtime applies it in a moment; the next pull request is selected again.",
                                });
                            },
                            onError: (error) =>
                                toast({
                                    variant: "danger",
                                    title: "Couldn't resume selection",
                                    description: runtimeErrorMessage(error, {
                                        fallback: "Try again in a moment.",
                                        403: "Only the owner of the organization can change it.",
                                    }),
                                }),
                        })
                    }>
                    Resume selection
                </Button>
            )}
        </section>
    );
};

const Switches = ({
    environmentId,
    selection,
    ci,
    canManage,
}: {
    environmentId: string;
    selection: boolean;
    ci: { enabled: boolean; source: "environment" | "deployment" };
    canManage: boolean;
}) => {
    const [selectionOn, setSelectionOn] = useState(selection);
    const [ciOn, setCiOn] = useState(ci.enabled);
    const update = useUpdateEnvironmentSettings();
    const dirty = selectionOn !== selection || ciOn !== ci.enabled;
    const save = () =>
        update.mutate(
            {
                environmentId,
                ...(selectionOn !== selection
                    ? { suiteSelection: selectionOn }
                    : {}),
                ...(ciOn !== ci.enabled ? { suiteCi: ciOn } : {}),
            },
            {
                onSuccess: () =>
                    toast({
                        variant: "success",
                        title: "e2e suite settings saved",
                        description:
                            "They apply to the next pull request event.",
                    }),
                onError: (error) =>
                    toast({
                        variant: "danger",
                        title: "Couldn't save the e2e suite settings",
                        description: runtimeErrorMessage(error, {
                            fallback: "Try again in a moment.",
                            403: "Only the owner of the organization can change it.",
                        }),
                    }),
            },
        );
    return (
        <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
                event.preventDefault();
                if (dirty) save();
            }}>
            <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-0.5">
                    <Label htmlFor="suite-selection" className="text-sm">
                        Run only the specs the change reaches
                    </Label>
                    <p className="text-text-secondary max-w-xl text-xs">
                        Kody learns from full runs on main which code each spec
                        exercises, and runs only the specs a change can affect.
                        Now and then it runs every spec in the background to
                        check it did not skip one it should have run.
                    </p>
                </div>
                <Switch
                    id="suite-selection"
                    size="sm"
                    checked={selectionOn}
                    onCheckedChange={setSelectionOn}
                    disabled={!canManage || update.isPending}
                />
            </div>
            <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-0.5">
                    <Label htmlFor="suite-ci" className="text-sm">
                        Run on every push, as a CI check
                    </Label>
                    <p className="text-text-secondary max-w-xl text-xs">
                        Publishes &quot;Kody Runtime e2e&quot; on the pull
                        request. Off: the suite runs only inside a Runtime Run.
                        {ci.source === "deployment" &&
                            ` Until you save a choice it follows this deployment's default (${ci.enabled ? "on" : "off"}).`}
                    </p>
                </div>
                <Switch
                    id="suite-ci"
                    size="sm"
                    checked={ciOn}
                    onCheckedChange={setCiOn}
                    disabled={!canManage || update.isPending}
                />
            </div>
            {canManage ? (
                <div className="flex gap-2">
                    <Button
                        type="button"
                        size="md"
                        variant="cancel"
                        disabled={!dirty || update.isPending}
                        onClick={() => {
                            setSelectionOn(selection);
                            setCiOn(ci.enabled);
                        }}>
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        size="md"
                        variant="primary"
                        disabled={!dirty}
                        loading={update.isPending}>
                        Save
                    </Button>
                </div>
            ) : (
                <p className="text-text-tertiary text-xs">
                    Only the owner of the organization can change it.
                </p>
            )}
        </form>
    );
};

export const EnvironmentSuiteSection = ({
    environmentId,
    canManage,
}: {
    environmentId: string;
    canManage: boolean;
}) => {
    const [awaiting, setAwaiting] = useState(false);
    const query = useEnvironmentSuite(
        environmentId,
        awaiting ? RESUME_POLL_MS : false,
    );
    const suite = query.data;
    const braked = !!suite?.selection.brake;

    useEffect(() => {
        if (!awaiting) return;
        if (!braked) return void setAwaiting(false);
        const timer = setTimeout(() => setAwaiting(false), RESUME_WAIT_MS);
        return () => clearTimeout(timer);
    }, [awaiting, braked]);

    // An environment whose recipe declares no suite has nothing to show; a read that failed does not break the page.
    if (!suite?.recipe) return null;
    const banner = selectionBanner(suite.selection);
    const facts = environmentSuiteFacts(suite);
    const runner = facts[0]?.value ?? "e2e";
    return (
        <RuntimeSection
            id="e2e-suite"
            title="e2e suite"
            description={`Kody runs this repository's own ${runner} suite on each pull request and compares the failures with main.`}>
            {banner && (
                <SelectionPaused
                    environmentId={environmentId}
                    canManage={canManage}
                    title={banner.title}
                    body={banner.body}
                    awaiting={awaiting}
                    onResumed={() => setAwaiting(true)}
                />
            )}
            <RuntimeSubsection
                title="From the recipe"
                aside={
                    <NextLink
                        href={environmentHref(
                            environmentId,
                            ENVIRONMENT_SECTION.recipe,
                        )}
                        className="text-primary-light text-sm underline-offset-2 hover:underline">
                        Edit .kodus/workspace.yaml
                    </NextLink>
                }>
                <dl className="grid gap-4 sm:grid-cols-2">
                    {facts.map((f) => (
                        <div key={f.label} className="flex flex-col gap-0.5">
                            <dt className="text-text-tertiary text-xs">
                                {f.label}
                            </dt>
                            <dd
                                className={
                                    f.mono
                                        ? "text-text-primary font-mono text-xs break-words"
                                        : "text-text-primary text-sm"
                                }>
                                {f.value}
                            </dd>
                        </div>
                    ))}
                </dl>
                <p className="text-text-tertiary text-xs">
                    The command, the specs, the results, the number of hosts and
                    the gate for failures that cannot be classified
                    (suite.shards and suite.gate) are the recipe&apos;s: change
                    them in the file.
                </p>
            </RuntimeSubsection>
            <RuntimeSubsection title="How it runs">
                <Switches
                    key={`${suite.selection.enabled}:${suite.ci.enabled}:${suite.ci.source}`}
                    environmentId={environmentId}
                    selection={suite.selection.enabled}
                    ci={suite.ci}
                    canManage={canManage}
                />
            </RuntimeSubsection>
        </RuntimeSection>
    );
};
