"use client";

import { useState } from "react";
import NextLink from "next/link";
import { SetupEnvironmentButton } from "@components/runtime/environment-setup";
import { RelativeTime } from "@components/runtime/relative-time";
import { StatusChip } from "@components/runtime/status-chip";
import { Input } from "@components/ui/input";
import {
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableHeader,
    TableRow,
} from "@components/ui/table";
import type { RuntimeEnvironment } from "@services/runtime/contracts";
import {
    formatDurationMs,
    shortRepositoryName,
    shortSha,
} from "@services/runtime/format";
import { cellOwnerLabel } from "@services/runtime/labels";
import {
    currentSetup,
    ENVIRONMENT_SECTION,
    environmentBootMs,
    environmentHref,
    environmentStatus,
    isNotSetUp,
    isRunOnlyEnvironment,
    managedEnvironmentOf,
} from "@services/runtime/model/environment";
import {
    environmentRepositoriesOf,
    membershipsByRepository,
    namesInWords,
    repositoryLabel,
    type RepositoryMembership,
} from "@services/runtime/model/environment-repositories";
import { SearchIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

import { SetUpRepository } from "./new-environment";

type Filter = "all" | "not_set_up" | "attention";

/**
 * A row: an environment (named after its primary repository, with every
 * repository it boots), or a connected repository that is the primary of
 * none: still without an environment, or a member of other ones.
 */
type Row = {
    repositoryId: string;
    name: string;
    env?: RuntimeEnvironment;
    /** Every repository name the search matches. */
    names: string[];
    /** For a repository without its own environment: the ones it is part of. */
    partOf?: RepositoryMembership[];
};

const ATTENTION_TONES = new Set(["danger", "warning", "alert"]);

/** What needs the dev first: failures, then warnings, setting up, ready, and last what was never set up. */
const ORDER: Record<string, number> = {
    danger: 0,
    alert: 1,
    warning: 2,
    info: 3,
    success: 4,
};
const rank = (r: Row) =>
    r.partOf?.length
        ? 8
        : !r.env || isNotSetUp(r.env)
          ? 9
          : (ORDER[environmentStatus(r.env).tone] ?? 5);

/**
 * One list for every connected repository: those with an environment show its
 * state and "Set up again", those without show "Not set up" and "Set up" on
 * their own row. Setting one up turns its row into an environment row once the
 * list refreshes; nothing else on the page lists repositories.
 */
export const EnvironmentsTable = ({
    environments,
    repositories,
    canCreate,
}: {
    environments: readonly RuntimeEnvironment[];
    /** The connected repositories (Runtime settings); empty while unknown. */
    repositories: ReadonlyArray<{
        repositoryId: string;
        repositoryName?: string;
    }>;
    canCreate: boolean;
}) => {
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<Filter>("all");

    // A repository whose only environment is known from earlier Runs keeps its
    // own row with "Set up": that environment cannot be set up.
    const withEnv = new Set(
        environments
            .filter((e) => !isRunOnlyEnvironment(e))
            .map((e) => e.repositoryId),
    );
    const memberships = membershipsByRepository(environments);
    const unsorted: Row[] = [
        ...environments.map((env) => ({
            repositoryId: env.repositoryId,
            name: env.repositoryName ?? env.repositoryId,
            env,
            names: environmentRepositoriesOf(env).flatMap((r) => [
                r.fullName,
                r.repositoryName,
            ]),
        })),
        ...repositories
            .filter((r) => !withEnv.has(r.repositoryId))
            .map((r) => {
                const name = r.repositoryName ?? r.repositoryId;
                const partOf = memberships.get(r.repositoryId) ?? [];
                return {
                    repositoryId: r.repositoryId,
                    name,
                    names: [name],
                    ...(partOf.length ? { partOf } : {}),
                };
            }),
    ];
    const rows = unsorted.sort(
        (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
    );
    // Two repositories with the same short name (two owners, two Git
    // integrations) show their full name, else the rows look like duplicates.
    const shortCount = new Map<string, number>();
    for (const r of rows) {
        const k = shortRepositoryName(r.name) ?? r.name;
        shortCount.set(k, (shortCount.get(k) ?? 0) + 1);
    }
    const label = (name: string) => {
        const short = shortRepositoryName(name) ?? name;
        return (shortCount.get(short) ?? 0) > 1 ? name : short;
    };
    const notSetUp = (r: Row) =>
        !r.partOf?.length &&
        !isRunOnlyEnvironment(r.env) &&
        (!r.env || isNotSetUp(r.env));
    const needsAttention = (r: Row) =>
        !!r.env && ATTENTION_TONES.has(environmentStatus(r.env).tone);
    const counts = {
        all: rows.length,
        not_set_up: rows.filter(notSetUp).length,
        attention: rows.filter(needsAttention).length,
    };
    const term = search.trim().toLowerCase();
    const shown = rows.filter(
        (r) =>
            (filter === "all" ||
                (filter === "not_set_up" && notSetUp(r)) ||
                (filter === "attention" && needsAttention(r))) &&
            (!term || r.names.some((n) => n.toLowerCase().includes(term))),
    );
    const filters: Array<[Filter, string]> = [
        ["all", `All · ${counts.all}`],
        ["not_set_up", `Not set up · ${counts.not_set_up}`],
        ["attention", `Needs attention · ${counts.attention}`],
    ];

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
                <div className="w-full max-w-sm">
                    <Input
                        size="md"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search environments or repositories..."
                        aria-label="Search repositories"
                        leftIcon={<SearchIcon />}
                    />
                </div>
                <div
                    role="group"
                    aria-label="Show"
                    className="bg-card-lv2 flex rounded-lg p-0.5">
                    {filters.map(([value, text]) => (
                        <button
                            key={value}
                            type="button"
                            aria-pressed={filter === value}
                            onClick={() => setFilter(value)}
                            className={cn(
                                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                                filter === value
                                    ? "bg-card-lv3 text-text-primary"
                                    : "text-text-secondary hover:text-text-primary",
                            )}>
                            {text}
                        </button>
                    ))}
                </div>
            </div>

            <TableContainer>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Environment</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Boot</TableHead>
                            <TableHead>Current setup</TableHead>
                            <TableHead>Runs on</TableHead>
                            <TableHead>
                                <span className="sr-only">Actions</span>
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {shown.length === 0 && (
                            <TableRow>
                                <TableCell
                                    colSpan={6}
                                    className="text-text-secondary py-6 text-center text-sm">
                                    {term
                                        ? `No repository matches “${search.trim()}”.`
                                        : filter === "not_set_up"
                                          ? "Every connected repository is set up."
                                          : "Nothing needs attention."}
                                </TableCell>
                            </TableRow>
                        )}
                        {shown.map((row) =>
                            row.env ? (
                                <EnvironmentRow
                                    key={row.env.environmentId}
                                    env={row.env}
                                    organization={environments}
                                    name={label(row.name)}
                                    managed={
                                        isRunOnlyEnvironment(row.env)
                                            ? managedEnvironmentOf(
                                                  row.env,
                                                  environments,
                                              )
                                            : undefined
                                    }
                                />
                            ) : row.partOf ? (
                                <MemberRow
                                    key={row.repositoryId}
                                    name={label(row.name)}
                                    fullName={row.name}
                                    partOf={row.partOf}
                                />
                            ) : (
                                <TableRow key={row.repositoryId}>
                                    <TableCell>
                                        <span
                                            className="font-medium"
                                            title={row.name}>
                                            {label(row.name)}
                                        </span>
                                    </TableCell>
                                    <TableCell>
                                        <span className="flex flex-col gap-0.5">
                                            <StatusChip tone="neutral">
                                                Not set up
                                            </StatusChip>
                                            <span className="text-text-tertiary text-xs">
                                                Kody works out how to build and
                                                start it.
                                            </span>
                                        </span>
                                    </TableCell>
                                    <TableCell className="text-text-tertiary">
                                        —
                                    </TableCell>
                                    <TableCell className="text-text-tertiary">
                                        —
                                    </TableCell>
                                    <TableCell className="text-text-tertiary">
                                        —
                                    </TableCell>
                                    <TableCell>
                                        {canCreate && (
                                            <SetUpRepository
                                                repositoryId={row.repositoryId}
                                                name={row.name}
                                                onStarted={() => undefined}
                                                iconOnly
                                            />
                                        )}
                                    </TableCell>
                                </TableRow>
                            ),
                        )}
                    </TableBody>
                </Table>
            </TableContainer>
        </div>
    );
};

/**
 * A connected repository that is the primary of no environment but a member
 * of one or more: it is set up, as part of those systems.
 */
const MemberRow = ({
    name,
    fullName,
    partOf,
}: {
    name: string;
    fullName: string;
    partOf: RepositoryMembership[];
}) => {
    const runsThere = partOf.filter((m) => m.triggers);
    return (
        <TableRow>
            <TableCell>
                <span className="font-medium" title={fullName}>
                    {name}
                </span>
            </TableCell>
            <TableCell>
                <span className="flex flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-1 text-xs">
                        <StatusChip tone="neutral">Part of</StatusChip>
                        {partOf.map((m, i) => (
                            <span key={m.environmentId}>
                                <NextLink
                                    href={environmentHref(
                                        m.environmentId,
                                        ENVIRONMENT_SECTION.repositories,
                                    )}
                                    className="text-text-primary font-medium hover:underline">
                                    {m.name}
                                </NextLink>
                                {i < partOf.length - 1 ? "," : ""}
                            </span>
                        ))}
                    </span>
                    <span className="text-text-tertiary text-xs">
                        {runsThere.length === 0
                            ? "It boots with them; its own pull requests start no Run."
                            : `Its pull requests run in ${namesInWords(runsThere.map((m) => m.name))}.`}
                    </span>
                </span>
            </TableCell>
            <TableCell className="text-text-tertiary">—</TableCell>
            <TableCell className="text-text-tertiary">—</TableCell>
            <TableCell className="text-text-tertiary">—</TableCell>
            <TableCell />
        </TableRow>
    );
};

/** The repositories of an environment as chips, the primary first. */
const RepositoryChips = ({ env }: { env: RuntimeEnvironment }) => {
    const repositories = environmentRepositoriesOf(env);
    return (
        <ul
            aria-label={`Repositories of ${shortRepositoryName(env.repositoryName) ?? env.repositoryId}`}
            className="flex flex-wrap gap-1">
            {repositories.map((r) => (
                <li
                    key={r.repositoryId}
                    title={
                        r.role === "primary"
                            ? `${r.fullName} · primary, holds the setup file`
                            : r.fullName
                    }
                    className={cn(
                        "text-2xs rounded-md px-1.5 py-0.5 font-mono",
                        r.role === "primary"
                            ? "bg-card-lv3 text-text-primary"
                            : "bg-card-lv2 text-text-secondary",
                    )}>
                    {repositoryLabel(r)}
                </li>
            ))}
        </ul>
    );
};

const EnvironmentRow = ({
    env,
    organization,
    name,
    managed,
}: {
    env: RuntimeEnvironment;
    /** Every environment on the page: a setup waiting behind another of the organization says so. */
    organization: readonly RuntimeEnvironment[];
    name: string;
    /** For one known only from earlier Runs: its repository's managed environment. */
    managed?: RuntimeEnvironment;
}) => {
    const runOnly = isRunOnlyEnvironment(env);
    const status = environmentStatus(env, organization);
    const boot = environmentBootMs(env);
    const current = currentSetup(env);
    return (
        <TableRow>
            <TableCell>
                <span className="flex flex-col gap-1">
                    <NextLink
                        href={environmentHref(env.environmentId)}
                        title={env.repositoryName}
                        className="text-text-primary hover:text-primary-light w-fit font-medium transition-colors hover:underline">
                        {name}
                    </NextLink>
                    <RepositoryChips env={env} />
                </span>
            </TableCell>
            <TableCell>
                <span className="flex flex-col gap-0.5">
                    <StatusChip tone={status.tone}>{status.label}</StatusChip>
                    {status.detail && (
                        <span
                            className="text-text-tertiary line-clamp-2 max-w-80 text-xs"
                            title={status.detail}>
                            {status.detail}
                        </span>
                    )}
                    {managed && (
                        <NextLink
                            href={environmentHref(managed.environmentId)}
                            className="text-text-secondary hover:text-primary-light text-xs transition-colors hover:underline">
                            Open its environment
                        </NextLink>
                    )}
                </span>
            </TableCell>
            <TableCell className="font-mono text-xs">
                {formatDurationMs(boot)}
            </TableCell>
            <TableCell className="text-sm">
                {current?.sha ? (
                    <span>
                        <span className="font-mono">
                            {shortSha(current.sha)}
                        </span>
                        {" · "}
                        <RelativeTime
                            at={current.finishedAt ?? current.updatedAt}
                        />
                    </span>
                ) : env.setup && env.state === "blocked" ? (
                    // There is no setup Runs boot from, but there was a try.
                    <span className="text-text-tertiary">
                        Last try failed ·{" "}
                        <RelativeTime
                            at={env.setup.finishedAt ?? env.setup.updatedAt}
                        />
                    </span>
                ) : (
                    <span className="text-text-tertiary">None yet</span>
                )}
            </TableCell>
            <TableCell className="text-sm">
                {cellOwnerLabel(env.cellOwner)}
            </TableCell>
            <TableCell>
                {!runOnly && (
                    <SetupEnvironmentButton
                        env={env}
                        iconOnly
                        name={env.repositoryName ?? name}
                    />
                )}
            </TableCell>
        </TableRow>
    );
};
