"use client";

import { useEffect, useState } from "react";
import { redirect, useRouter } from "next/navigation";
import { SelectRepositories } from "@components/system/select-repositories";
import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
import { Avatar, AvatarImage } from "@components/ui/avatar";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { toast } from "@components/ui/toaster/use-toast";
import { ToggleGroup } from "@components/ui/toggle-group";
import { useAsyncAction } from "@hooks/use-async-action";
import {
    createOrUpdateRepositories,
    deleteIntegration,
} from "@services/codeManagement/fetch";
import { useGetRepositories } from "@services/codeManagement/hooks";
import {
    CODE_MANAGEMENT_API_PATHS,
    type Repository,
} from "@services/codeManagement/types";
import { INTEGRATION_CONFIG } from "@services/integrations/integrationConfig";
import { fastSyncIDERules } from "@services/kodyRules/fetch";
import { updateAutoLicenseAllowedUsers } from "@services/organizationParameters/fetch";
import {
    createOrUpdateCodeReviewParameter,
    getParameterByKey,
    updateCodeReviewParameterRepositories,
} from "@services/parameters/fetch";
import { useSuspenseGetCodeReviewParameter } from "@services/parameters/hooks";
import { ParametersConfigKey } from "@services/parameters/types";
import { SETUP_PATHS } from "@services/setup";
import { useSuspenseGetConnections } from "@services/setup/hooks";
import { useQueryClient } from "@tanstack/react-query";
import {
    AlertTriangle,
    FolderX,
    HatGlasses,
    InfoIcon,
    KeyRound,
    PowerIcon,
    Sparkles,
} from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { IntegrationCategory } from "src/core/types";
import { generateQueryKey } from "src/core/utils/reactQuery";
import { safeArray } from "src/core/utils/safe-array";
import { pluralize } from "src/core/utils/string";
import {
    TRIAL_DAYS,
    TRIAL_MANAGED_REVIEW_CREDITS_INCLUDED,
} from "src/features/ee/subscription/_constants/trial";

import { StepIndicators } from "../_components/step-indicators";

type ReviewScope = "pilot" | "team";

export default function App() {
    const router = useRouter();
    const { userId, organizationId } = useAuth();
    const { teamId } = useSelectedTeamId();
    const nextStepPath = "/setup/review-mode";

    const { configValue } = useSuspenseGetCodeReviewParameter(teamId);
    if (configValue?.repositories?.length) redirect(nextStepPath);

    const [open, setOpen] = useState(false);
    const [selectedRepositories, setSelectedRepositories] = useState<
        Repository[]
    >([]);
    const [reviewScope, setReviewScope] = useState<ReviewScope>("team");

    const queryClient = useQueryClient();
    const [isInitialLoad, setIsInitialLoad] = useState(true);
    const {
        data: repositories = [],
        isLoading: isLoadingRepositories,
        isFetching,
    } = useGetRepositories(teamId);

    useEffect(() => {
        queryClient
            .invalidateQueries({
                queryKey: [CODE_MANAGEMENT_API_PATHS.GET_REPOSITORIES_ORG],
            })
            .then(() => setIsInitialLoad(false));
    }, []);

    const isLoading = isInitialLoad || isLoadingRepositories || isFetching;
    const safeRepositories = safeArray<Repository>(repositories);
    const hasRepositories = isLoading ? null : safeRepositories.length > 0;

    const connections = useSuspenseGetConnections(teamId);

    const codeManagementConnections = safeArray(connections).filter(
        (c) => c.category === "CODE_MANAGEMENT" && c.hasConnection,
    );

    const [
        saveSelectedRepositoriesAction,
        { loading: loadingSaveRepositories },
    ] = useAsyncAction(async () => {
        try {
            const reposToSave = selectedRepositories.map((repo) => ({
                ...repo,
                selected: true,
            }));

            await createOrUpdateRepositories(reposToSave, teamId);

            // Manual cache update to avoid a redundant fetch in the next screen
            const updatedRepositories = safeRepositories.map((repo) => ({
                ...repo,
                selected: selectedRepositories.some((s) => s.id === repo.id),
            }));

            queryClient.setQueryData(
                generateQueryKey(
                    CODE_MANAGEMENT_API_PATHS.GET_REPOSITORIES_ORG,
                    { params: { teamId, organizationSelected: undefined } },
                ),
                updatedRepositories,
            );

            const codeReview: {
                configKey: string;
                configValue: any;
            } = await getParameterByKey(
                ParametersConfigKey.CODE_REVIEW_CONFIG,
                teamId,
            );

            if (!codeReview.configValue) {
                await createOrUpdateCodeReviewParameter({}, teamId, undefined);
            }

            await updateCodeReviewParameterRepositories(teamId);

            if (reviewScope === "pilot" && teamId) {
                await updateAutoLicenseAllowedUsers({
                    organizationId,
                    teamId,
                    includeCurrentUser: true,
                });
            }

            if (teamId) {
                const fastSyncPromises = selectedRepositories.map((repo) =>
                    fastSyncIDERules({ teamId, repositoryId: repo.id }).catch(
                        (error) => {
                            console.error(
                                "Error fast syncing IDE rules for repo",
                                repo.id,
                                error,
                            );
                        },
                    ),
                );

                void Promise.allSettled(fastSyncPromises);
            }

            router.replace(nextStepPath);
        } catch (error) {
            console.error(error);
            toast({
                variant: "danger",
                title: "Error saving repositories",
                description:
                    "There was a problem saving your selection. Please try again.",
            });
        }
    });

    const [updateConnectionAction, { loading: loadingUpdateConnection }] =
        useAsyncAction(async () => {
            try {
                await deleteIntegration(teamId);

                await Promise.all([
                    queryClient.invalidateQueries({
                        queryKey: generateQueryKey(SETUP_PATHS.CONNECTIONS, {
                            params: { teamId },
                        }),
                    }),
                    queryClient.invalidateQueries({
                        queryKey: generateQueryKey(
                            INTEGRATION_CONFIG.GET_INTEGRATION_CONFIG_BY_CATEGORY,
                            {
                                params: {
                                    teamId,
                                    integrationCategory:
                                        IntegrationCategory.CODE_MANAGEMENT,
                                },
                            },
                        ),
                    }),
                    queryClient.invalidateQueries({
                        queryKey: [
                            CODE_MANAGEMENT_API_PATHS.GET_REPOSITORIES_ORG,
                        ],
                    }),
                ]);

                router.push("/setup/connecting-git-tool");
            } catch (error) {
                console.error(error);
                toast({
                    variant: "danger",
                    title: "Could not reset the connection",
                    description: "Please try again in a moment.",
                });
            }
        });

    const selectedCount = selectedRepositories.length;
    const repoLabel = pluralize(selectedCount || 1, {
        singular: "repo",
        plural: "repos",
    });
    const ctaLabel =
        selectedCount > 0
            ? reviewScope === "pilot"
                ? `Enable on my PRs (${selectedCount} ${repoLabel})`
                : `Enable for team (${selectedCount} ${repoLabel})`
            : "Select at least one repo";
    const scopeCopy =
        reviewScope === "pilot"
            ? "Kody reviews only PRs opened by you. No impact on the team yet."
            : "Kody reviews every new PR in these repos.";
    const staleRepositories = selectedRepositories.filter((repo) => {
        if (!repo.lastActivityAt) return true;
        const last = Date.parse(repo.lastActivityAt);
        if (Number.isNaN(last)) return true;
        const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
        return Date.now() - last > fourteenDaysMs;
    });

    return (
        <Page.Root className="mx-auto flex min-h-full w-full flex-row p-6">
            <div className="bg-card-lv1 flex flex-10 flex-col justify-center gap-10 rounded-3xl p-12">
                <div className="text-text-secondary flex flex-1 flex-col justify-center gap-8 text-[15px]">
                    <div className="flex flex-col gap-4">
                        <svg
                            width="34"
                            height="30"
                            viewBox="0 0 34 30"
                            fill="none"
                            xmlns="http://www.w3.org/2000/svg">
                            <path
                                fill="#6A57A4"
                                fillOpacity="0.2"
                                d="M23.2503 29.5833C22.1453 29.5833 21.0855 29.1443 20.3041 28.3629C19.5226 27.5815 19.0837 26.5217 19.0837 25.4166V12.9166C19.0837 6.39575 22.5212 2.09784 28.9941 0.479084C29.2602 0.410395 29.5373 0.395037 29.8093 0.433901C30.0814 0.472763 30.3431 0.565081 30.5794 0.705526C30.8156 0.845974 31.0217 1.03178 31.1859 1.25223C31.35 1.47269 31.4689 1.72344 31.5356 1.99004C31.6024 2.25664 31.6158 2.53382 31.575 2.80561C31.5342 3.07741 31.44 3.33844 31.2979 3.57368C31.1558 3.80891 30.9685 4.0137 30.7469 4.17624C30.5252 4.33879 30.2736 4.45587 30.0066 4.52075C25.367 5.68117 23.2503 8.327 23.2503 12.9166V14.9999H29.5003C30.5515 14.9996 31.564 15.3966 32.3348 16.1114C33.1056 16.8261 33.5777 17.8058 33.6566 18.8541L33.667 19.1666V25.4166C33.667 26.5217 33.228 27.5815 32.4466 28.3629C31.6652 29.1443 30.6054 29.5833 29.5003 29.5833H23.2503ZM4.50033 29.5833C3.39526 29.5833 2.33545 29.1443 1.55405 28.3629C0.772652 27.5815 0.333664 26.5217 0.333664 25.4166V12.9166C0.333664 6.39575 3.77116 2.09784 10.2441 0.479084C10.5102 0.410395 10.7873 0.395037 11.0594 0.433901C11.3314 0.472763 11.5931 0.565081 11.8294 0.705526C12.0656 0.845974 12.2717 1.03178 12.4359 1.25223C12.6 1.47269 12.7189 1.72344 12.7856 1.99004C12.8524 2.25664 12.8658 2.53382 12.825 2.80561C12.7842 3.07741 12.69 3.33844 12.5479 3.57368C12.4058 3.80891 12.2185 4.0137 11.9969 4.17624C11.7752 4.33879 11.5236 4.45587 11.2566 4.52075C6.617 5.68117 4.50033 8.327 4.50033 12.9166V14.9999H10.7503C11.8015 14.9996 12.814 15.3966 13.5848 16.1114C14.3556 16.8261 14.8277 17.8058 14.9066 18.8541L14.917 19.1666V25.4166C14.917 26.5217 14.478 27.5815 13.6966 28.3629C12.9152 29.1443 11.8554 29.5833 10.7503 29.5833H4.50033Z"
                            />
                        </svg>

                        <p>
                            Kodus has had a huge impact on our workflow by
                            saving us valuable time during PR reviews. It
                            consistently catches the small details that are easy
                            to miss, and the ability to set up custom rules
                            means we can align automated reviews with our own
                            standards.
                        </p>
                        <p className="text-success">
                            This has helped us maintain higher quality while
                            reducing the manual burden on the team.
                        </p>
                    </div>

                    <div className="flex flex-row gap-4">
                        <Avatar>
                            <AvatarImage src="https://t5y4w6q9.rocketcdn.me/wp-content/uploads/2025/04/Jonathan-Georgeu-1-1.jpeg" />
                        </Avatar>

                        <div>
                            <strong>Jonathan Georgeu</strong>
                            <p>Origen</p>
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex flex-14 flex-col items-center justify-center gap-10 p-10">
                <div className="flex w-150 flex-1 flex-col justify-center gap-10">
                    <StepIndicators.Auto />

                    {hasRepositories === null ? (
                        <div className="flex flex-1 flex-col items-center justify-center gap-4">
                            <div className="border-primary-light size-8 animate-spin rounded-full border-2 border-t-transparent" />
                            <p className="text-text-secondary text-sm">
                                Loading repositories...
                            </p>
                        </div>
                    ) : hasRepositories === false ? (
                        <>
                            <div className="flex flex-col items-center gap-4 text-center">
                                <div className="bg-card-lv2 rounded-full p-4">
                                    <FolderX className="text-text-secondary size-8" />
                                </div>
                                <Heading variant="h2">
                                    No repositories found
                                </Heading>
                                <p className="text-text-secondary max-w-md text-sm">
                                    We couldn't find any repositories in your
                                    connected account. This might happen if the
                                    account has no repos or the token doesn't
                                    have the right permissions.
                                </p>
                            </div>

                            <div className="flex flex-col gap-3">
                                <Button
                                    size="lg"
                                    variant="primary"
                                    className="w-full"
                                    rightIcon={<KeyRound />}
                                    loading={loadingUpdateConnection}
                                    onClick={updateConnectionAction}>
                                    Update connection
                                </Button>
                                <p className="text-text-tertiary text-center text-xs">
                                    You can reconnect with a different account
                                    or update your token permissions.
                                </p>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="flex flex-col gap-2">
                                <Heading variant="h2">
                                    You're one click away from smarter reviews
                                </Heading>

                                <p className="text-text-secondary text-sm">
                                    Select a few active repos to see results
                                    today. You can add more later.
                                </p>
                            </div>

                            <div className="flex flex-col gap-4">
                                <Alert variant="info">
                                    <InfoIcon />
                                    <AlertTitle>
                                        Your first{" "}
                                        {TRIAL_MANAGED_REVIEW_CREDITS_INCLUDED}{" "}
                                        PR reviews are on us
                                    </AlertTitle>
                                    <AlertDescription>
                                        <p>
                                            During your {TRIAL_DAYS}-day trial
                                            we cover your first{" "}
                                            {
                                                TRIAL_MANAGED_REVIEW_CREDITS_INCLUDED
                                            }{" "}
                                            PR reviews — no AI key needed. After
                                            that, connect your AI key for
                                            unlimited reviews (free, on any
                                            plan).
                                        </p>
                                    </AlertDescription>
                                </Alert>

                                <FormControl.Root>
                                    <FormControl.Label htmlFor="select-repositories">
                                        Select repositories
                                    </FormControl.Label>

                                    <FormControl.Input>
                                        <SelectRepositories
                                            open={open}
                                            onOpenChange={setOpen}
                                            selectedRepositories={
                                                selectedRepositories
                                            }
                                            onChangeSelectedRepositories={
                                                setSelectedRepositories
                                            }
                                            teamId={teamId}
                                        />
                                        <small className="text-text-secondary mt-2 text-xs">
                                            Recommended: repos with recent PR
                                            activity
                                        </small>

                                        {selectedRepositories.length > 0 &&
                                            staleRepositories.length ===
                                                selectedRepositories.length && (
                                                <Alert
                                                    variant="alert"
                                                    className="border-alert/30 bg-alert/10 mt-3">
                                                    <AlertTriangle className="text-alert size-3" />
                                                    <AlertTitle className="text-alert text-sm">
                                                        Low recent activity{" "}
                                                    </AlertTitle>
                                                    <AlertDescription className="text-text-secondary text-xs">
                                                        {`Selected repos had no PRs in the last 14 days: ${staleRepositories
                                                            .map(
                                                                (r) =>
                                                                    `${r.organizationName}/${r.name}`,
                                                            )
                                                            .join(", ")}`}
                                                    </AlertDescription>
                                                </Alert>
                                            )}
                                    </FormControl.Input>
                                </FormControl.Root>

                                <div className="flex flex-col gap-2">
                                    <FormControl.Label>
                                        Who should Kody review?
                                    </FormControl.Label>
                                    <ToggleGroup.Root
                                        type="single"
                                        value={reviewScope}
                                        onValueChange={(value) => {
                                            if (value)
                                                setReviewScope(
                                                    value as ReviewScope,
                                                );
                                        }}
                                        className="border-border-subtle bg-card-lv2/70 grid grid-cols-2 gap-2 rounded-xl border p-1">
                                        <ToggleGroup.ToggleGroupItem
                                            asChild
                                            value="pilot">
                                            <Button
                                                variant={
                                                    reviewScope === "pilot"
                                                        ? "primary-dark"
                                                        : "helper"
                                                }
                                                size="md"
                                                className={`w-full justify-center gap-2 rounded-lg border transition-all`}>
                                                <HatGlasses
                                                    className={`size-4`}
                                                />
                                                <span>PRs opened by me</span>
                                            </Button>
                                        </ToggleGroup.ToggleGroupItem>

                                        <ToggleGroup.ToggleGroupItem
                                            asChild
                                            value="team">
                                            <Button
                                                variant={
                                                    reviewScope === "team"
                                                        ? "primary-dark"
                                                        : "helper"
                                                }
                                                size="md"
                                                className={`w-full justify-center gap-3 rounded-lg border transition-all`}>
                                                <Sparkles
                                                    className={`size-4`}
                                                />
                                                All PRs in selected repos
                                            </Button>
                                        </ToggleGroup.ToggleGroupItem>
                                    </ToggleGroup.Root>

                                    <p className="text-text-secondary text-xs">
                                        {scopeCopy}
                                    </p>
                                </div>

                                <Button
                                    size="lg"
                                    variant="primary"
                                    className="mt-5 w-full"
                                    rightIcon={<PowerIcon />}
                                    loading={loadingSaveRepositories}
                                    onClick={saveSelectedRepositoriesAction}
                                    disabled={
                                        selectedRepositories.length === 0
                                    }>
                                    {ctaLabel}
                                </Button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </Page.Root>
    );
}
