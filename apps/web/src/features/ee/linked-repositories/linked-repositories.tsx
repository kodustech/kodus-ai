"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { useGetSelectedRepositories } from "@services/codeManagement/hooks";
import {
    ChevronDown,
    ChevronRight,
    GitBranchIcon,
    Link2Icon,
    LockIcon,
    Plus,
    X,
} from "lucide-react";
import { Controller, useFormContext } from "react-hook-form";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "src/core/components/ui/command";
import { GateCtaLink } from "src/core/components/system/gate-cta-link";
import { cn } from "src/core/utils/components";
import { captureGateHit } from "src/core/utils/gate-hit";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { useCodeReviewRouteParams } from "src/app/(app)/settings/_hooks";
import { OverrideIndicatorForm } from "src/app/(app)/settings/code-review/_components/override";
import { isTeamsOrEnterprisePlan } from "src/features/ee/byok/_utils";
import { useSubscriptionContext } from "src/features/ee/subscription/_providers/subscription-context";

import type {
    CodeReviewFormType,
    LinkedRepositoryConfig,
} from "src/app/(app)/settings/code-review/_types";
import {
    addLinkedRepository,
    MAX_LINKED_REPOSITORIES_UI,
    normalizeLinkedRepositories,
} from "./linked-repositories-state";

export { MAX_LINKED_REPOSITORIES_UI };

type ConnectedRepo = {
    id: string;
    name: string;
    fullName: string;
};

/**
 * Cross-repo context (#1576) — compact connection list (not a dense form).
 *
 * Pattern from Refero (Cursor integrations / Fernand tags / Manus connectors):
 * - short subtitle
 * - compact rows (repo · ref · remove)
 * - expand row for optional instructions + ref pin
 * - Add opens a modal picker
 * - empty state with CTA
 */
export const LinkedRepositories = () => {
    const form = useFormContext<CodeReviewFormType>();
    const { teamId } = useSelectedTeamId();
    const { repositoryId } = useCodeReviewRouteParams();
    const selectedReposQuery = useGetSelectedRepositories(teamId);
    const { license } = useSubscriptionContext();
    const planAllowed = isTeamsOrEnterprisePlan(license);
    const [addOpen, setAddOpen] = useState(false);
    const [expandedKey, setExpandedKey] = useState<string | null>(null);

    const connectedRepos = useMemo((): ConnectedRepo[] => {
        const repos = selectedReposQuery.data ?? [];
        return repos
            .filter((repo) => repo?.id && (repo.full_name || repo.name))
            .map((repo) => ({
                id: String(repo.id),
                name: repo.name,
                fullName: repo.full_name || repo.name,
            }))
            .filter((repo) => repo.id !== repositoryId);
    }, [selectedReposQuery.data, repositoryId]);

    if (!planAllowed) {
        return <LinkedRepositoriesPlanGate />;
    }

    return (
        <Controller
            name="linkedRepositories.value"
            control={form.control}
            defaultValue={[]}
            render={({ field }) => {
                const links = normalizeLinkedRepositories(field.value);
                const linkedKeys = new Set(
                    links.map((l) => l.repository.toLowerCase()),
                );
                const available = connectedRepos.filter(
                    (repo) =>
                        !linkedKeys.has(repo.fullName.toLowerCase()) &&
                        !linkedKeys.has(repo.name.toLowerCase()),
                );
                const atCap = links.length >= MAX_LINKED_REPOSITORIES_UI;
                const canAdd =
                    !field.disabled && !atCap && available.length > 0;

                const addRepo = (fullName: string) => {
                    if (field.disabled) return;
                    const next = addLinkedRepository(links, fullName);
                    if (next === links) return;
                    field.onChange(next);
                    setAddOpen(false);
                    // Expand the new row so the user can add instructions.
                    setExpandedKey(fullName.toLowerCase());
                };

                const updateLink = (
                    index: number,
                    patch: Partial<LinkedRepositoryConfig>,
                ) => {
                    field.onChange(
                        links.map((entry, i) =>
                            i === index ? { ...entry, ...patch } : entry,
                        ),
                    );
                };

                const removeLink = (index: number) => {
                    const removed = links[index];
                    field.onChange(links.filter((_, i) => i !== index));
                    if (
                        removed &&
                        expandedKey === removed.repository.toLowerCase()
                    ) {
                        setExpandedKey(null);
                    }
                };

                const toggleExpand = (repository: string) => {
                    const key = repository.toLowerCase();
                    setExpandedKey((cur) => (cur === key ? null : key));
                };

                return (
                    <FormControl.Root>
                        <div className="mb-1 flex flex-row items-center gap-2">
                            <div className="flex items-center gap-1.5">
                                <FormControl.Label htmlFor={field.name}>
                                    Linked repositories
                                </FormControl.Label>
                                <Badge variant="secondary" size="xs">
                                    Beta
                                </Badge>
                            </div>
                            <OverrideIndicatorForm fieldName="linkedRepositories" />
                        </div>

                        <p className="text-text-secondary mb-3 text-sm">
                            Sibling repos Kody uses as read-only context when
                            reviewing this repository.
                        </p>

                        {links.length === 0 ? (
                            <EmptyState
                                disabled={field.disabled}
                                canAdd={canAdd}
                                atCap={atCap}
                                noAvailable={available.length === 0}
                                onAdd={() => setAddOpen(true)}
                            />
                        ) : (
                            <div className="border-card-lv3 bg-card-lv1 overflow-hidden rounded-lg border">
                                <ul className="divide-card-lv3 divide-y">
                                    {links.map((link, index) => {
                                        const key =
                                            link.repository.toLowerCase();
                                        const isOpen = expandedKey === key;
                                        const refLabel =
                                            link.ref?.trim() || "auto";
                                        const hasInstructions = Boolean(
                                            link.instructions?.trim(),
                                        );

                                        return (
                                            <li key={`${link.repository}-${index}`}>
                                                <div
                                                    className={cn(
                                                        "flex items-center gap-2 px-3 py-2.5",
                                                        !field.disabled &&
                                                            "hover:bg-card-lv2 cursor-pointer",
                                                    )}
                                                    onClick={() => {
                                                        if (!field.disabled)
                                                            toggleExpand(
                                                                link.repository,
                                                            );
                                                    }}
                                                    role="button"
                                                    tabIndex={0}
                                                    onKeyDown={(e) => {
                                                        if (
                                                            e.key === "Enter" ||
                                                            e.key === " "
                                                        ) {
                                                            e.preventDefault();
                                                            if (!field.disabled)
                                                                toggleExpand(
                                                                    link.repository,
                                                                );
                                                        }
                                                    }}
                                                    aria-expanded={isOpen}>
                                                    <span className="text-text-secondary shrink-0">
                                                        {isOpen ? (
                                                            <ChevronDown className="size-3.5" />
                                                        ) : (
                                                            <ChevronRight className="size-3.5" />
                                                        )}
                                                    </span>
                                                    <Link2Icon className="text-primary size-3.5 shrink-0" />
                                                    <div className="min-w-0 flex-1">
                                                        <div className="truncate text-sm font-medium">
                                                            {link.repository}
                                                        </div>
                                                        {!isOpen &&
                                                            hasInstructions && (
                                                                <div className="text-text-secondary truncate text-xs">
                                                                    {
                                                                        link.instructions
                                                                    }
                                                                </div>
                                                            )}
                                                    </div>
                                                    <span className="text-text-secondary flex shrink-0 items-center gap-1 text-xs">
                                                        <GitBranchIcon className="size-3" />
                                                        {refLabel}
                                                    </span>
                                                    <Button
                                                        type="button"
                                                        size="icon-xs"
                                                        variant="cancel"
                                                        disabled={
                                                            field.disabled
                                                        }
                                                        aria-label={`Remove ${link.repository}`}
                                                        className="shrink-0"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            removeLink(index);
                                                        }}>
                                                        <X className="size-3.5" />
                                                    </Button>
                                                </div>

                                                {isOpen && (
                                                    <div
                                                        className="bg-card-lv2 border-card-lv3 space-y-3 border-t px-3 py-3 pl-10"
                                                        onClick={(e) =>
                                                            e.stopPropagation()
                                                        }>
                                                        <div className="flex flex-col gap-1.5">
                                                            <label className="text-text-secondary text-xs font-medium">
                                                                Instructions
                                                                <span className="font-normal opacity-70">
                                                                    {" "}
                                                                    · optional
                                                                </span>
                                                            </label>
                                                            <Input
                                                                disabled={
                                                                    field.disabled
                                                                }
                                                                value={
                                                                    link.instructions ??
                                                                    ""
                                                                }
                                                                placeholder="e.g. REST API this frontend consumes"
                                                                maxLength={500}
                                                                onChange={(e) =>
                                                                    updateLink(
                                                                        index,
                                                                        {
                                                                            instructions:
                                                                                e
                                                                                    .target
                                                                                    .value,
                                                                        },
                                                                    )
                                                                }
                                                            />
                                                        </div>
                                                        <div className="flex flex-col gap-1.5">
                                                            <label className="text-text-secondary text-xs font-medium">
                                                                Branch / ref pin
                                                                <span className="font-normal opacity-70">
                                                                    {" "}
                                                                    · optional
                                                                </span>
                                                            </label>
                                                            <Input
                                                                disabled={
                                                                    field.disabled
                                                                }
                                                                value={
                                                                    link.ref ??
                                                                    ""
                                                                }
                                                                placeholder="Leave empty for same-branch cascade"
                                                                maxLength={200}
                                                                onChange={(e) =>
                                                                    updateLink(
                                                                        index,
                                                                        {
                                                                            ref: e
                                                                                .target
                                                                                .value,
                                                                        },
                                                                    )
                                                                }
                                                            />
                                                            <p className="text-text-secondary text-[11px] leading-snug">
                                                                Empty = match
                                                                this PR&apos;s
                                                                branch, then the
                                                                sibling&apos;s
                                                                default branch.
                                                            </p>
                                                        </div>
                                                    </div>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>

                                <div className="border-card-lv3 border-t px-3 py-2">
                                    <AddButton
                                        canAdd={canAdd}
                                        atCap={atCap}
                                        noAvailable={available.length === 0}
                                        disabled={field.disabled}
                                        onClick={() => setAddOpen(true)}
                                    />
                                </div>
                            </div>
                        )}

                        <AddRepositoryDialog
                            open={addOpen}
                            onOpenChange={setAddOpen}
                            available={available}
                            isLoading={selectedReposQuery.isLoading}
                            onSelect={addRepo}
                        />
                    </FormControl.Root>
                );
            }}
        />
    );
};

function LinkedRepositoriesPlanGate() {
    const { license } = useSubscriptionContext();
    const reported = useRef(false);

    useEffect(() => {
        if (reported.current) return;
        reported.current = true;
        void captureGateHit({
            feature: "linked_repositories",
            plan: license.planType ?? license.subscriptionStatus,
            metadata: { surface: "settings_general" },
        });
    }, [license.planType, license.subscriptionStatus]);

    return (
        <FormControl.Root>
            <div className="mb-1 flex flex-row items-center gap-2">
                <div className="flex items-center gap-1.5">
                    <FormControl.Label>Linked repositories</FormControl.Label>
                    <Badge variant="secondary" size="xs">
                        Teams
                    </Badge>
                </div>
            </div>
            <p className="text-text-secondary mb-3 text-sm">
                Sibling repos Kody uses as read-only context when reviewing this
                repository.
            </p>
            <div className="border-card-lv3 bg-card-lv1 flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-8 text-center">
                <div className="bg-card-lv2 text-text-secondary flex size-9 items-center justify-center rounded-full">
                    <LockIcon className="size-4" />
                </div>
                <div className="space-y-1">
                    <p className="text-sm font-medium">
                        Available on Teams and Enterprise
                    </p>
                    <p className="text-text-secondary max-w-sm text-xs leading-relaxed">
                        Cross-repo context lets Kody check contracts and APIs
                        across sibling services during review. Upgrade to unlock
                        linked repositories.
                    </p>
                </div>
                <GateCtaLink
                    feature="linked_repositories"
                    plan={license.planType ?? license.subscriptionStatus}
                    size="sm"
                    metadata={{ surface: "settings_general" }}
                />
            </div>
        </FormControl.Root>
    );
}

function EmptyState({
    disabled,
    canAdd,
    atCap,
    noAvailable,
    onAdd,
}: {
    disabled?: boolean;
    canAdd: boolean;
    atCap: boolean;
    noAvailable: boolean;
    onAdd: () => void;
}) {
    return (
        <div className="border-card-lv3 bg-card-lv1 flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-8 text-center">
            <div className="bg-card-lv2 text-text-secondary flex size-9 items-center justify-center rounded-full">
                <Link2Icon className="size-4" />
            </div>
            <div className="space-y-1">
                <p className="text-sm font-medium">No linked repositories</p>
                <p className="text-text-secondary max-w-sm text-xs leading-relaxed">
                    Link a sibling service so Kody can check contracts across
                    repo boundaries during review.
                </p>
            </div>
            <AddButton
                canAdd={canAdd}
                atCap={atCap}
                noAvailable={noAvailable}
                disabled={disabled}
                onClick={onAdd}
            />
        </div>
    );
}

function AddButton({
    canAdd,
    atCap,
    noAvailable,
    disabled,
    onClick,
}: {
    canAdd: boolean;
    atCap: boolean;
    noAvailable: boolean;
    disabled?: boolean;
    onClick: () => void;
}) {
    const button = (
        <Button
            type="button"
            size="sm"
            variant="helper"
            disabled={disabled || !canAdd}
            onClick={onClick}
            className="gap-1.5">
            <Plus className="size-3.5" />
            Add repository
        </Button>
    );

    if (disabled || canAdd) return button;

    const tip = atCap
        ? `Maximum of ${MAX_LINKED_REPOSITORIES_UI} linked repositories`
        : noAvailable
          ? "No other connected repositories available to link"
          : undefined;

    if (!tip) return button;

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-flex">{button}</span>
            </TooltipTrigger>
            <TooltipContent>{tip}</TooltipContent>
        </Tooltip>
    );
}

function AddRepositoryDialog({
    open,
    onOpenChange,
    available,
    isLoading,
    onSelect,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    available: ConnectedRepo[];
    isLoading?: boolean;
    onSelect: (fullName: string) => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[min(80vh,32rem)] max-w-md flex-col gap-0 overflow-hidden p-0">
                <DialogHeader className="border-card-lv3 shrink-0 border-b px-5 py-4">
                    <DialogTitle>Add linked repository</DialogTitle>
                    <DialogDescription>
                        Choose a sibling repo already connected to this team.
                        Kody will use it as read-only context.
                    </DialogDescription>
                </DialogHeader>

                <Command className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-none border-0">
                    <CommandInput placeholder="Search repositories…" />
                    <CommandList className="max-h-none flex-1 overflow-y-auto">
                        <CommandEmpty>
                            {isLoading
                                ? "Loading repositories…"
                                : "No repository found."}
                        </CommandEmpty>
                        <CommandGroup>
                            {available.map((repo) => (
                                <CommandItem
                                    key={repo.id}
                                    value={`${repo.fullName} ${repo.name}`}
                                    onSelect={() => onSelect(repo.fullName)}
                                    className="cursor-pointer gap-2 py-2.5">
                                    <Link2Icon className="text-text-secondary size-3.5 shrink-0" />
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate text-sm font-medium">
                                            {repo.fullName}
                                        </div>
                                        {repo.name !== repo.fullName && (
                                            <div className="text-text-secondary truncate text-xs">
                                                {repo.name}
                                            </div>
                                        )}
                                    </div>
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>

                <DialogFooter className="border-card-lv3 shrink-0 border-t px-5 py-3 sm:justify-end">
                    <Button
                        type="button"
                        size="sm"
                        variant="cancel"
                        onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
