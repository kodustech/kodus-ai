"use client";

import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { DataTable } from "@components/ui/data-table";
import { Input } from "@components/ui/input";
import { Link } from "@components/ui/link";
import type { WebhookCreationFailure } from "@services/codeManagement/fetch";
import type { getIntegrationConfig } from "@services/integrations/integrationConfig/fetch";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { PlusIcon, SearchIcon, TriangleAlert } from "lucide-react";
import type { AwaitedReturnType } from "src/core/types";

import { columns } from "./table-columns";

export const GitRepositoriesTable = ({
    platformName,
    repositories,
    webhookFailures,
}: {
    repositories: AwaitedReturnType<typeof getIntegrationConfig>;
    platformName: string;
    webhookFailures?: Record<string, WebhookCreationFailure>;
}) => {
    const [query, setQuery] = useState("");
    const canCreate = usePermission(Action.Create, ResourceType.GitSettings);

    const withoutWebhook = Object.entries(webhookFailures ?? {}).map(
        ([repositoryId, failure]) => ({
            repositoryId,
            name:
                repositories.find((repo) => String(repo.id) === repositoryId)
                    ?.name ?? repositoryId,
            reason: failure?.reason,
        }),
    );

    return (
        <div>
            {withoutWebhook.length > 0 && (
                <Alert variant="warning" className="mb-3">
                    <TriangleAlert />
                    <AlertTitle>
                        {withoutWebhook.length === 1
                            ? "A repository has no webhook"
                            : `${withoutWebhook.length} repositories have no webhook`}
                    </AlertTitle>
                    <AlertDescription>
                        <p>
                            Kody is never notified of pull requests opened on
                            these repositories, so no review runs. The provider
                            refused the webhook when the selection was saved:
                        </p>

                        <ul className="mt-2 space-y-1">
                            {withoutWebhook.map((entry) => (
                                <li key={entry.repositoryId}>
                                    <span className="text-text-primary font-medium">
                                        {entry.name}
                                    </span>
                                    {entry.reason ? `: ${entry.reason}` : ""}
                                </li>
                            ))}
                        </ul>
                    </AlertDescription>
                </Alert>
            )}

            <div className="mb-3 flex items-center justify-end">
                <div className="flex items-center gap-2">
                    <Input
                        size="md"
                        value={query}
                        className="w-52"
                        leftIcon={<SearchIcon />}
                        placeholder="Find by name"
                        onChange={(e) => setQuery(e.target.value)}
                    />

                    <Link href="/settings/git/repositories">
                        <Button
                            size="md"
                            decorative
                            variant="primary-dark"
                            disabled={!canCreate}
                            leftIcon={<PlusIcon />}>
                            Add repository
                        </Button>
                    </Link>
                </div>
            </div>

            <DataTable
                columns={columns}
                data={repositories}
                pageSize={25}
                state={{ globalFilter: query }}
                onGlobalFilterChange={setQuery}
            />
        </div>
    );
};
