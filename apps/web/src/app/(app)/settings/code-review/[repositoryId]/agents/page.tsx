"use client";

import { Suspense } from "react";
import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { BookOpenIcon } from "lucide-react";
import { useUnsavedChangesGuard } from "src/core/hooks/use-unsaved-changes-guard";

import {
    CustomAgentsList,
    NewAgentButton,
} from "../_custom-agents/custom-agents-section";
import {
    skillsPageHref,
    useCustomAgentsForm,
} from "../_custom-agents/use-custom-agents-form";
import { CentralizedConfigReadOnlyAlert } from "../../_components/centralized-config-readonly-alert";
import { customAgentsSaveErrorMessage } from "../../_utils/settings-save-conflict";
import { useFeatureFlags } from "../../../_components/context";

function AgentsContent() {
    const enabled = useFeatureFlags().customAgents === true;
    const {
        repositoryId,
        directoryId,
        agents,
        isDirty,
        isSubmitting,
        save,
        reset,
    } = useCustomAgentsForm();
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );

    // A toggle or delete saves right away; only a failed save leaves the
    // list unsaved, and then it must not be left silently.
    useUnsavedChangesGuard({
        id: "custom-agents-list",
        isDirty: isDirty || isSubmitting,
        onBlock: () => {
            document
                .querySelector("[data-header-actions]")
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
        },
    });

    const retry = async () => {
        try {
            await save();
            toast({ description: "Agents saved", variant: "success" });
        } catch (error) {
            toast({
                title: "Error",
                description: customAgentsSaveErrorMessage(
                    error,
                    "Couldn't save the agents. Try again.",
                    agents,
                ),
                variant: "danger",
            });
        }
    };

    if (!enabled) {
        return (
            <Page.Root>
                <Page.Content>
                    <p className="text-text-secondary text-sm">
                        Custom agents are in beta and not enabled for this
                        organization.
                    </p>
                </Page.Content>
            </Page.Root>
        );
    }

    return (
        <Page.Root>
            <Page.Header>
                <Page.TitleContainer>
                    <Page.Title>Custom agents</Page.Title>
                    <Page.Description>
                        Reviewers your team defines, each with its own
                        instructions, files and tools. They run next to Kody on
                        the pull requests their files match.
                    </Page.Description>
                </Page.TitleContainer>

                <Page.HeaderActions className="justify-end">
                    {isDirty && (
                        <Page.SaveActions
                            isDirty={isDirty}
                            isSaving={isSubmitting}
                            canSave={canEdit}
                            onReset={reset}
                            onSave={retry}
                        />
                    )}
                    <Link href={skillsPageHref(repositoryId, directoryId)}>
                        <Button
                            size="sm"
                            variant="helper"
                            decorative
                            leftIcon={<BookOpenIcon />}>
                            Skills &amp; docs
                        </Button>
                    </Link>
                    <NewAgentButton canEdit={canEdit} />
                </Page.HeaderActions>
            </Page.Header>

            <Page.Content className="gap-6">
                <CentralizedConfigReadOnlyAlert />
                <CustomAgentsList canEdit={canEdit} />
            </Page.Content>
        </Page.Root>
    );
}

export default function CustomAgentsPage() {
    return (
        <Suspense
            fallback={
                <div className="flex h-full w-full items-center justify-center py-10">
                    <Spinner className="size-6" />
                </div>
            }>
            <AgentsContent />
        </Suspense>
    );
}
