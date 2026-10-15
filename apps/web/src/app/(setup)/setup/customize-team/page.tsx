"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import { KODY_RULES_PATHS } from "@services/kodyRules";
import type { AgentInstructionFilesByRepository } from "@services/kodyRules/fetch";
import { KodyRulesStatus, type KodyRule } from "@services/kodyRules/types";
import { createOrUpdateCodeReviewParameter } from "@services/parameters/fetch";
import { useSuspenseGetCodeReviewParameter } from "@services/parameters/hooks";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { cn } from "src/core/utils/components";
import { isAgentInstructionSource } from "src/core/utils/kody-rules/infer-origin";
import { useFetch } from "src/core/utils/reactQuery";
import { safeArray } from "src/core/utils/safe-array";

import { StepIndicators } from "../_components/step-indicators";

const NEXT_STEP = "/setup/choosing-a-pull-request";

// Rule files are imported in the background when repositories are selected,
// so the list may still be filling in when this step opens.
const IMPORT_POLL_MS = 5000;
const IMPORT_POLL_WINDOW_MS = 15000;

export default function CustomizeTeamPage() {
    const router = useRouter();
    const { teamId } = useSelectedTeamId();
    const { configValue } = useSuspenseGetCodeReviewParameter(teamId);
    const storedAgentInstructions =
        configValue?.configs?.ideRulesSyncEnabled === true;
    const [useAgentInstructions, setUseAgentInstructions] = useState(
        storedAgentInstructions,
    );
    const [isSaving, setIsSaving] = useState(false);
    const [importWindowOver, setImportWindowOver] = useState(false);

    useEffect(() => {
        const timeout = setTimeout(
            () => setImportWindowOver(true),
            IMPORT_POLL_WINDOW_MS,
        );
        return () => clearTimeout(timeout);
    }, []);

    const selectedRepositories = useMemo(
        () =>
            new Map(
                (configValue?.repositories || [])
                    .filter((repo) => repo.isSelected !== false)
                    .map((repo) => [String(repo.id), repo.name]),
            ),
        [configValue?.repositories],
    );

    const { data: syncedRules } = useFetch<Array<KodyRule>>(
        KODY_RULES_PATHS.FIND_BY_ORGANIZATION_ID_AND_FILTER,
        { params: { key: "origin", value: "repo_file_sync" } },
        !!teamId,
        {
            refetchInterval: importWindowOver ? false : IMPORT_POLL_MS,
            staleTime: 0,
        },
    );

    // Only the rules imported from this team's selected repositories, and
    // only from Kody rule files.
    const importedRules = useMemo(
        () =>
            safeArray<KodyRule>(syncedRules).filter(
                (rule) =>
                    !!rule.repositoryId &&
                    selectedRepositories.has(String(rule.repositoryId)) &&
                    !isAgentInstructionSource(rule.sourcePath),
            ),
        [syncedRules, selectedRepositories],
    );

    const { data: agentFiles, isLoading: isLoadingAgentFiles } = useFetch<
        AgentInstructionFilesByRepository[]
    >(
        KODY_RULES_PATHS.AGENT_INSTRUCTION_FILES,
        { params: { teamId } },
        !!teamId,
    );

    const repositoriesWithAgentFiles =
        safeArray<AgentInstructionFilesByRepository>(agentFiles).filter(
            (repo) => repo.files.length > 0,
        );

    const highlightItems = [
        { label: "Bugs" },
        { label: "Security" },
        { label: "Performance" },
        ...(importedRules.length > 0
            ? [
                  {
                      label: "Team rules",
                      helper:
                          importedRules.length === 1
                              ? "1 rule from .kody/rules"
                              : `${importedRules.length} rules from .kody/rules`,
                  },
              ]
            : []),
        ...(useAgentInstructions
            ? [
                  {
                      label: "Coding-agent instructions",
                      helper: "read during review",
                  },
              ]
            : []),
    ];

    const goNext = () => router.push(NEXT_STEP);

    const handleContinue = async () => {
        // Saving an untouched switch would pin the default as a team choice.
        if (!teamId || useAgentInstructions === storedAgentInstructions) {
            goNext();
            return;
        }
        try {
            setIsSaving(true);
            // Saved once at global level: every repository follows it unless
            // it sets its own value later in Settings.
            const result = await createOrUpdateCodeReviewParameter(
                { ideRulesSyncEnabled: useAgentInstructions },
                teamId,
                "global",
            );
            if (result?.error) {
                toast({
                    variant: "warning",
                    description:
                        "We couldn't save this choice. You can change it later in Settings.",
                });
            }
            goNext();
        } catch (error) {
            console.error(
                "Error saving coding-agent instructions choice",
                error,
            );
            toast({
                variant: "danger",
                description: "We couldn't save your choice. Please try again.",
            });
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <Page.Root className="mx-auto flex min-h-full w-full flex-col gap-6 p-6 lg:flex-row lg:gap-6">
            <div className="bg-card-lv1 flex w-full flex-col justify-center gap-10 rounded-3xl p-8 lg:max-w-none lg:flex-10 lg:p-12">
                <div className="flex-1 overflow-hidden">
                    <h1 className="text-2xl font-bold">
                        Teach Kody how your team builds software
                    </h1>
                    <p className="text-text-secondary mt-2 text-base">
                        By default, Kody checks bugs, security, and performance.
                        Rules your team wrote for Kody, and the instructions it
                        wrote for coding agents, can add your standards to every
                        review.
                    </p>
                    <div className="mt-5 flex flex-col gap-2">
                        {highlightItems.map((item) => (
                            <div
                                key={item.label}
                                className={cn(
                                    "bg-card-lv2 border-border flex items-center justify-between gap-2 rounded-xl border p-3 text-sm transition-all duration-300",
                                    item.helper &&
                                        "border-primary-light/80 bg-primary-light/5 ring-primary-light/30 ring-1",
                                )}>
                                <div className="flex items-center gap-2">
                                    <span className="font-semibold">
                                        {item.label}
                                    </span>
                                    {item.helper ? (
                                        <span className="text-primary-light text-xs font-semibold">
                                            {item.helper}
                                        </span>
                                    ) : null}
                                </div>
                                <Checkbox
                                    checked={true}
                                    variant={"primary-dark"}
                                />
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            <div className="flex w-full flex-col gap-10 lg:flex-14 lg:p-10">
                <div className="flex flex-1 flex-col gap-8">
                    <StepIndicators.Auto />

                    <div className="flex flex-col gap-3">
                        <Heading variant="h2">
                            Rules from your repositories
                        </Heading>
                        <span className="text-text-secondary text-sm">
                            Kody Rule files in{" "}
                            <code className="text-xs">.kody/rules</code> are
                            imported as written and kept in sync. Nothing else
                            in your repositories becomes a rule.
                        </span>

                        {importedRules.length === 0 ? (
                            <div className="bg-card-lv1 border-card-lv3 text-text-secondary flex items-center gap-2 rounded-xl border p-4 text-sm">
                                {!importWindowOver && <Spinner />}
                                <span>
                                    {importWindowOver
                                        ? "No Kody Rule files found. You can add them any time; Kody keeps them in sync."
                                        : "Looking for Kody Rule files in your repositories…"}
                                </span>
                            </div>
                        ) : (
                            <ul className="bg-card-lv1 border-card-lv3 flex max-h-[30vh] flex-col gap-2 overflow-y-auto rounded-xl border p-4 text-sm">
                                {importedRules.map((rule) => (
                                    <li
                                        key={rule.uuid ?? rule.title}
                                        className="flex items-center justify-between gap-3">
                                        <span className="font-medium">
                                            {rule.title}
                                        </span>
                                        <span className="text-text-secondary shrink-0 text-xs">
                                            {selectedRepositories.get(
                                                String(rule.repositoryId),
                                            )}
                                            {rule.status ===
                                                KodyRulesStatus.PENDING &&
                                                " · awaiting approval"}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    <div className="flex flex-col gap-3">
                        <label className="bg-card-lv1 flex cursor-pointer items-center justify-between gap-6 rounded-xl p-5">
                            <div className="flex flex-col gap-1">
                                <Heading variant="h2">
                                    Use your coding-agent instructions in
                                    reviews?
                                </Heading>
                                <span className="text-text-secondary text-sm">
                                    Kody reads the CLAUDE.md, AGENTS.md,
                                    .cursor/rules and Copilot instructions that
                                    cover the changed files, and points out
                                    changes that break them. They never become
                                    rules. Off unless you turn it on.
                                </span>
                            </div>
                            <Switch
                                checked={useAgentInstructions}
                                onCheckedChange={setUseAgentInstructions}
                            />
                        </label>

                        <div className="text-text-secondary flex flex-col gap-1 px-1 text-xs">
                            {isLoadingAgentFiles ? (
                                <span className="flex items-center gap-2">
                                    <Spinner className="size-3" />
                                    Looking for coding-agent files…
                                </span>
                            ) : repositoriesWithAgentFiles.length === 0 ? (
                                <span>
                                    No coding-agent files found in the selected
                                    repositories.
                                </span>
                            ) : (
                                <>
                                    <span>Files Kody would read:</span>
                                    {repositoriesWithAgentFiles.map((repo) => (
                                        <span key={repo.repositoryId}>
                                            <span className="text-text-primary font-medium">
                                                {repo.repositoryName}
                                            </span>
                                            : {repo.files.join(", ")}
                                        </span>
                                    ))}
                                </>
                            )}
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        <Button
                            size="lg"
                            variant="cancel"
                            className="flex-1"
                            onClick={goNext}
                            disabled={isSaving}>
                            Skip for now
                        </Button>
                        <Button
                            size="lg"
                            variant="primary"
                            className="flex-1"
                            onClick={handleContinue}
                            loading={isSaving}
                            disabled={isSaving}>
                            Continue
                        </Button>
                    </div>
                </div>
            </div>
        </Page.Root>
    );
}
