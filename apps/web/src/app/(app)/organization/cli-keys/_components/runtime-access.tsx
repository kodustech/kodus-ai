"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
import { Input } from "@components/ui/input";
import { Switch } from "@components/ui/switch";
import type { RepositoryMinimal } from "@services/codeManagement/types";

// A team key reads Kody Runtime Runs, and opens or fixes environments, only
// of the repositories listed on it (ADR-057): a capability alone reaches
// none. The list must be a subset of the repositories configured for the
// team, which is what the API checks.

export type RuntimeAccessDraft = {
    runsRead: boolean;
    /** env:exec — open an environment over /mcp/env and run commands in it. */
    envExec?: boolean;
    /** env:fix — apply a catalog fix to a blocked environment. */
    envFix?: boolean;
    /** findings:submit — submit external findings; executable probes also need env:exec. */
    findingsSubmit?: boolean;
    repositoryIds: string[];
};

/** Any Runtime capability makes the repository list matter. */
export const usesRuntimeRepositories = (draft: RuntimeAccessDraft) =>
    draft.runsRead ||
    !!draft.envExec ||
    !!draft.envFix ||
    !!draft.findingsSubmit;

const ENV_SWITCHES = [
    {
        field: "findingsSubmit",
        label: "Submit findings from external agents",
        description:
            "Lets an external agent submit findings and read their verification tasks over A2A. Executable probes also need the environment command permission below. Submitted evidence alone is never verified.",
    },
    {
        field: "envExec",
        label: "Run commands in Kody Runtime environments",
        description:
            "Lets your agent open an environment over /mcp/env and run commands in it (env_up, env_exec). Every command is audited and limited per hour.",
    },
    {
        field: "envFix",
        label: "Fix blocked Kody Runtime environments",
        description:
            "Lets kodus env fix and env_fix apply a fix Kodus suggests: a recipe change opens a pull request. Approving an outbound host stays with an admin.",
    },
] as const;

/** The ids to send: the chosen ones the team still has, in the team's order. */
export const repositoriesToSave = (
    chosen: string[],
    teamRepositories: Pick<RepositoryMinimal, "id">[],
) => {
    const wanted = new Set(chosen);
    return teamRepositories
        .map((r) => String(r.id))
        .filter((id) => wanted.has(id));
};

export const sameRepositories = (a: string[] = [], b: string[] = []) =>
    a.length === b.length &&
    [...a].sort().join("\n") === [...b].sort().join("\n");

const SEARCH_FROM = 8;

export const RuntimeAccess = ({
    repositories,
    isLoading,
    isError,
    draft,
    onChange,
    disabled,
}: {
    /** The repositories configured for the key's team. */
    repositories: RepositoryMinimal[];
    isLoading?: boolean;
    isError?: boolean;
    draft: RuntimeAccessDraft;
    onChange: (draft: RuntimeAccessDraft) => void;
    disabled?: boolean;
}) => {
    const [query, setQuery] = useState("");

    const chosen = new Set(draft.repositoryIds);
    const known = new Set(repositories.map((r) => String(r.id)));
    const stale = draft.repositoryIds.filter((id) => !known.has(id));
    const reached = draft.repositoryIds.length - stale.length;
    const shown = query
        ? repositories.filter((r) =>
              (r.full_name || r.name)
                  .toLowerCase()
                  .includes(query.trim().toLowerCase()),
          )
        : repositories;

    const toggle = (id: string, on: boolean) =>
        onChange({
            ...draft,
            repositoryIds: on
                ? [...draft.repositoryIds, id]
                : draft.repositoryIds.filter((r) => r !== id),
        });

    return (
        <div className="bg-card-lv2 border-card-lv1 flex flex-col gap-4 rounded-xl border p-4">
            <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                    <span className="text-sm font-semibold">
                        Read Kody Runtime Runs
                    </span>
                    <span className="text-text-secondary text-sm">
                        Lets <code>kodus runs</code> read the Runs, their
                        evidence and their live stream, for the repositories
                        picked below only.
                    </span>
                </div>
                <Switch
                    aria-label="Read Kody Runtime Runs"
                    checked={draft.runsRead}
                    onCheckedChange={(runsRead) =>
                        onChange({ ...draft, runsRead })
                    }
                    disabled={disabled}
                />
            </div>

            {ENV_SWITCHES.map(({ field, label, description }) => (
                <div
                    key={field}
                    className="flex items-start justify-between gap-4">
                    <div className="flex flex-col gap-1">
                        <span className="text-sm font-semibold">{label}</span>
                        <span className="text-text-secondary text-sm">
                            {description}
                        </span>
                    </div>
                    <Switch
                        aria-label={label}
                        checked={!!draft[field]}
                        onCheckedChange={(on) =>
                            onChange({ ...draft, [field]: on })
                        }
                        disabled={disabled}
                    />
                </div>
            ))}

            {usesRuntimeRepositories(draft) && (
                <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-text-secondary text-sm tabular-nums">
                            {reached} of {repositories.length} repositories
                        </span>
                        <div className="flex gap-2">
                            <Button
                                size="xs"
                                variant="helper"
                                disabled={disabled || repositories.length === 0}
                                onClick={() =>
                                    onChange({
                                        ...draft,
                                        repositoryIds: repositories.map((r) =>
                                            String(r.id),
                                        ),
                                    })
                                }>
                                Select all
                            </Button>
                            <Button
                                size="xs"
                                variant="helper"
                                disabled={disabled || reached === 0}
                                onClick={() =>
                                    onChange({ ...draft, repositoryIds: [] })
                                }>
                                Clear
                            </Button>
                        </div>
                    </div>

                    {repositories.length >= SEARCH_FROM && (
                        <Input
                            aria-label="Filter repositories"
                            placeholder="Filter repositories"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                        />
                    )}

                    {isLoading ? (
                        <span className="text-text-secondary text-sm">
                            Loading the team's repositories…
                        </span>
                    ) : isError ? (
                        <span className="text-danger text-sm">
                            Couldn't load the team's repositories. Close and
                            open this again.
                        </span>
                    ) : repositories.length === 0 ? (
                        <span className="text-text-secondary text-sm">
                            This team has no repositories configured yet. Add
                            them in the Git settings first.
                        </span>
                    ) : (
                        <ul
                            aria-label="Repositories the key reaches"
                            className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                            {shown.map((repo) => {
                                const id = String(repo.id);
                                const inputId = `cli-key-repo-${id}`;
                                return (
                                    <li
                                        key={id}
                                        className="flex items-center gap-3 py-1">
                                        <Checkbox
                                            id={inputId}
                                            size="icon-xs"
                                            checked={chosen.has(id)}
                                            disabled={disabled}
                                            onCheckedChange={(on) =>
                                                toggle(id, on === true)
                                            }
                                        />
                                        <label
                                            htmlFor={inputId}
                                            className="cursor-pointer text-sm">
                                            {repo.full_name || repo.name}
                                        </label>
                                    </li>
                                );
                            })}
                        </ul>
                    )}

                    {reached === 0 && repositories.length > 0 && (
                        <span className="text-warning text-sm">
                            {draft.runsRead
                                ? "With no repository picked, the key reads no Runs."
                                : draft.findingsSubmit
                                  ? "With no repository picked, the key submits no findings."
                                  : "With no repository picked, the key reaches no environment."}
                        </span>
                    )}
                    {stale.length > 0 && !isLoading && !isError && (
                        <span className="text-text-secondary text-sm">
                            {stale.length === 1
                                ? "1 repository on this key is"
                                : `${stale.length} repositories on this key are`}{" "}
                            no longer configured for the team and will be
                            removed when you save.
                        </span>
                    )}
                </div>
            )}
        </div>
    );
};
