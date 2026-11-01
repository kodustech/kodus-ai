"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import {
    followedBy,
    KNOWLEDGE_LIMIT_LABELS,
    knowledgeChoices,
    knowledgeItemFromPath,
    knowledgeKey,
    knowledgeTargetKey,
    mentionedButNotFollowed,
    sameKnowledge,
    setAgentKnowledge,
    skillFolderName,
} from "@services/custom-agents/drafts";
import { useResolveCustomAgent } from "@services/custom-agents/hooks";
import type {
    CustomAgentResolveReport,
    KnowledgeCandidate,
    KnowledgeItem,
    KnowledgeItemReport,
    KnowledgeSource,
} from "@services/custom-agents/types";
import {
    BookMarkedIcon,
    BookOpenIcon,
    LockIcon,
    PlusIcon,
    SparklesIcon,
    XIcon,
} from "lucide-react";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "src/core/components/ui/command";
import { cn } from "src/core/utils/components";

import { Chip, Choice, Field } from "./field";

export const KnowledgeStatusChips = ({
    report,
}: {
    report?: KnowledgeItemReport;
}) => {
    if (!report) return null;
    const errors = report.issues.filter((issue) => issue.severity === "error");
    const warnings = report.issues.filter(
        (issue) => issue.severity === "warning",
    );
    return (
        <>
            {/* The editor reads the default branch; a review reads each pull
                request's target branch, which may have the file. */}
            {!report.found && (
                <Chip tone="warning">Not on the default branch</Chip>
            )}
            {errors.length > 0 && (
                <Chip tone="danger">
                    {errors.length} {errors.length === 1 ? "error" : "errors"}
                </Chip>
            )}
            {warnings.length > 0 && (
                <Chip tone="warning">
                    {warnings.length}{" "}
                    {warnings.length === 1 ? "warning" : "warnings"}
                </Chip>
            )}
            {typeof report.tokens === "number" && (
                <Chip>{report.tokens.toLocaleString()} tokens</Chip>
            )}
            {report.kodyRuleSource && (
                <Chip tone="warning">Also a Kody Rules source</Chip>
            )}
        </>
    );
};

/**
 * What each warning or error says. The chips only count them, which left a
 * "1 warning" badge with nothing to read (a truncated skill, for one).
 */
export const KnowledgeIssues = ({
    report,
}: {
    report?: KnowledgeItemReport;
}) => {
    if (!report?.issues.length) return null;
    return (
        <ul className="flex flex-col gap-0.5">
            {report.issues.map((issue) => (
                <li
                    key={`${issue.severity}:${issue.message}`}
                    className={cn(
                        "text-xs",
                        issue.severity === "error"
                            ? "text-danger"
                            : "text-warning",
                    )}>
                    {issue.message}
                </li>
            ))}
        </ul>
    );
};

/** Where a skill or doc of another repository comes from, on its item. */
export const KnowledgeSourceChip = ({
    item,
    branch,
}: {
    item: Pick<KnowledgeItem, "repository" | "ref">;
    /** The branch it was checked on, when the report says. */
    branch?: string;
}) => {
    if (!item.repository) return null;
    const at = item.ref ? `${item.ref} (pinned)` : (branch ?? "default branch");
    return (
        <Chip>
            <BookMarkedIcon aria-hidden className="mr-1 size-3 shrink-0" />
            {item.repository} · {at}
        </Chip>
    );
};

/** The source tab for the reviewed repository. */
const THIS_REPOSITORY = "";
/** The tab that opens the list of every connected repository. */
const OTHER_REPOSITORY = "__other__";
/** Linked repositories shown as their own tab; the rest are under "Other". */
const MAX_SOURCE_TABS = 3;

/**
 * What can be added from one source: the reviewed repository (what the
 * page-level check already listed) or another repository, listed on demand
 * at its branch or tag. Candidates of another repository carry it.
 */
export const useKnowledgeSourceListing = (params: {
    teamId?: string;
    repositoryId?: string;
    source: KnowledgeSource;
    /** The page-level check, which lists the reviewed repository. */
    report?: CustomAgentResolveReport;
    enabled: boolean;
    /** The "Other repository…" picker is open: list every repository. */
    listConnected?: boolean;
}) => {
    const connected = useResolveCustomAgent({
        teamId: params.teamId,
        repositoryId: params.repositoryId,
        knowledge: [],
        listConnected: true,
        enabled: params.enabled && params.listConnected === true,
    });
    const remote = useResolveCustomAgent({
        teamId: params.teamId,
        repositoryId: params.repositoryId,
        knowledge: [],
        discover: true,
        source: params.source,
        enabled: params.enabled && !!params.source.repository,
    });
    const local =
        params.report?.knowledge.status === "ok"
            ? params.report.knowledge
            : null;
    const listing = params.source.repository
        ? remote.data?.knowledge.status === "ok"
            ? remote.data.knowledge
            : null
        : local;
    const candidates: KnowledgeCandidate[] = (listing?.candidates ?? []).map(
        (candidate) =>
            params.source.repository
                ? {
                      ...candidate,
                      repository: params.source.repository,
                      ...(params.source.ref && { ref: params.source.ref }),
                  }
                : candidate,
    );
    const connectedKnowledge =
        connected.data?.knowledge.status === "ok"
            ? connected.data.knowledge
            : null;
    return {
        candidates,
        discoveredIn: listing?.discoveredIn,
        connectedRepositories: connectedKnowledge?.connectedRepositories,
        reviewedVisibility:
            listing?.repositoryVisibility ??
            connectedKnowledge?.repositoryVisibility,
        loading: params.source.repository
            ? remote.isLoading || remote.isFetching
            : !local,
        unavailable:
            params.source.repository &&
            remote.data?.knowledge.status === "unavailable"
                ? remote.data.knowledge.reason
                : undefined,
    };
};

/**
 * Where skills and docs are added from: this repository, a linked one, or
 * any other repository connected on the same integration; for another
 * repository, the branch or tag it is read at. A pull request never changes
 * that ref, so the rules a PR is judged by stay the team's.
 */
export const KnowledgeSourceBar = ({
    source,
    onSourceChange,
    linkedRepositories,
    connectedRepositories,
    knowledge,
    discoveredIn,
    reviewedVisibility,
    canEdit,
    onRefChange,
    onPickOther,
}: {
    source: KnowledgeSource;
    onSourceChange: (source: KnowledgeSource) => void;
    linkedRepositories: string[];
    /** Every other repository the integration reaches; unset while unknown. */
    connectedRepositories?: string[];
    knowledge: KnowledgeItem[];
    discoveredIn?: NonNullable<
        Extract<
            CustomAgentResolveReport["knowledge"],
            { status: "ok" }
        >["discoveredIn"]
    >;
    reviewedVisibility?: "public" | "private";
    canEdit: boolean;
    /** A new ref for every item of the current repository. */
    onRefChange: (ref: string | undefined) => void;
    /** The picker of every connected repository opened. */
    onPickOther?: () => void;
}) => {
    const [picking, setPicking] = useState(false);
    const [editingRef, setEditingRef] = useState(false);
    const [refDraft, setRefDraft] = useState("");
    // Linked repositories first, then any other repository already in use.
    const inUse = knowledge
        .map((item) => item.repository)
        .filter((name): name is string => !!name);
    const tabs = [
        ...new Map(
            [
                ...linkedRepositories,
                ...inUse,
                ...(source.repository ? [source.repository] : []),
            ].map((name) => [name.toLowerCase(), name]),
        ).values(),
    ].slice(0, MAX_SOURCE_TABS + (source.repository ? 1 : 0));
    const refOf = (repository: string) =>
        knowledge.find(
            (item) =>
                item.repository?.toLowerCase() === repository.toLowerCase() &&
                item.ref,
        )?.ref;
    const open = (repository?: string) => {
        setPicking(false);
        setEditingRef(false);
        const ref = repository ? refOf(repository) : undefined;
        onSourceChange(repository ? { repository, ...(ref && { ref }) } : {});
    };

    return (
        <div className="flex flex-col gap-2">
            <span className="text-text-primary text-xs font-medium">From</span>
            <Choice
                size="sm"
                label="Add skills and docs from"
                value={
                    picking
                        ? OTHER_REPOSITORY
                        : (source.repository ?? THIS_REPOSITORY)
                }
                onChange={(value) => {
                    if (value !== OTHER_REPOSITORY)
                        return open(value || undefined);
                    setPicking(true);
                    onPickOther?.();
                }}
                options={[
                    { value: THIS_REPOSITORY, label: "This repository" },
                    ...tabs.map((name) => ({
                        value: name,
                        label: name.split("/").pop() ?? name,
                    })),
                    { value: OTHER_REPOSITORY, label: "Other repository…" },
                ]}
            />
            {picking && (
                <OtherRepositoryPicker
                    options={connectedRepositories}
                    onSelect={(name) => open(name)}
                    onCancel={() => setPicking(false)}
                />
            )}
            {source.repository && (
                <div className="flex flex-col gap-1">
                    {editingRef ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <div className="min-w-[10rem] flex-1">
                                <Input
                                    size="md"
                                    aria-label={`Branch or tag of ${source.repository}`}
                                    placeholder="Branch or tag, e.g. v3"
                                    value={refDraft}
                                    disabled={!canEdit}
                                    onChange={(e) =>
                                        setRefDraft(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                        if (e.key !== "Enter") return;
                                        e.preventDefault();
                                        onRefChange(
                                            refDraft.trim() || undefined,
                                        );
                                        setEditingRef(false);
                                    }}
                                />
                            </div>
                            <Button
                                size="sm"
                                variant="helper"
                                disabled={!canEdit}
                                onClick={() => {
                                    onRefChange(refDraft.trim() || undefined);
                                    setEditingRef(false);
                                }}>
                                Use
                            </Button>
                            <Button
                                size="sm"
                                variant="cancel"
                                onClick={() => setEditingRef(false)}>
                                Cancel
                            </Button>
                        </div>
                    ) : (
                        <p className="text-text-tertiary text-xs">
                            {source.ref ? (
                                <>
                                    Reading{" "}
                                    <span className="text-text-secondary font-medium">
                                        {source.ref}
                                    </span>
                                    .{" "}
                                    <button
                                        type="button"
                                        disabled={!canEdit}
                                        className="text-primary-light hover:underline disabled:opacity-60"
                                        onClick={() => onRefChange(undefined)}>
                                        Use the default branch
                                    </button>
                                </>
                            ) : (
                                <>
                                    Reading{" "}
                                    <span className="text-text-secondary font-medium">
                                        {discoveredIn?.branch ??
                                            "the default branch"}
                                    </span>
                                    , its default branch.{" "}
                                    <button
                                        type="button"
                                        disabled={!canEdit}
                                        className="text-primary-light hover:underline disabled:opacity-60"
                                        onClick={() => {
                                            setRefDraft("");
                                            setEditingRef(true);
                                        }}>
                                        Use a branch or tag instead
                                    </button>
                                </>
                            )}{" "}
                            · a pull request never changes it.
                        </p>
                    )}
                    {discoveredIn?.available === false &&
                        discoveredIn.reason && (
                            <p className="text-danger text-xs">
                                {discoveredIn.reason}
                            </p>
                        )}
                    {discoveredIn?.visibility === "private" &&
                        reviewedVisibility === "public" && (
                            <p className="text-text-tertiary flex items-center gap-1 text-xs">
                                <LockIcon
                                    aria-hidden
                                    className="size-3 shrink-0"
                                />
                                Private repository: on this public
                                repository&apos;s pull requests, comments name
                                the rule&apos;s file without quoting it.
                            </p>
                        )}
                </div>
            )}
        </div>
    );
};

/** Every repository the integration reaches, to pick one not linked yet. */
const OtherRepositoryPicker = ({
    options,
    onSelect,
    onCancel,
}: {
    options?: string[];
    onSelect: (fullName: string) => void;
    onCancel: () => void;
}) => {
    return (
        <div className="border-card-lv3 flex flex-col overflow-hidden rounded-lg border">
            <Command className="rounded-none border-0">
                <CommandInput placeholder="Search connected repositories…" />
                <CommandList className="max-h-56 overflow-y-auto">
                    <CommandEmpty>
                        {options
                            ? "No repository found."
                            : "Loading repositories…"}
                    </CommandEmpty>
                    <CommandGroup>
                        {(options ?? []).map((name) => (
                            <CommandItem
                                key={name}
                                value={name}
                                onSelect={() => onSelect(name)}
                                className="cursor-pointer gap-2 py-2">
                                <BookMarkedIcon className="text-text-secondary size-3.5 shrink-0" />
                                <span className="truncate text-sm">{name}</span>
                            </CommandItem>
                        ))}
                    </CommandGroup>
                </CommandList>
            </Command>
            <Button
                size="xs"
                variant="cancel"
                className="m-2 w-fit"
                onClick={onCancel}>
                Cancel
            </Button>
        </div>
    );
};

/**
 * The skills and docs one agent follows: only what it follows, each with a
 * way to stop, and a picker to add what a repository offers or a path typed
 * by hand. Skills open on demand; docs load whole. A skill or doc can come
 * from this repository or another connected one (a team's rules repository).
 */
export const AgentKnowledgeField = ({
    agentId,
    knowledge,
    report,
    canEdit,
    onChange,
    teamId,
    repositoryId,
    instructions,
}: {
    agentId: string;
    knowledge: KnowledgeItem[];
    report?: CustomAgentResolveReport;
    canEdit: boolean;
    onChange: (next: KnowledgeItem[]) => void;
    teamId?: string;
    repositoryId?: string;
    /** The agent's instructions, to notice a repository they name that it
     *  follows nothing from. */
    instructions?: string;
}) => {
    const [adding, setAdding] = useState(false);
    const [source, setSource] = useState<KnowledgeSource>({});
    const [pickingOther, setPickingOther] = useState(false);
    const resolved =
        report?.knowledge.status === "ok" ? report.knowledge : null;
    const unavailable =
        report?.knowledge.status === "unavailable"
            ? report.knowledge.reason
            : null;
    const listing = useKnowledgeSourceListing({
        teamId,
        repositoryId,
        source,
        report,
        enabled: adding,
        listConnected: pickingOther,
    });
    const candidates = listing.candidates;
    const reportOf = (
        item: Pick<KnowledgeItem, "path" | "kind" | "repository">,
    ) => resolved?.items.find((entry) => sameKnowledge(entry, item));
    const candidateOf = (
        item: Pick<KnowledgeItem, "path" | "kind" | "repository">,
    ) => candidates.find((entry) => sameKnowledge(entry, item));
    const named = [...(resolved?.items ?? []), ...candidates];
    const { skills, docs } = followedBy(knowledge, agentId, named);
    const fromSource = (choice: { repository?: string }) =>
        (choice.repository ?? "").toLowerCase() ===
        (source.repository ?? "").toLowerCase();
    const available = knowledgeChoices(knowledge, candidates, agentId).filter(
        (choice) => !choice.linked && fromSource(choice),
    );
    const budget = resolved?.budgets.find(
        (entry) => entry.target === knowledgeTargetKey({ agentId }),
    );
    const follow = (
        item: Pick<KnowledgeItem, "path" | "kind" | "repository" | "ref">,
        on: boolean,
    ) => onChange(setAgentKnowledge(knowledge, item, agentId, on));
    const descriptionOf = (
        item: Pick<KnowledgeItem, "path" | "kind" | "repository">,
    ) => reportOf(item)?.description ?? candidateOf(item)?.description;
    const linkedRepositories = resolved?.linkedRepositories ?? [];
    const mentioned = instructions
        ? mentionedButNotFollowed(
              instructions,
              linkedRepositories,
              knowledge,
              agentId,
          )
        : [];
    const browse = (repository: string) => {
        const ref = knowledge.find(
            (item) =>
                item.repository?.toLowerCase() === repository.toLowerCase() &&
                item.ref,
        )?.ref;
        setSource({ repository, ...(ref && { ref }) });
        setAdding(true);
    };
    // One ref per repository: changing it moves every item of that repository.
    const changeRef = (ref: string | undefined) => {
        if (!source.repository) return;
        const repository = source.repository.toLowerCase();
        setSource({ repository: source.repository, ...(ref && { ref }) });
        onChange(
            knowledge.map((item) =>
                item.repository?.toLowerCase() === repository
                    ? (({ ref: _old, ...rest }) => ({
                          ...rest,
                          ...(ref && { ref }),
                      }))(item)
                    : item,
            ),
        );
    };
    const sourceLabel = source.repository ?? "the branch";

    return (
        <div className="flex flex-col gap-3">
            {unavailable && (
                <p className="text-text-secondary text-xs">{unavailable}</p>
            )}
            {canEdit &&
                mentioned.map((repository) => (
                    <div
                        key={repository}
                        role="note"
                        className="border-primary-light/40 bg-primary-light/5 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2">
                        <span className="text-text-secondary text-xs">
                            The instructions mention{" "}
                            <span className="text-text-primary font-medium">
                                {repository}
                            </span>
                            , but this agent follows nothing from it. Findings
                            can only cite the rules it follows.
                        </span>
                        <Button
                            size="xs"
                            variant="helper"
                            onClick={() => browse(repository)}>
                            Browse its rules
                        </Button>
                    </div>
                ))}
            {skills.length === 0 && docs.length === 0 ? (
                <p className="text-text-secondary text-xs">
                    Not following any skill or doc yet.
                </p>
            ) : (
                <ul className="flex flex-col gap-1.5">
                    {skills.map((skill) => (
                        <li
                            key={knowledgeKey(skill)}
                            className="bg-card-lv2 flex items-start gap-2 rounded-lg px-3 py-2">
                            <SparklesIcon
                                aria-hidden
                                className="text-text-tertiary mt-0.5 size-4 shrink-0"
                            />
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="text-text-primary text-xs font-medium">
                                    {skill.name}
                                </span>
                                {descriptionOf(skill) && (
                                    <span className="text-text-secondary text-xs">
                                        {descriptionOf(skill)}
                                    </span>
                                )}
                                <span className="text-text-tertiary truncate font-mono text-xs">
                                    {skill.path}
                                </span>
                                <span className="flex flex-wrap gap-1 empty:hidden">
                                    <KnowledgeSourceChip
                                        item={skill}
                                        branch={reportOf(skill)?.branch}
                                    />
                                    <KnowledgeStatusChips
                                        report={reportOf(skill)}
                                    />
                                </span>
                                <KnowledgeIssues report={reportOf(skill)} />
                            </span>
                            <StopFollowing
                                name={skill.name}
                                disabled={!canEdit}
                                onClick={() => follow(skill, false)}
                            />
                        </li>
                    ))}
                    {docs.map((doc) => (
                        <li
                            key={knowledgeKey(doc)}
                            className="flex items-center gap-2 px-3 py-1">
                            <BookOpenIcon
                                aria-hidden
                                className="text-text-tertiary size-4 shrink-0"
                            />
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="text-text-primary truncate font-mono text-xs">
                                    {doc.path}
                                </span>
                                {doc.repository && (
                                    <span className="flex flex-wrap gap-1">
                                        <KnowledgeSourceChip
                                            item={doc}
                                            branch={reportOf(doc)?.branch}
                                        />
                                    </span>
                                )}
                                <KnowledgeIssues report={reportOf(doc)} />
                            </span>
                            <span className="flex shrink-0 flex-wrap gap-1">
                                <KnowledgeStatusChips report={reportOf(doc)} />
                            </span>
                            <StopFollowing
                                name={
                                    doc.repository
                                        ? `${doc.repository}:${doc.path}`
                                        : doc.path
                                }
                                disabled={!canEdit}
                                onClick={() => follow(doc, false)}
                            />
                        </li>
                    ))}
                </ul>
            )}
            {budget && budget.over.length > 0 && (
                <p className="text-warning text-xs">
                    Over the limit for this agent (
                    {budget.over
                        .map((limit) => KNOWLEDGE_LIMIT_LABELS[limit])
                        .join(", ")}
                    ): {budget.skills} skills, {budget.docs} docs,{" "}
                    {budget.docTokens.toLocaleString()} doc tokens.
                </p>
            )}
            {unavailable ? (
                <AddByPath
                    agentId={agentId}
                    disabled={!canEdit}
                    onAdd={(item) => follow(item, true)}
                />
            ) : adding ? (
                <div className="border-card-lv3/60 flex flex-col gap-3 border-t pt-3">
                    <KnowledgeSourceBar
                        source={source}
                        onSourceChange={setSource}
                        linkedRepositories={linkedRepositories}
                        connectedRepositories={listing.connectedRepositories}
                        knowledge={knowledge}
                        discoveredIn={listing.discoveredIn}
                        reviewedVisibility={listing.reviewedVisibility}
                        canEdit={canEdit}
                        onRefChange={changeRef}
                        onPickOther={() => setPickingOther(true)}
                    />
                    {listing.unavailable ? (
                        <p className="text-danger text-xs">
                            {listing.unavailable}
                        </p>
                    ) : listing.loading ? (
                        <p className="text-text-secondary text-xs">
                            Reading{" "}
                            {source.repository
                                ? source.repository
                                : "the branch"}
                            …
                        </p>
                    ) : listing.discoveredIn?.available ===
                      false ? null : available.length === 0 ? (
                        <p className="text-text-secondary text-xs">
                            {source.repository
                                ? `Nothing else found in ${source.repository}. Add one by path.`
                                : "Nothing else found on the branch. Add one by path."}
                        </p>
                    ) : (
                        <ul className="flex flex-col gap-1">
                            {available.map((choice) => {
                                const name =
                                    choice.kind === "skill"
                                        ? (reportOf(choice)?.name ??
                                          choice.name ??
                                          skillFolderName(choice.path))
                                        : choice.path;
                                const description = descriptionOf(choice);
                                return (
                                    <li key={knowledgeKey(choice)}>
                                        <button
                                            type="button"
                                            aria-label={`Follow ${name}`}
                                            disabled={!canEdit}
                                            onClick={() => follow(choice, true)}
                                            className="hover:bg-card-lv2 flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left disabled:opacity-60">
                                            {choice.kind === "skill" ? (
                                                <SparklesIcon
                                                    aria-hidden
                                                    className="text-text-tertiary mt-0.5 size-4 shrink-0"
                                                />
                                            ) : (
                                                <BookOpenIcon
                                                    aria-hidden
                                                    className="text-text-tertiary mt-0.5 size-4 shrink-0"
                                                />
                                            )}
                                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                                <span
                                                    className={cn(
                                                        "text-text-primary text-xs font-medium",
                                                        choice.kind === "doc" &&
                                                            "font-mono",
                                                    )}>
                                                    {name}
                                                </span>
                                                {description && (
                                                    <span className="text-text-secondary text-xs">
                                                        {description}
                                                    </span>
                                                )}
                                                {choice.kodyRuleSource && (
                                                    <span className="text-warning text-xs">
                                                        Also a Kody Rules source
                                                    </span>
                                                )}
                                            </span>
                                            <PlusIcon
                                                aria-hidden
                                                className="text-text-secondary mt-0.5 size-4 shrink-0"
                                            />
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    <AddByPath
                        agentId={agentId}
                        disabled={!canEdit}
                        source={source}
                        sourceLabel={sourceLabel}
                        onAdd={(item) => follow(item, true)}
                    />
                    <Button
                        size="xs"
                        variant="helper"
                        className="w-fit"
                        onClick={() => setAdding(false)}>
                        Done
                    </Button>
                </div>
            ) : (
                canEdit && (
                    <Button
                        size="xs"
                        variant="helper"
                        className="w-fit"
                        leftIcon={<PlusIcon />}
                        onClick={() => setAdding(true)}>
                        Add skill or doc
                    </Button>
                )
            )}
        </div>
    );
};

const StopFollowing = ({
    name,
    disabled,
    onClick,
}: {
    name: string;
    disabled: boolean;
    onClick: () => void;
}) => (
    <Button
        size="icon-sm"
        variant="cancel"
        className="shrink-0"
        aria-label={`Stop following ${name}`}
        disabled={disabled}
        onClick={onClick}>
        <XIcon />
    </Button>
);

/** A path typed by hand; its kind comes from the path itself, and it lives
 *  in the repository the picker is on. */
const AddByPath = ({
    agentId,
    disabled,
    onAdd,
    source,
    sourceLabel,
}: {
    agentId: string;
    disabled: boolean;
    onAdd: (
        item: Pick<KnowledgeItem, "path" | "kind" | "repository" | "ref">,
    ) => void;
    source?: KnowledgeSource;
    sourceLabel?: string;
}) => {
    const [path, setPath] = useState("");
    const parsed = knowledgeItemFromPath(path);
    const item = parsed
        ? {
              ...parsed,
              ...(source?.repository && { repository: source.repository }),
              ...(source?.repository && source.ref && { ref: source.ref }),
          }
        : null;
    const add = () => {
        if (!item) return;
        onAdd(item);
        setPath("");
    };
    const id = `agent-${agentId}-knowledge-path`;
    return (
        <Field
            label="Add by path"
            htmlFor={id}
            hint={
                item
                    ? `Adds the ${item.kind} ${item.repository ? `${item.repository}:` : ""}${item.path}`
                    : source?.repository
                      ? `A doc file, or a skill folder with a SKILL.md, in ${sourceLabel}.`
                      : "A doc file (e.g. docs/payments.md), or a skill folder with a SKILL.md, on the target branch."
            }>
            <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-[12rem] flex-1">
                    <Input
                        id={id}
                        size="md"
                        placeholder="e.g. docs/payments.md or .claude/skills/ledger"
                        value={path}
                        disabled={disabled}
                        onChange={(e) => setPath(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key !== "Enter") return;
                            e.preventDefault();
                            add();
                        }}
                    />
                </div>
                <Button
                    size="sm"
                    variant="helper"
                    leftIcon={<PlusIcon />}
                    aria-label={item ? `Add ${item.path}` : "Add path"}
                    disabled={disabled || !item}
                    onClick={add}>
                    Add
                </Button>
            </div>
        </Field>
    );
};
