"use client";

import { useMemo, useState } from "react";
import { SkeletonRows } from "@components/system/page-skeletons";
import { Button } from "@components/ui/button";
import { Card, CardContent, CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Link } from "@components/ui/link";
import { listModelOverrides } from "@services/organizationParameters/fetch";
import { useQuery } from "@tanstack/react-query";
import {
    BotIcon,
    ChevronDownIcon,
    ChevronRightIcon,
    FolderIcon,
} from "lucide-react";

import { providerFromModel } from "../_utils";
import { groupOverrides } from "./per-repository-overrides";
import { ProviderAvatar } from "./provider-avatar";

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
        <span className="flex min-w-0 items-center gap-2">
            <ProviderAvatar
                provider={info?.provider ?? providerFromModel(model)}
            />
            <span
                title={info?.label ?? model}
                className="text-text-primary truncate text-sm font-medium">
                {info?.label ?? model}
            </span>
        </span>
    );
};

/**
 * A READ-ONLY mirror of the per-repository / per-folder model overrides set in
 * Routing and custom-agent settings. Each link opens the scope that owns it.
 */
export const PerRepositoryPanel = ({
    teamId,
    models,
}: {
    teamId?: string;
    models?: PerRepositoryModelInfo[];
}) => {
    const { data, isPending, isError, refetch } = useQuery({
        queryKey: ["routing-model-overrides", teamId],
        queryFn: () => listModelOverrides(teamId!),
        enabled: !!teamId,
        retry: false,
        throwOnError: false,
        staleTime: 15_000,
    });
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const repos = useMemo(() => groupOverrides(data ?? null), [data]);

    const toggle = (id: string) =>
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    return (
        <Card
            color="lv1"
            role="region"
            aria-label="Repository overrides"
            className="scroll-mt-64 md:scroll-mt-32">
            <CardHeader>
                <Heading variant="h3">Repository overrides</Heading>
                <p className="text-text-secondary text-sm">
                    Models set for repositories, folders and custom agents.
                </p>
            </CardHeader>
            <CardContent>
                {!teamId ? (
                    <p className="text-text-secondary text-sm">
                        Select a team to view overrides.
                    </p>
                ) : isPending ? (
                    <SkeletonRows
                        rows={3}
                        className="border-card-lv3/40 overflow-hidden rounded-lg border"
                    />
                ) : isError ? (
                    <div
                        role="alert"
                        className="flex flex-wrap items-center gap-3 text-sm">
                        <p>Could not load repository overrides.</p>
                        <Button
                            type="button"
                            variant="helper"
                            size="sm"
                            onClick={() => refetch()}>
                            Retry
                        </Button>
                    </div>
                ) : repos.length === 0 ? (
                    <div className="border-card-lv3/40 text-text-tertiary rounded-lg border border-dashed px-4 py-6 text-center text-sm text-pretty">
                        No repository overrides. Choose a repository from the
                        scope menu to set one.
                    </div>
                ) : (
                    <div className="border-card-lv3/40 divide-card-lv3/30 flex flex-col divide-y overflow-hidden rounded-lg border">
                        {/* Header spine */}
                        <div className="text-text-secondary bg-card-lv2/40 hidden grid-cols-[minmax(0,1fr)_16rem] gap-4 px-3 py-2 text-xs font-medium sm:grid">
                            <span>Repository / Folder</span>
                            <span>Model</span>
                        </div>

                        {repos.map((repo) => {
                            const isMonorepo = repo.folders.length > 0;
                            const isOpen = expanded.has(repo.id);
                            return (
                                <div key={repo.id} className="flex flex-col">
                                    <div className="grid grid-cols-1 items-center gap-4 gap-y-1 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_16rem]">
                                        <span className="flex min-w-0 items-center gap-2">
                                            {isMonorepo ? (
                                                <Button
                                                    type="button"
                                                    variant="cancel"
                                                    size="icon-sm"
                                                    onClick={() =>
                                                        toggle(repo.id)
                                                    }
                                                    aria-expanded={isOpen}
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
                                                </Button>
                                            ) : (
                                                <span className="w-4 shrink-0" />
                                            )}
                                            {repo.href ? (
                                                <Link
                                                    href={repo.href}
                                                    title={repo.name}
                                                    className="truncate text-sm">
                                                    {repo.name}
                                                </Link>
                                            ) : (
                                                <span className="text-text-primary truncate text-sm">
                                                    {repo.name}
                                                </span>
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
                                                    className="grid grid-cols-1 items-center gap-4 gap-y-1 py-2 pr-3 pl-3 sm:grid-cols-[minmax(0,1fr)_16rem]">
                                                    <span className="flex min-w-0 items-center gap-2 pl-8">
                                                        <FolderIcon className="text-text-tertiary size-3.5 shrink-0" />
                                                        {f.href ? (
                                                            <Link
                                                                href={f.href}
                                                                className="truncate text-sm">
                                                                {f.name}
                                                            </Link>
                                                        ) : (
                                                            <span className="text-text-secondary truncate text-sm">
                                                                {f.name}
                                                            </span>
                                                        )}
                                                    </span>
                                                    <ModelCell
                                                        model={f.model}
                                                        models={models}
                                                    />
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {repo.agents.length > 0 && (
                                        <div className="border-card-lv3/30 flex flex-col border-t">
                                            {repo.agents.map((a) => (
                                                <div
                                                    key={a.id}
                                                    className="grid grid-cols-1 items-center gap-4 gap-y-1 py-2 pr-3 pl-3 sm:grid-cols-[minmax(0,1fr)_16rem]">
                                                    <span className="flex min-w-0 items-center gap-2 pl-8">
                                                        <BotIcon className="text-text-tertiary size-3.5 shrink-0" />
                                                        {a.href ? (
                                                            <Link
                                                                href={a.href}
                                                                className="text-text-secondary hover:text-text-primary truncate text-sm">
                                                                {a.agentName}
                                                            </Link>
                                                        ) : (
                                                            <span className="text-text-secondary truncate text-sm">
                                                                {a.agentName}
                                                            </span>
                                                        )}
                                                        <span className="text-text-tertiary min-w-0 truncate text-xs">
                                                            custom agent
                                                            {a.folderName
                                                                ? ` · ${a.folderName}`
                                                                : ""}
                                                        </span>
                                                    </span>
                                                    <ModelCell
                                                        model={a.model}
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
            </CardContent>
        </Card>
    );
};
