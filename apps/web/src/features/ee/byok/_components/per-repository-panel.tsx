"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Link } from "@components/ui/link";
import {
    listModelOverrides,
    type ListModelOverridesResult,
} from "@services/organizationParameters/fetch";
import {
    Building2Icon,
    ChevronDownIcon,
    ChevronRightIcon,
    ExternalLinkIcon,
    FolderIcon,
} from "lucide-react";

import { providerFromModel } from "../_utils";
import { ProviderAvatar } from "./provider-avatar";

type FolderOverride = { id: string; name: string; model: string };
type RepoGroup = {
    id: string;
    name: string;
    model?: string;
    folders: FolderOverride[];
};

/** Group the flat override list into repositories with their per-folder children.
 *  A repo is a "monorepo" here when it carries folder-scoped overrides. `global`
 *  scope is the org default (shown elsewhere) and skipped. */
const groupOverrides = (
    result: ListModelOverridesResult | null,
): RepoGroup[] => {
    const byRepo = new Map<string, RepoGroup>();
    for (const o of result?.overrides ?? []) {
        if (o.scope === "global") continue;
        const repoId = o.repositoryId ?? o.repositoryName ?? "unknown";
        let repo = byRepo.get(repoId);
        if (!repo) {
            repo = {
                id: repoId,
                name: o.repositoryName ?? o.repositoryId ?? "repository",
                folders: [],
            };
            byRepo.set(repoId, repo);
        }
        if (o.scope === "repository") {
            repo.model = o.model;
        } else if (o.scope === "directory") {
            repo.folders.push({
                // Index-suffixed fallback so two folders that both lack id AND
                // name still get distinct React keys.
                id:
                    o.directoryId ??
                    o.directoryName ??
                    `${repoId}-dir-${repo.folders.length}`,
                name: o.directoryName ?? o.directoryId ?? "folder",
                model: o.model,
            });
        }
    }
    return [...byRepo.values()];
};

/** id -> friendly label/provider, so the read-only mirror shows the same model
 *  name the rest of the routing screen does (e.g. "Kimi K2.7 Code") instead of
 *  the raw stored id ("model-kimi"). */
export type PerRepositoryModelInfo = {
    id: string;
    label: string;
    provider?: string;
};

const ModelCell = ({
    model,
    models,
}: {
    model?: string;
    models?: PerRepositoryModelInfo[];
}) => {
    if (!model) {
        return <span className="text-text-tertiary text-sm">Inherits</span>;
    }
    // The stored override is a model id; resolve it to the display label. Fall
    // back to the raw value so a legacy name-based override still shows readably.
    const info = models?.find((m) => m.id === model);
    return (
        <span className="flex items-center gap-2">
            <ProviderAvatar
                provider={info?.provider ?? providerFromModel(model)}
            />
            <span className="text-text-primary text-sm font-medium">
                {info?.label ?? model}
            </span>
        </span>
    );
};

/**
 * A READ-ONLY mirror of the per-repository / per-folder model overrides set in
 * Code Review Settings. It does not edit anything — it shows what's configured
 * there and links out to the real editor — so the BYOK screen is the one place a
 * user sees every model assignment (org default, per agent, per repository).
 * Renders nothing while there are no repo/folder overrides to mirror.
 */
export const PerRepositoryPanel = ({
    teamId,
    models,
}: {
    teamId?: string;
    models?: PerRepositoryModelInfo[];
}) => {
    const [data, setData] = useState<ListModelOverridesResult | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    useEffect(() => {
        if (!teamId) {
            return;
        }
        void listModelOverrides(teamId)
            .then(setData)
            .catch(() => setData(null));
    }, [teamId]);

    const repos = useMemo(() => groupOverrides(data), [data]);

    const toggle = (id: string) =>
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    return (
        <div className="border-card-lv3/50 bg-card-lv1 flex flex-col gap-3 rounded-xl border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                    <span className="bg-card-lv2 flex size-9 shrink-0 items-center justify-center rounded-lg text-sky-300">
                        <Building2Icon className="size-4" />
                    </span>
                    <div className="flex flex-col">
                        <span className="text-text-primary flex items-center gap-2 text-sm font-medium">
                            Per repository
                            <Badge variant="helper">Read-only</Badge>
                        </span>
                        <span className="text-text-tertiary max-w-prose text-xs">
                            Models assigned per repository — and per folder for
                            monorepos. Configure these in Code Review Settings;
                            this view reflects what&apos;s set there.
                        </span>
                    </div>
                </div>
                <Link
                    href="/settings/code-review"
                    className="text-primary-light hover:text-primary inline-flex shrink-0 items-center gap-1 text-xs font-medium">
                    Open Code Review Settings
                    <ExternalLinkIcon className="size-3.5" />
                </Link>
            </div>

            {repos.length === 0 ? (
                <div className="border-card-lv3/40 text-text-tertiary rounded-lg border border-dashed px-4 py-6 text-center text-sm text-pretty">
                    No per-repository models yet — every repository uses the
                    models above. Assign a model to a specific repository or
                    folder in Code Review Settings to see it here.
                </div>
            ) : (
                <div className="border-card-lv3/40 divide-card-lv3/30 flex flex-col divide-y overflow-hidden rounded-lg border">
                    {/* Header spine */}
                    <div className="text-text-tertiary bg-card-lv2/40 grid grid-cols-[1fr_16rem] gap-4 px-3 py-2 text-[0.6875rem] font-medium tracking-wide uppercase">
                        <span>Repository / Folder</span>
                        <span>Model</span>
                    </div>

                    {repos.map((repo) => {
                        const isMonorepo = repo.folders.length > 0;
                        const isOpen = expanded.has(repo.id);
                        return (
                            <div key={repo.id} className="flex flex-col">
                                <div className="grid grid-cols-[1fr_16rem] items-center gap-4 px-3 py-2.5">
                                    <span className="flex min-w-0 items-center gap-2">
                                        {isMonorepo ? (
                                            <button
                                                type="button"
                                                onClick={() => toggle(repo.id)}
                                                aria-label={
                                                    isOpen
                                                        ? "Collapse"
                                                        : "Expand"
                                                }
                                                className="text-text-tertiary hover:text-text-secondary shrink-0">
                                                {isOpen ? (
                                                    <ChevronDownIcon className="size-4" />
                                                ) : (
                                                    <ChevronRightIcon className="size-4" />
                                                )}
                                            </button>
                                        ) : (
                                            <span className="w-4 shrink-0" />
                                        )}
                                        <span className="text-text-primary truncate font-mono text-sm">
                                            {repo.name}
                                        </span>
                                        {isMonorepo && (
                                            <Badge variant="helper">
                                                Monorepo
                                            </Badge>
                                        )}
                                    </span>
                                    <ModelCell
                                        model={repo.model}
                                        models={models}
                                    />
                                </div>

                                {isMonorepo && isOpen && (
                                    <div className="border-card-lv3/30 flex flex-col border-t">
                                        {repo.folders.map((f) => (
                                            <div
                                                key={f.id}
                                                className="grid grid-cols-[1fr_16rem] items-center gap-4 py-2 pr-3 pl-3">
                                                <span className="flex min-w-0 items-center gap-2 pl-8">
                                                    <FolderIcon className="text-text-tertiary size-3.5 shrink-0" />
                                                    <span className="text-text-secondary truncate font-mono text-sm">
                                                        {f.name}
                                                    </span>
                                                </span>
                                                <ModelCell
                                                    model={f.model}
                                                    models={models}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};
