"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { DataTable } from "@components/ui/data-table";

import { setCockpitRepositoryCookie } from "../../_actions/set-cockpit-repository";
import { CockpitNoDataPlaceholder } from "../../_components/no-data-placeholder";
import { COCKPIT_PARAM, COCKPIT_REVIEW_PARAM } from "../../_constants";
import { useShallowParam } from "../../_helpers/use-shallow-param";
import type { RepositoryHealthRow } from "../../_services/analytics/review/fetch";
import { repositoriesColumns } from "./repositories-columns";

export const RepositoriesHealthTable = ({
    data,
}: {
    data: RepositoryHealthRow[];
}) => {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [, startTransition] = useTransition();
    const [search, setSearch] = useShallowParam<string>(
        COCKPIT_REVIEW_PARAM.reposQuery,
        "",
    );

    if (!data.length) return <CockpitNoDataPlaceholder />;

    // Push the repository onto the URL (source of truth, so the focused
    // view is shareable and not shadowed by a stale `repository` param)
    // and persist it to the cookie default — same contract as the
    // top-bar repository picker.
    const focusRepository = (row: RepositoryHealthRow) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set(COCKPIT_PARAM.repository, row.repository);
        startTransition(async () => {
            await setCockpitRepositoryCookie(row.repository);
            router.push(`${pathname}?${params.toString()}`);
        });
    };

    return (
        <div>
            <DataTable
                columns={repositoriesColumns}
                data={data}
                searchable
                searchPlaceholder="Search repositories…"
                searchValue={search}
                onSearchChange={setSearch}
                pageSize={10}
                getRowId={(row) => row.repository}
                onRowClick={focusRepository}
            />
            <p className="text-text-tertiary mt-3 text-[11px]">
                Click a row to focus the whole cockpit on that repository.{" "}
                <strong>Weakest category</strong> = lowest implementation rate
                in that repo (min. 5 suggestions) — where to tune config or add
                a Kody Rule.
            </p>
        </div>
    );
};
