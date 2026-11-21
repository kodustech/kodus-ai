import type {
    EnvironmentRepository,
    RuntimeEnvironment,
    RunWorkspaceRef,
} from "../contracts";
import { shortRepositoryName, shortSha } from "../format";
import { baseVersionLabel } from "./base-version";
import { runtimeErrorMessage } from "./errors";

// An environment as a system of repositories (docs/runtime/multi-repo.md): the chips of the list, the
// Repositories section, the Add repository dialog and the "What ran on each
// side" table of a Run. Pure and tested.

/**
 * A repository's directory in the workspace: lower case, no separator, at
 * most 63 characters. The web's copy of REPOSITORY_ALIAS_PATTERN
 * (libs/runtime/contracts/workspace.ts), pinned by a parity spec: the web's
 * isolated build takes no runtime code.
 */
export const REPOSITORY_ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
/** At most this many repositories in one environment (MAX_WORKSPACE_REPOSITORIES). */
export const MAX_ENVIRONMENT_REPOSITORIES = 10;
const FALLBACK_REPOSITORY_ALIAS = "repo";

/** The alias the API gives a repository added without one (repositoryAliasOf). */
export const defaultRepositoryAlias = (name: string): string => {
    const alias = name
        .slice(name.lastIndexOf("/") + 1)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^[^a-z0-9]+/, "")
        .slice(0, 63);
    return REPOSITORY_ALIAS_PATTERN.test(alias)
        ? alias
        : FALLBACK_REPOSITORY_ALIAS;
};

/** Why an alias typed in the dialog cannot be sent, or undefined. */
export const aliasProblem = (
    alias: string,
    taken: ReadonlyArray<{ alias: string; name: string }>,
): string | undefined => {
    if (!alias) return "Give it a folder name.";
    if (!REPOSITORY_ALIAS_PATTERN.test(alias))
        return "Use lower case letters, digits, '.', '_' or '-', starting with a letter or digit (at most 63).";
    const other = taken.find((t) => t.alias === alias);
    if (other) return `${other.name} already uses this folder.`;
    return undefined;
};

/**
 * Every repository of the environment, the primary first. An API that does
 * not list them yet (or an environment only Runs know) stands in with the
 * primary alone, so a single-repository environment reads as one chip.
 */
export const environmentRepositoriesOf = (
    env: Pick<
        RuntimeEnvironment,
        "repositoryId" | "repositoryName" | "repositories"
    >,
): EnvironmentRepository[] => {
    const listed = env.repositories ?? [];
    if (!listed.length) {
        const name = env.repositoryName ?? env.repositoryId;
        return [
            {
                repositoryId: env.repositoryId,
                repositoryName: name,
                fullName: name,
                alias: defaultRepositoryAlias(name),
                role: "primary",
                triggers: true,
                pairBranches: false,
            },
        ];
    }
    return [
        ...listed.filter((r) => r.role === "primary"),
        ...listed.filter((r) => r.role !== "primary"),
    ];
};

/**
 * The repositories an action on the environment touches (set up, simulate):
 * the API checks the caller on each of them, so the screen does too.
 */
export const repositoryIdsOfEnvironment = (
    env: Pick<RuntimeEnvironment, "repositoryId"> &
        Partial<Pick<RuntimeEnvironment, "repositoryName" | "repositories">>,
): string[] => environmentRepositoriesOf(env).map((r) => r.repositoryId);

/** The repositories an action on a Run touches (run again, approve, mark intended): its own and the ones it booted with. */
export const repositoryIdsOfRun = (run: {
    repositoryId: string;
    workspace?: ReadonlyArray<Pick<RunWorkspaceRef, "repositoryId">>;
}): string[] => [
    ...new Set([
        run.repositoryId,
        ...(run.workspace ?? []).map((w) => w.repositoryId),
    ]),
];

/** The name a repository shows by: its short name, or the full one when short is ambiguous. */
export const repositoryLabel = (
    r: Pick<EnvironmentRepository, "repositoryName" | "fullName">,
) =>
    shortRepositoryName(r.fullName || r.repositoryName) ??
    r.fullName ??
    r.repositoryName;

/** An environment's name: its primary repository's. */
export const environmentName = (
    env: Pick<RuntimeEnvironment, "repositoryId" | "repositoryName">,
) => shortRepositoryName(env.repositoryName) ?? env.repositoryId;

/** One environment a repository is part of. */
export type RepositoryMembership = {
    environmentId: string;
    /** The environment's name (its primary's short name). */
    name: string;
    role: EnvironmentRepository["role"];
    triggers: boolean;
};

/**
 * Every environment each repository is part of, from the environments list
 * already on screen (no request per repository): the one it is the primary
 * of first.
 */
export const membershipsByRepository = (
    environments: ReadonlyArray<RuntimeEnvironment>,
): Map<string, RepositoryMembership[]> => {
    const out = new Map<string, RepositoryMembership[]>();
    for (const env of environments) {
        for (const r of environmentRepositoriesOf(env)) {
            const list = out.get(r.repositoryId) ?? [];
            list.push({
                environmentId: env.environmentId,
                name: environmentName(env),
                role: r.role,
                triggers: r.triggers,
            });
            out.set(r.repositoryId, list);
        }
    }
    for (const list of out.values())
        list.sort(
            (a, b) =>
                Number(b.role === "primary") - Number(a.role === "primary") ||
                a.name.localeCompare(b.name),
        );
    return out;
};

/** The other environments a repository is part of, besides this one. */
export const otherEnvironmentsOf = (
    memberships: Map<string, RepositoryMembership[]>,
    repositoryId: string,
    environmentId: string,
): RepositoryMembership[] =>
    (memberships.get(repositoryId) ?? []).filter(
        (m) => m.environmentId !== environmentId,
    );

/**
 * What a repository's own Runtime settings say when it is a member of
 * another environment: its PRs run there by that environment's settings
 * (the primary's), and its own mode governs only the environment it is the
 * primary of, which turning it on creates when there is none yet. Undefined
 * for a repository that is a member nowhere.
 */
export const ownModeNote = (
    memberships: readonly RepositoryMembership[] | undefined,
): string | undefined => {
    const elsewhere = (memberships ?? []).filter((m) => m.role === "member");
    if (!elsewhere.length) return undefined;
    const running = elsewhere.filter((m) => m.triggers);
    const where = running.length
        ? `Its pull requests run in the environment of ${namesInWords(running.map((m) => m.name))}, by that environment's settings.`
        : `It is part of the environment of ${namesInWords(elsewhere.map((m) => m.name))}.`;
    const own = (memberships ?? []).some((m) => m.role === "primary")
        ? "The mode here governs only its own environment."
        : "The mode here is for an environment of its own: turning it on creates one, with its own setup file and machines.";
    return `${where} ${own}`;
};

/** "Checkout", "Checkout and Kodus platform", "Checkout, Billing and 2 more". */
export const namesInWords = (names: readonly string[], max = 2): string => {
    if (names.length <= 1) return names[0] ?? "";
    if (names.length <= max + 1)
        return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
};

/** A connected repository the Add repository dialog offers. */
export type AddableRepository = {
    repositoryId: string;
    name: string;
    /** The alias the API would give it. */
    defaultAlias: string;
    /** The other environments it is already part of. */
    alsoIn: string[];
};

/**
 * The connected repositories that can join this environment: not already in
 * it, sorted by name. Each says the other systems it is part of, since a
 * membership there doubles the Runs of its PRs when it triggers here too.
 */
export const addableRepositories = (
    connected: ReadonlyArray<{ repositoryId: string; repositoryName?: string }>,
    env: Pick<
        RuntimeEnvironment,
        "environmentId" | "repositoryId" | "repositoryName" | "repositories"
    >,
    memberships: Map<string, RepositoryMembership[]>,
): AddableRepository[] => {
    const inside = new Set(
        environmentRepositoriesOf(env).map((r) => r.repositoryId),
    );
    return connected
        .filter((r) => !inside.has(r.repositoryId))
        .map((r) => {
            const name = r.repositoryName ?? r.repositoryId;
            return {
                repositoryId: r.repositoryId,
                name,
                defaultAlias: defaultRepositoryAlias(name),
                alsoIn: otherEnvironmentsOf(
                    memberships,
                    r.repositoryId,
                    env.environmentId,
                ).map((m) => m.name),
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
};

/** Whether the environment can take one more repository. */
export const isEnvironmentFull = (
    env: Pick<
        RuntimeEnvironment,
        "repositoryId" | "repositoryName" | "repositories"
    >,
) => environmentRepositoriesOf(env).length >= MAX_ENVIRONMENT_REPOSITORIES;

/**
 * What a refused change of the repositories says, inline: the API's own
 * sentence for a conflict (alias taken, the primary's alias, the limit) and
 * a line per status otherwise.
 */
/**
 * The repositories after an add, a change or a removal: the answer's list,
 * with the commit of the last setup kept from what the page had (the change
 * answers do not carry it; only the environment read does).
 */
export const withRepositoriesAnswer = (
    before: readonly EnvironmentRepository[] | undefined,
    answered: readonly EnvironmentRepository[],
): EnvironmentRepository[] => {
    const sha = new Map(
        (before ?? []).map((r) => [r.repositoryId, r.lastSetupSha]),
    );
    return answered.map((r) => {
        const kept = r.lastSetupSha ?? sha.get(r.repositoryId);
        return kept ? { ...r, lastSetupSha: kept } : r;
    });
};

export const repositoryChangeError = (error: unknown) =>
    runtimeErrorMessage(error, {
        fallback: "Kodus could not save the change. Try again in a moment.",
        403: "Only the owner of the organization can change the repositories of an environment, and only with access to every one of them.",
    });

/** Who may change the repositories, and why not when not. */
export const MANAGE_REPOSITORIES_REASON =
    "Only the owner of the organization can add, remove or change repositories here.";

// ---- A Run's workspace: what ran on each side ----

/** One row of "What ran on each side". */
export type WorkspaceSideRow = {
    repositoryId: string;
    /** The repository's name when the environment still lists it, else its folder. */
    name: string;
    alias: string;
    base: { sha: string; label: string };
    pr: { sha: string; label: string };
    /** Why the PR side is that commit, in a sentence. */
    why: string;
    source: RunWorkspaceRef["source"];
    /** Both sides booted the same commit. */
    same: boolean;
};

const clock = (at: string | undefined) => {
    if (!at) return undefined;
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return undefined;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * The commit of every repository on each side of a multi-repository Run, the
 * PR's own repository first. Empty for a Run of one repository (no
 * workspace): the page shows nothing new then.
 */
export const workspaceSideRows = (
    run: {
        workspace?: RunWorkspaceRef[];
        prNumber: number;
        requestedAt?: string;
        baseBranch?: string;
    },
    names: ReadonlyMap<string, string> = new Map(),
): WorkspaceSideRow[] => {
    const list = run.workspace ?? [];
    if (!list.length) return [];
    const at = clock(run.requestedAt);
    const fixedAt = at
        ? `, fixed at ${at} when the Run started`
        : ", fixed when the Run started";
    const order = { pull_request: 0, paired: 1, default_branch: 2 } as const;
    return [...list]
        .sort(
            (a, b) =>
                (order[a.source] ?? 3) - (order[b.source] ?? 3) ||
                a.alias.localeCompare(b.alias),
        )
        .map((w): WorkspaceSideRow => {
            const name = names.get(w.repositoryId) ?? w.alias;
            const same = w.baseSha.toLowerCase() === w.headSha.toLowerCase();
            switch (w.source) {
                case "pull_request":
                    return {
                        repositoryId: w.repositoryId,
                        name,
                        alias: w.alias,
                        source: w.source,
                        same,
                        base: {
                            sha: shortSha(w.baseSha),
                            label: baseVersionLabel(run),
                        },
                        pr: {
                            sha: shortSha(w.headSha),
                            label: `#${run.prNumber}`,
                        },
                        why: "The pull request",
                    };
                case "paired":
                    return {
                        repositoryId: w.repositoryId,
                        name,
                        alias: w.alias,
                        source: w.source,
                        same,
                        base: { sha: shortSha(w.baseSha), label: "base" },
                        pr: {
                            sha: shortSha(w.headSha),
                            label:
                                w.pairedPrNumber !== undefined
                                    ? `#${w.pairedPrNumber}`
                                    : (w.branch ?? "paired"),
                        },
                        why:
                            w.pairedPrNumber !== undefined
                                ? `Paired with #${w.pairedPrNumber}${w.branch ? `, its pull request from ${w.branch}` : ", its pull request from the same branch name"}`
                                : "Paired: its pull request from the same branch name",
                    };
                default: {
                    const branch = w.branch ?? "default branch";
                    return {
                        repositoryId: w.repositoryId,
                        name,
                        alias: w.alias,
                        source: w.source,
                        same,
                        base: { sha: shortSha(w.baseSha), label: branch },
                        pr: { sha: shortSha(w.headSha), label: branch },
                        why: `Default branch${fixedAt}`,
                    };
                }
            }
        });
};

/** The branch of the Run's own pull request, when its workspace entry names it. */
export const pullRequestBranchOf = (workspace: RunWorkspaceRef[] | undefined) =>
    workspace?.find((w) => w.source === "pull_request")?.branch;

/** The other repositories a Run booted with, for the PR card's "Ran with". */
export type RanWithRepository = {
    alias: string;
    /** The commit its PR side booted. */
    sha: string;
    /** Where that commit came from, in a word or two: "main", "#77". */
    from: string;
};

/**
 * The repositories a multi-repository Run booted beside the PR's own, with
 * the commit of the PR side; a Run without a workspace has none.
 */
export const ranWithOf = (
    run: { workspace?: RunWorkspaceRef[] } | null | undefined,
): RanWithRepository[] =>
    (run?.workspace ?? [])
        .filter((w) => w.source !== "pull_request")
        .map((w) => ({
            alias: w.alias,
            sha: w.headSha,
            from:
                w.source === "paired"
                    ? w.pairedPrNumber !== undefined
                        ? `#${w.pairedPrNumber}`
                        : (w.branch ?? "paired")
                    : (w.branch ?? "default branch"),
        }));
