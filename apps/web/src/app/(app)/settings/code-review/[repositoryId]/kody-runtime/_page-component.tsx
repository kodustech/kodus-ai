"use client";

import { useState } from "react";
import { RuntimeErrorState } from "@components/runtime/empty-state";
import { SimulateOnPastPrs } from "@components/runtime/simulate-on-past-prs";
import { Card } from "@components/ui/card";
import { Page } from "@components/ui/page";
import { Skeleton } from "@components/ui/skeleton";
import { toast } from "@components/ui/toaster/use-toast";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type { RuntimeRepositorySettings } from "@services/runtime/contracts";
import {
    membershipsByRepository,
    ownModeNote,
} from "@services/runtime/model/environment-repositories";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import {
    draftOf,
    sameDraft,
    toPayload,
    type RuntimeDraft,
} from "@services/runtime/model/rules";
import {
    useRuntimeEnvironments,
    useRuntimeRuns,
    useRuntimeSettings,
    useUpdateRuntimeRepositorySettings,
} from "@services/runtime/queries";

import { useCodeReviewRouteParams } from "../../../_hooks";
import {
    RuntimeHowItWorks,
    RuntimeStatusStrip,
    WhatKodyChecks,
} from "./_components/runtime-cards";
import { WhenItRuns } from "./_components/when-it-runs";

/**
 * Screen 2: Kody Runtime in the repository settings. When it runs (Off, On
 * request, Rules), what it checks, how it works and Simulate. The settings live in the Runtime API (`/runtime/settings`),
 * not in the code-review config; `mode` is the one switch written.
 */
const RepositoryRuntimeSettingsForm = ({
    repositoryId,
    saved,
}: {
    repositoryId: string;
    saved?: RuntimeRepositorySettings;
}) => {
    const initial = draftOf(saved);
    const [draft, setDraft] = useState<RuntimeDraft>(initial);
    const update = useUpdateRuntimeRepositorySettings();
    // GET /runtime/environments has no repository filter yet: the list is
    // the org's, and this page picks its own row.
    const environments = useRuntimeEnvironments();
    const runs = useRuntimeRuns({ repositoryId });
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );
    const environment = environments.data?.find(
        (e) => e.repositoryId === repositoryId,
    );
    // A member of another environment: its PRs run there by that environment's settings; the mode here is for its own.
    const note = ownModeNote(
        membershipsByRepository(environments.data ?? []).get(repositoryId),
    );
    const payload = toPayload(draft);
    const dirty = !sameDraft(draft, initial);
    const repositoryName = saved?.repositoryName ?? environment?.repositoryName;

    const save = () => {
        if (!payload.ok) {
            toast({ variant: "warning", title: payload.error });
            return;
        }
        update.mutate(
            { repositoryId, ...payload.body },
            {
                onSuccess: () =>
                    toast({
                        variant: "success",
                        description:
                            draft.mode !== "off" && !environment
                                ? note
                                    ? "Saved. Kody is setting up an environment of its own for this repository."
                                    : "Saved. Kody is setting up the environment for this repository."
                                : "Settings saved",
                    }),
                onError: (error) =>
                    toast({
                        variant: "danger",
                        title: "Couldn't save the Runtime settings",
                        description: runtimeErrorMessage(error, {
                            fallback: "Try again in a moment.",
                        }),
                    }),
            },
        );
    };

    return (
        <Page.Root>
            <Page.Header sticky>
                <Page.TitleContainer>
                    <Page.Title>Runtime</Page.Title>
                    <Page.Description>
                        Kody boots this app on a throwaway machine, runs the
                        pull request against it and posts what broke, with the
                        command and the output.
                    </Page.Description>
                </Page.TitleContainer>
                <Page.SaveActions
                    isDirty={dirty}
                    isSaving={update.isPending}
                    canSave={canEdit && payload.ok}
                    onReset={() => setDraft(initial)}
                    onSave={save}
                />
            </Page.Header>

            <Page.Content className="gap-6">
                <RuntimeStatusStrip
                    mode={initial.mode}
                    environment={environment}
                    environmentsError={environments.isError}
                    runs={runs.data}
                    isLoading={environments.isLoading}
                />
                <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] lg:items-start">
                    <div className="flex flex-col gap-8">
                        {note ? (
                            <p
                                role="note"
                                className="text-text-secondary border-card-lv3 rounded-xl border px-4 py-3 text-sm">
                                {note}
                            </p>
                        ) : null}
                        <WhenItRuns
                            draft={draft}
                            onChange={setDraft}
                            canEdit={canEdit}
                        />
                        <WhatKodyChecks />
                    </div>
                    <aside className="flex flex-col gap-4 lg:sticky lg:top-24">
                        <RuntimeHowItWorks
                            mode={draft.mode}
                            rulesCount={draft.rules.length}
                            environment={environment}
                        />
                        <Card
                            id="simulate"
                            color="lv1"
                            className="flex scroll-mt-24 flex-col gap-3 px-5 py-4">
                            <span className="flex flex-col">
                                <span className="text-text-primary text-sm font-medium">
                                    Simulate on past PRs
                                </span>
                                <span className="text-text-secondary text-xs">
                                    Runs on past pull requests. Nothing is
                                    posted.
                                </span>
                            </span>
                            <SimulateOnPastPrs
                                environmentId={environment?.environmentId}
                                repositoryName={repositoryName}
                                canEdit={canEdit}
                            />
                        </Card>
                    </aside>
                </div>
            </Page.Content>
        </Page.Root>
    );
};

export const KodyRuntimeRepositoryPage = () => {
    const { repositoryId } = useCodeReviewRouteParams();
    const settings = useRuntimeSettings();

    if (repositoryId === "global") {
        return (
            <Page.Root>
                <Page.Content>
                    <p className="text-text-secondary text-sm">
                        Kody Runtime is set per repository. Pick a repository in
                        the scope selector.
                    </p>
                </Page.Content>
            </Page.Root>
        );
    }
    if (settings.isLoading) {
        return (
            <Page.Root>
                <Page.Content className="gap-6">
                    <Skeleton className="h-12 w-full rounded-xl" />
                    <Skeleton className="h-64 w-full rounded-xl" />
                </Page.Content>
            </Page.Root>
        );
    }
    // A failed load never shows the defaults: they would read as saved, and
    // Save would overwrite the real settings.
    if (settings.isError || !settings.data) {
        return (
            <Page.Root>
                <Page.Content>
                    <RuntimeErrorState
                        what="the Runtime settings"
                        error={settings.error}
                        onRetry={() => settings.refetch()}
                    />
                </Page.Content>
            </Page.Root>
        );
    }
    const saved = settings.data.repositories.find(
        (r) => r.repositoryId === repositoryId,
    );
    // Remounted when the saved settings change, so the draft starts from them.
    return (
        <RepositoryRuntimeSettingsForm
            key={JSON.stringify(saved ?? null)}
            repositoryId={repositoryId}
            saved={saved}
        />
    );
};
