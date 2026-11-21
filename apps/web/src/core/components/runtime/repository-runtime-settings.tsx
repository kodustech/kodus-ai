"use client";

import NextLink from "next/link";
import { RuntimeErrorState } from "@components/runtime/empty-state";
import { RuntimeSection } from "@components/runtime/section";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { Skeleton } from "@components/ui/skeleton";
import {
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableHeader,
    TableRow,
} from "@components/ui/table";
import { toast } from "@components/ui/toaster/use-toast";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type {
    RuntimeMode,
    RuntimeRepositorySettings,
    RuntimeWhoCanAsk,
} from "@services/runtime/contracts";
import {
    RUNTIME_MODE_OPTIONS,
    WHO_CAN_ASK_OPTIONS,
} from "@services/runtime/labels";
import {
    membershipsByRepository,
    ownModeNote,
} from "@services/runtime/model/environment-repositories";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import { modeOf } from "@services/runtime/model/rules";
import {
    useRuntimeEnvironments,
    useRuntimeSettings,
    useUpdateRuntimeRepositorySettings,
} from "@services/runtime/queries";

const repositoryPage = (repositoryId: string) =>
    `/settings/code-review/${encodeURIComponent(repositoryId)}/kody-runtime`;

/**
 * One repository's Runtime settings: when the Runtime runs (`mode`, the one
 * on/off switch the UI writes; the API derives `pilot` from it) and who may
 * ask for it, plus the save that both selects share.
 */
const useRepositoryRuntime = (repository: RuntimeRepositorySettings) => {
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repository.repositoryId,
    );
    const update = useUpdateRuntimeRepositorySettings();
    const name = repository.repositoryName ?? repository.repositoryId;
    const save = (patch: {
        mode?: RuntimeMode;
        whoCanAsk?: RuntimeWhoCanAsk;
    }) =>
        update.mutate(
            { repositoryId: repository.repositoryId, ...patch },
            {
                onError: (error) =>
                    toast({
                        variant: "danger",
                        title: `Couldn't save ${name}`,
                        description: runtimeErrorMessage(error, {
                            fallback: "Try again in a moment.",
                        }),
                    }),
            },
        );
    return {
        name,
        mode: modeOf(repository),
        hasRules: (repository.rules?.length ?? 0) > 0,
        disabled: !canEdit || update.isPending,
        save,
    };
};

const ModeSelect = ({
    repository,
    className = "w-48",
}: {
    repository: RuntimeRepositorySettings;
    className?: string;
}) => {
    const { name, mode, hasRules, disabled, save } =
        useRepositoryRuntime(repository);
    return (
        <Select
            value={mode}
            disabled={disabled}
            onValueChange={(value) => save({ mode: value as RuntimeMode })}>
            <SelectTrigger
                className={className}
                aria-label={`When Kody Runtime runs on ${name}`}>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {RUNTIME_MODE_OPTIONS.map((option) => (
                    <SelectItem
                        key={option.value}
                        value={option.value}
                        // Rules need rules: they are written on the repository's page.
                        disabled={option.value === "rules" && !hasRules}>
                        {option.label}
                        {option.value === "rules" && hasRules
                            ? ` (${repository.rules!.length})`
                            : ""}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
};

const WhoCanAskSelect = ({
    repository,
    className = "w-64",
}: {
    repository: RuntimeRepositorySettings;
    className?: string;
}) => {
    const { name, mode, disabled, save } = useRepositoryRuntime(repository);
    return (
        <Select
            value={repository.whoCanAsk}
            disabled={disabled || mode === "off"}
            onValueChange={(value) =>
                save({ whoCanAsk: value as RuntimeWhoCanAsk })
            }>
            <SelectTrigger
                className={className}
                aria-label={`Who may ask @kody runtime on ${name}`}>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {WHO_CAN_ASK_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                        {option.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
};

/** One table row of the organization's repositories. Rules are edited on the repository's Runtime page. */
const RepositoryRow = ({
    repository,
    note,
}: {
    repository: RuntimeRepositorySettings;
    /** It is a member of another environment: what its own mode governs (ownModeNote). */
    note?: string;
}) => {
    const name = repository.repositoryName ?? repository.repositoryId;
    return (
        <TableRow>
            <TableCell className="font-medium">
                <NextLink
                    href={repositoryPage(repository.repositoryId)}
                    className="hover:underline">
                    {name}
                </NextLink>
                {note ? (
                    <p className="text-text-secondary mt-1 max-w-sm text-xs font-normal">
                        {note}
                    </p>
                ) : null}
            </TableCell>
            <TableCell>
                <ModeSelect repository={repository} />
            </TableCell>
            <TableCell>
                <WhoCanAskSelect repository={repository} />
            </TableCell>
        </TableRow>
    );
};

/**
 * "Kody Runtime" on a Code Review routing page. The global scope shows every
 * repository in a table; a repository shows only its own two selects. Both save
 * as they change, through the same API as the Runtime settings always used.
 */
export const RuntimeRoutingSection = ({
    repositoryId,
}: {
    /** `"global"` for the organization's page, else the repository's id. */
    repositoryId: string;
}) => {
    const global = repositoryId === "global";
    const settings = useRuntimeSettings();
    const environments = useRuntimeEnvironments();
    const memberships = membershipsByRepository(environments.data ?? []);
    const repositories = settings.data?.repositories ?? [];
    const repository = global
        ? undefined
        : repositories.find((r) => r.repositoryId === repositoryId);

    return (
        <RuntimeSection
            title="Kody Runtime"
            description={
                global
                    ? "When Kody Runtime runs on each repository's own environment, and who may ask for it. Turning a repository on creates its environment; a member of another environment runs there by that environment's settings. Rules are written on the repository's Runtime page. Saved as you change it."
                    : "When Kody Runtime runs on this repository, and who may ask for it. Saved as you change it."
            }>
            {settings.isLoading ? (
                <Skeleton className="h-32 w-full" />
            ) : settings.isError ? (
                // Never a table of defaults: it would read as saved, and a change would overwrite.
                <RuntimeErrorState
                    what="the Runtime settings"
                    error={settings.error}
                    onRetry={() => settings.refetch()}
                />
            ) : global ? (
                repositories.length === 0 ? (
                    <p className="text-text-secondary text-sm">
                        No repository connected.
                    </p>
                ) : (
                    <TableContainer>
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Repository</TableHead>
                                    <TableHead>Runs</TableHead>
                                    <TableHead>
                                        Who may ask @kody runtime
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {repositories.map((r) => (
                                    <RepositoryRow
                                        key={r.repositoryId}
                                        repository={r}
                                        note={ownModeNote(
                                            memberships.get(r.repositoryId),
                                        )}
                                    />
                                ))}
                            </TableBody>
                        </Table>
                    </TableContainer>
                )
            ) : repository ? (
                <div className="flex flex-wrap items-center gap-6">
                    <div className="flex flex-col gap-1.5 text-sm">
                        <span className="text-text-secondary">Runs</span>
                        <ModeSelect repository={repository} />
                    </div>
                    <div className="flex flex-col gap-1.5 text-sm">
                        <span className="text-text-secondary">
                            Who may ask @kody runtime
                        </span>
                        <WhoCanAskSelect repository={repository} />
                    </div>
                </div>
            ) : (
                <p className="text-text-secondary text-sm">
                    This repository is not in the Runtime settings yet.
                </p>
            )}
        </RuntimeSection>
    );
};
