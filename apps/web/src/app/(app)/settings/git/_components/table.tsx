"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { DataTable } from "@components/ui/data-table";
import { Input } from "@components/ui/input";
import { Link } from "@components/ui/link";
import type { getIntegrationConfig } from "@services/integrations/integrationConfig/fetch";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { PlusIcon, SearchIcon } from "lucide-react";
import type { AwaitedReturnType } from "src/core/types";

import { columns } from "./table-columns";

export const GitRepositoriesTable = ({
    platformName,
    repositories,
}: {
    repositories: AwaitedReturnType<typeof getIntegrationConfig>;
    platformName: string;
}) => {
    const [query, setQuery] = useState("");
    const canCreate = usePermission(Action.Create, ResourceType.GitSettings);

    return (
        <div>
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
