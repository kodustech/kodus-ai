"use client";

import { useId, useMemo, useState } from "react";
import NextLink from "next/link";
import { StatusChip } from "@components/runtime/status-chip";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { Input } from "@components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { Switch } from "@components/ui/switch";
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
import type {
    EnvironmentRepository,
    RuntimeEnvironment,
} from "@services/runtime/contracts";
import { shortSha } from "@services/runtime/format";
import { CONNECT_REPOSITORIES_HREF } from "@services/runtime/model/blockers";
import { ENVIRONMENT_SECTION } from "@services/runtime/model/environment";
import {
    addableRepositories,
    aliasProblem,
    environmentName,
    environmentRepositoriesOf,
    isEnvironmentFull,
    MANAGE_REPOSITORIES_REASON,
    MAX_ENVIRONMENT_REPOSITORIES,
    membershipsByRepository,
    namesInWords,
    otherEnvironmentsOf,
    repositoryChangeError,
    repositoryLabel,
    type AddableRepository,
    type RepositoryMembership,
} from "@services/runtime/model/environment-repositories";
import {
    useAddEnvironmentRepository,
    useRemoveEnvironmentRepository,
    useUpdateEnvironmentRepository,
} from "@services/runtime/queries";
import { PlusIcon, Trash2Icon } from "lucide-react";

// The environment page's Repositories section (docs/runtime/multi-repo.md): the repositories Kody boots
// together, each with its folder, whether its PRs start Runs here, whether a
// Run pairs its PR of the same branch name, and the commit of the last setup.

/** The words of "what happens next", shared by the dialog and the notice after a change. */
const NEXT_SETUP =
    "Runs keep using the last good setup until the new one boots from zero.";

const RoleLine = ({
    repository,
    others,
}: {
    repository: EnvironmentRepository;
    others: RepositoryMembership[];
}) => (
    <span className="text-text-tertiary text-xs">
        {repository.role === "primary"
            ? "Primary · holds the setup file"
            : "Member"}
        {others.length > 0 &&
            ` · also in ${namesInWords(others.map((o) => o.name))}`}
    </span>
);

const RepositoryRow = ({
    environmentId,
    repository,
    others,
    canManage,
    onRemove,
}: {
    environmentId: string;
    repository: EnvironmentRepository;
    others: RepositoryMembership[];
    canManage: boolean;
    onRemove: (repository: EnvironmentRepository) => void;
}) => {
    const update = useUpdateEnvironmentRepository();
    const name = repositoryLabel(repository);
    const pending = update.isPending ? update.variables : undefined;
    const triggers = pending?.triggers ?? repository.triggers;
    const pair = pending?.pairBranches ?? repository.pairBranches;
    const reason = canManage ? undefined : MANAGE_REPOSITORIES_REASON;
    const change = (patch: { triggers?: boolean; pairBranches?: boolean }) =>
        update.mutate({
            environmentId,
            repositoryId: repository.repositoryId,
            ...patch,
        });
    const isPrimary = repository.role === "primary";
    return (
        <TableRow>
            <TableCell>
                <span className="flex flex-col gap-0.5">
                    <span className="font-medium" title={repository.fullName}>
                        {repository.fullName || name}
                    </span>
                    <RoleLine repository={repository} others={others} />
                    {update.isError && (
                        <span role="alert" className="text-danger text-xs">
                            {repositoryChangeError(update.error)}
                        </span>
                    )}
                </span>
            </TableCell>
            <TableCell className="font-mono text-xs">
                ws/{repository.alias}
            </TableCell>
            <TableCell>
                <span className="flex items-center gap-2" title={reason}>
                    <Switch
                        size="sm"
                        checked={triggers}
                        loading={pending?.triggers !== undefined}
                        disabled={!canManage}
                        onCheckedChange={(checked) =>
                            change({ triggers: checked })
                        }
                        aria-label={`Run pull requests of ${name} in this environment`}
                    />
                    <span className="text-text-secondary text-xs">
                        {triggers ? "Yes" : "No"}
                    </span>
                </span>
            </TableCell>
            <TableCell>
                {isPrimary ? (
                    <span
                        className="text-text-tertiary text-xs"
                        title="Its pull requests are what the Run tests: there is nothing to pair.">
                        —
                    </span>
                ) : (
                    <span className="flex items-center gap-2" title={reason}>
                        <Switch
                            size="sm"
                            checked={pair}
                            loading={pending?.pairBranches !== undefined}
                            disabled={!canManage}
                            onCheckedChange={(checked) =>
                                change({ pairBranches: checked })
                            }
                            aria-label={`Pair branches of ${name} with the same name`}
                        />
                        <span className="text-text-secondary text-xs">
                            {pair ? "Same branch name" : "Off"}
                        </span>
                    </span>
                )}
            </TableCell>
            <TableCell className="text-sm">
                {repository.lastSetupSha ? (
                    <span className="font-mono text-xs">
                        {shortSha(repository.lastSetupSha)}
                    </span>
                ) : (
                    <span className="text-text-tertiary text-xs">
                        {isPrimary ? "None yet" : "Not in the last setup"}
                    </span>
                )}
            </TableCell>
            <TableCell className="text-right">
                {!isPrimary && (
                    <Button
                        size="xs"
                        variant="helper"
                        leftIcon={<Trash2Icon />}
                        disabled={!canManage}
                        title={reason}
                        onClick={() => onRemove(repository)}
                        aria-label={`Remove ${name}`}>
                        Remove
                    </Button>
                )}
            </TableCell>
        </TableRow>
    );
};

/** The confirmation before a member leaves; the refusal stays in the dialog. */
const RemoveRepositoryDialog = ({
    env,
    repository,
    onClose,
}: {
    env: RuntimeEnvironment;
    repository: EnvironmentRepository | undefined;
    onClose: () => void;
}) => {
    const remove = useRemoveEnvironmentRepository();
    const name = repository ? repositoryLabel(repository) : "";
    const close = () => {
        remove.reset();
        onClose();
    };
    return (
        <Dialog
            open={!!repository}
            onOpenChange={(open) => !open && !remove.isPending && close()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        Remove {name} from {environmentName(env)}?
                    </DialogTitle>
                    <DialogDescription>
                        Kody sets the environment up again without it, and its
                        pull requests stop starting Runs here. {NEXT_SETUP} The
                        setup file may still name it: change it too.
                    </DialogDescription>
                </DialogHeader>
                {remove.isError && (
                    <p role="alert" className="text-danger text-sm">
                        {repositoryChangeError(remove.error)}
                    </p>
                )}
                <DialogFooter>
                    <Button
                        size="md"
                        variant="cancel"
                        onClick={close}
                        disabled={remove.isPending}>
                        Cancel
                    </Button>
                    <Button
                        size="md"
                        variant="tertiary"
                        loading={remove.isPending}
                        onClick={() =>
                            repository &&
                            remove.mutate(
                                {
                                    environmentId: env.environmentId,
                                    repositoryId: repository.repositoryId,
                                },
                                {
                                    onSuccess: () => {
                                        toast({
                                            variant: "success",
                                            title: `${name} removed`,
                                            description: `A new setup started without it. ${NEXT_SETUP}`,
                                        });
                                        close();
                                    },
                                },
                            )
                        }>
                        Remove
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

/**
 * Add a repository: only the org's connected ones, the folder prefilled with
 * the name the API would give it, and the two switches. A repository already
 * part of another environment starts with "Run its pull requests here" off:
 * on, each of its PRs costs one more Run.
 */
export const AddRepositoryDialog = ({
    env,
    open,
    onOpenChange,
    candidates,
}: {
    env: RuntimeEnvironment;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    candidates: AddableRepository[];
}) => {
    const add = useAddEnvironmentRepository();
    const [repositoryId, setRepositoryId] = useState<string>();
    const [alias, setAlias] = useState("");
    const [aliasEdited, setAliasEdited] = useState(false);
    const [triggers, setTriggers] = useState(true);
    const [pairBranches, setPairBranches] = useState(false);
    const [touched, setTouched] = useState(false);
    const aliasId = useId();
    const aliasHintId = useId();
    const triggersId = useId();
    const pairId = useId();

    const chosen = candidates.find((c) => c.repositoryId === repositoryId);
    const current = environmentRepositoriesOf(env);
    const others = current.map((r) => r.fullName || r.repositoryName);
    const taken = current.map((r) => ({
        alias: r.alias,
        name: repositoryLabel(r),
    }));
    const problem = chosen ? aliasProblem(alias, taken) : undefined;

    const reset = () => {
        setRepositoryId(undefined);
        setAlias("");
        setAliasEdited(false);
        setTriggers(true);
        setPairBranches(false);
        setTouched(false);
        add.reset();
    };
    const close = (next: boolean) => {
        if (add.isPending) return;
        if (!next) reset();
        onOpenChange(next);
    };
    const pick = (id: string) => {
        const next = candidates.find((c) => c.repositoryId === id);
        setRepositoryId(id);
        if (!aliasEdited && next) setAlias(next.defaultAlias);
        // A second system's member does not run its PRs here by default.
        if (next) setTriggers(next.alsoIn.length === 0);
        add.reset();
    };
    const submit = () => {
        setTouched(true);
        if (!chosen || problem) return;
        add.mutate(
            {
                environmentId: env.environmentId,
                repositoryId: chosen.repositoryId,
                ...(alias !== chosen.defaultAlias ? { alias } : {}),
                triggers,
                pairBranches,
            },
            {
                onSuccess: (result) => {
                    toast({
                        variant: "success",
                        title: `${repositoryLabel({ repositoryName: chosen.name, fullName: chosen.name })} added`,
                        description: result?.setupRequested
                            ? `Kody is setting the environment up again with it. ${NEXT_SETUP}`
                            : "It was already part of this environment.",
                    });
                    reset();
                    onOpenChange(false);
                },
            },
        );
    };

    return (
        <Dialog open={open} onOpenChange={close}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>
                        Add a repository to {environmentName(env)}
                    </DialogTitle>
                    <DialogDescription>
                        It boots with {namesInWords(others, 3)} in every Run of
                        this environment.
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-5"
                    onSubmit={(e) => {
                        e.preventDefault();
                        submit();
                    }}>
                    <div className="flex flex-col gap-1.5">
                        <span
                            className="text-sm font-medium"
                            id={`${aliasId}-repo`}>
                            Repository
                        </span>
                        <Select value={repositoryId ?? ""} onValueChange={pick}>
                            <SelectTrigger
                                aria-labelledby={`${aliasId}-repo`}
                                aria-invalid={touched && !chosen}>
                                <SelectValue placeholder="Choose a connected repository" />
                            </SelectTrigger>
                            <SelectContent>
                                {candidates.map((c) => (
                                    <SelectItem
                                        key={c.repositoryId}
                                        value={c.repositoryId}>
                                        {c.name}
                                        {c.alsoIn.length > 0 &&
                                            ` · also in ${namesInWords(c.alsoIn)}`}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <span className="text-text-tertiary text-xs">
                            Only repositories connected to this organization.
                            Not listed?{" "}
                            <NextLink
                                href={CONNECT_REPOSITORIES_HREF}
                                className="text-primary-light hover:underline">
                                Connect it in the Git settings
                            </NextLink>
                            .
                        </span>
                        {touched && !chosen && (
                            <span role="alert" className="text-danger text-xs">
                                Choose a repository.
                            </span>
                        )}
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <label
                            htmlFor={aliasId}
                            className="text-sm font-medium">
                            Folder
                        </label>
                        <div className="flex items-center gap-2">
                            <span className="text-text-tertiary font-mono text-sm">
                                ws/
                            </span>
                            <Input
                                id={aliasId}
                                size="md"
                                value={alias}
                                disabled={!chosen}
                                onChange={(e) => {
                                    setAlias(e.target.value.trim());
                                    setAliasEdited(true);
                                    add.reset();
                                }}
                                aria-invalid={!!problem}
                                aria-describedby={aliasHintId}
                                className="font-mono"
                            />
                        </div>
                        <span
                            id={aliasHintId}
                            className={
                                problem
                                    ? "text-danger text-xs"
                                    : "text-text-tertiary text-xs"
                            }>
                            {problem ??
                                (chosen
                                    ? `The setup file's compose reaches it as ../${alias}.`
                                    : "Where it sits beside the other repositories.")}
                        </span>
                    </div>

                    <div className="flex flex-col gap-3">
                        <div className="flex items-start gap-3">
                            <Switch
                                id={triggersId}
                                size="sm"
                                checked={triggers}
                                onCheckedChange={setTriggers}
                                aria-describedby={`${triggersId}-hint`}
                            />
                            <span className="flex flex-col gap-0.5">
                                <label
                                    htmlFor={triggersId}
                                    className="text-sm font-medium">
                                    Run its pull requests here
                                </label>
                                <span
                                    id={`${triggersId}-hint`}
                                    className="text-text-tertiary text-xs">
                                    A pull request in it boots this whole system
                                    with it at the pull request.
                                    {chosen && chosen.alsoIn.length > 0
                                        ? ` It is also in ${namesInWords(chosen.alsoIn)}: on here, each of its pull requests starts one more Run.`
                                        : ""}
                                </span>
                            </span>
                        </div>
                        <div className="flex items-start gap-3">
                            <Switch
                                id={pairId}
                                size="sm"
                                checked={pairBranches}
                                onCheckedChange={setPairBranches}
                                aria-describedby={`${pairId}-hint`}
                            />
                            <span className="flex flex-col gap-0.5">
                                <label
                                    htmlFor={pairId}
                                    className="text-sm font-medium">
                                    Pair branches with the same name
                                </label>
                                <span
                                    id={`${pairId}-hint`}
                                    className="text-text-tertiary text-xs">
                                    When a pull request elsewhere comes from a
                                    branch this repository also has an open pull
                                    request from, the Run boots that pull
                                    request too instead of the default branch.
                                </span>
                            </span>
                        </div>
                    </div>

                    <div className="bg-card-lv2 flex flex-col gap-1 rounded-lg p-3">
                        <span className="text-sm font-medium">
                            What happens next
                        </span>
                        <span className="text-text-secondary text-xs">
                            Kody reads the new repository and sets the
                            environment up again with it. {NEXT_SETUP} The setup
                            file in {repositoryLabel(current[0])} must build and
                            start it: if it does not yet, the setup says so.
                        </span>
                    </div>

                    {add.isError && (
                        <p role="alert" className="text-danger text-sm">
                            {repositoryChangeError(add.error)}
                        </p>
                    )}

                    <DialogFooter>
                        <Button
                            type="button"
                            size="md"
                            variant="cancel"
                            disabled={add.isPending}
                            onClick={() => close(false)}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            size="md"
                            variant="primary"
                            loading={add.isPending}
                            disabled={!!problem}>
                            Add and set up
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export const EnvironmentRepositories = ({
    env,
    environments,
    connected,
    canManage,
}: {
    env: RuntimeEnvironment;
    /** The org's environments, for the other systems a repository is part of. */
    environments: readonly RuntimeEnvironment[];
    /** The connected repositories (Runtime settings); absent while unknown. */
    connected:
        | ReadonlyArray<{ repositoryId: string; repositoryName?: string }>
        | undefined;
    /** Manage on the environment: the owner of the organization. */
    canManage: boolean;
}) => {
    const [adding, setAdding] = useState(false);
    const [removing, setRemoving] = useState<EnvironmentRepository>();
    const memberships = useMemo(
        () => membershipsByRepositoryOf(environments, env),
        [environments, env],
    );
    const repositories = environmentRepositoriesOf(env);
    const candidates = addableRepositories(connected ?? [], env, memberships);
    const full = isEnvironmentFull(env);
    const addReason = !canManage
        ? MANAGE_REPOSITORIES_REASON
        : full
          ? `An environment holds at most ${MAX_ENVIRONMENT_REPOSITORIES} repositories.`
          : !connected
            ? "Reading the connected repositories…"
            : candidates.length === 0
              ? "Every connected repository is already part of this environment."
              : undefined;

    // A member that also runs its PRs in another system, and not here.
    const sharedQuiet = repositories.filter(
        (r) =>
            r.role === "member" &&
            !r.triggers &&
            otherEnvironmentsOf(memberships, r.repositoryId, env.environmentId)
                .length > 0,
    );

    return (
        <section
            id={ENVIRONMENT_SECTION.repositories}
            aria-label="Repositories"
            className="bg-card-lv1 flex scroll-mt-24 flex-col gap-4 rounded-xl p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                    <h2 className="text-text-primary text-base font-semibold">
                        Repositories
                    </h2>
                    <p className="text-text-secondary max-w-2xl text-sm">
                        {repositories.length > 1
                            ? "A pull request in a repository boots it at the pull request. The others boot at the commit of their default branch fixed when the Run starts, the same on both sides, so the diff is the only difference."
                            : "Kody boots this repository on its own. Add the repositories it runs with, and a pull request in any of them boots the whole system."}
                    </p>
                </div>
                <span className="flex flex-col items-end gap-1">
                    <Button
                        size="sm"
                        variant="secondary"
                        leftIcon={<PlusIcon />}
                        disabled={!!addReason}
                        onClick={() => setAdding(true)}>
                        Add repository
                    </Button>
                    {addReason && (
                        <span className="text-text-tertiary max-w-64 text-right text-xs">
                            {addReason}
                        </span>
                    )}
                </span>
            </div>

            <TableContainer>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Repository</TableHead>
                            <TableHead>Folder</TableHead>
                            <TableHead>Runs its PRs</TableHead>
                            <TableHead>Pair branches</TableHead>
                            <TableHead>Last setup</TableHead>
                            <TableHead>
                                <span className="sr-only">Actions</span>
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {repositories.map((r) => (
                            <RepositoryRow
                                key={r.repositoryId}
                                environmentId={env.environmentId}
                                repository={r}
                                others={otherEnvironmentsOf(
                                    memberships,
                                    r.repositoryId,
                                    env.environmentId,
                                )}
                                canManage={canManage}
                                onRemove={setRemoving}
                            />
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>

            {sharedQuiet.map((r) => {
                const others = otherEnvironmentsOf(
                    memberships,
                    r.repositoryId,
                    env.environmentId,
                ).map((o) => o.name);
                return (
                    <p
                        key={r.repositoryId}
                        className="text-text-tertiary text-xs">
                        {repositoryLabel(r)} also belongs to{" "}
                        {namesInWords(others)}. Its pull requests run there;
                        turn “Runs its PRs” on here to test them against this
                        system too (one more Run per pull request).
                    </p>
                );
            })}

            <p className="text-text-tertiary text-xs">
                <StatusChip tone="neutral" className="mr-1.5">
                    {repositories.length} of {MAX_ENVIRONMENT_REPOSITORIES}
                </StatusChip>
                Only the primary&apos;s setup file runs. A setup file in another
                repository is read by Kody as a hint, not run.
            </p>

            {adding && (
                <AddRepositoryDialog
                    env={env}
                    open={adding}
                    onOpenChange={setAdding}
                    candidates={candidates}
                />
            )}
            <RemoveRepositoryDialog
                env={env}
                repository={removing}
                onClose={() => setRemoving(undefined)}
            />
        </section>
    );
};

/** The memberships of the list, with this environment as the page has it (fresher). */
const membershipsByRepositoryOf = (
    environments: readonly RuntimeEnvironment[],
    env: RuntimeEnvironment,
) =>
    membershipsByRepository([
        ...environments.filter((e) => e.environmentId !== env.environmentId),
        env,
    ]);
