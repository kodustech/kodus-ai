"use client";

import { useCallback, useEffect, useState } from "react";
import { DataTable } from "@components/ui/data-table";
import { Input } from "@components/ui/input";
import { Page } from "@components/ui/page";
import { getUserLogs } from "@services/userLogs/fetch";
import { SearchIcon } from "lucide-react";
import type { AwaitedReturnType } from "src/core/types";

import { columns } from "./columns";
import { DateRangeFilter } from "./date-range-filter";

export const UserLogsPageClient = () => {
    const [query, setQuery] = useState("");
    const [logsData, setLogsData] =
        useState<AwaitedReturnType<typeof getUserLogs>>();
    const [loading, setLoading] = useState(false);
    const [dateRange, setDateRange] = useState<{
        from: string;
        to: string;
    } | null>(null);
    const [selectedAction, setSelectedAction] = useState<
        "all" | "add" | "create" | "edit" | "delete" | "clone"
    >("all");
    const [selectedLevel, setSelectedLevel] = useState<
        "all" | "main" | "global" | "repository"
    >("all");
    const [userEmailFilter, setUserEmailFilter] = useState("");

    const fetchLogs = useCallback(() => {
        setLoading(true);

        const params: any = {};

        if (selectedAction && selectedAction !== "all") {
            params.action = selectedAction;
        }

        if (selectedLevel && selectedLevel !== "all") {
            params.configLevel = selectedLevel;
        }

        if (userEmailFilter && userEmailFilter.trim()) {
            params.userEmail = userEmailFilter.trim();
        }

        getUserLogs(params)
            .then((newData) => {
                setLogsData(newData);
            })
            .catch((error) => {
                console.error("Error fetching logs:", error);
            })
            .finally(() => {
                setLoading(false);
            });
    }, [selectedAction, selectedLevel, userEmailFilter]);

    const handleDateRangeChange = (range: { from: string; to: string }) => {
        setDateRange(range);
    };

    const handleActionChange = (
        action: "all" | "add" | "create" | "edit" | "delete" | "clone",
    ) => {
        setSelectedAction(action);
    };

    const handleLevelChange = (
        level: "all" | "main" | "global" | "repository",
    ) => {
        setSelectedLevel(level);
    };

    const handleUserEmailChange = (email: string) => {
        setUserEmailFilter(email);
    };

    // Effect para buscar logs quando filtros mudam (exceto email que tem debounce)
    useEffect(() => {
        fetchLogs();
    }, [selectedAction, selectedLevel, userEmailFilter]);

    const filteredLogs = logsData?.logs.filter((log) => {
        // Filtro de texto
        if (query) {
            const searchText = query.toLowerCase();
            const matchesText =
                log._userInfo.userEmail.toLowerCase().includes(searchText) ||
                log._changedData.some(
                    (change) =>
                        change.description.toLowerCase().includes(searchText) ||
                        change.actionDescription
                            .toLowerCase()
                            .includes(searchText),
                );
            if (!matchesText) return false;
        }

        // Filtro de data
        if (dateRange) {
            const logDate = new Date(log._createdAt);

            // Criar datas UTC para comparação consistente
            const fromDate = new Date(dateRange.from + "T00:00:00.000Z");
            const toDate = new Date(dateRange.to + "T23:59:59.999Z");

            if (logDate < fromDate || logDate > toDate) {
                return false;
            }
        }

        return true;
    });

    return (
        <Page.Root className="overflow-hidden pb-0">
            <Page.Header>
                <Page.TitleContainer>
                    <Page.Title>User Activity Logs</Page.Title>
                    <Page.Description>
                        Monitor all user activities and configuration changes
                        across your organization.
                    </Page.Description>
                </Page.TitleContainer>

                <Page.HeaderActions>
                    <DateRangeFilter
                        onDateRangeChange={handleDateRangeChange}
                        initialRange={dateRange || undefined}
                    />

                    <Input
                        size="md"
                        value={query}
                        className="w-64"
                        leftIcon={<SearchIcon />}
                        placeholder="Search logs..."
                        onChange={(e) => setQuery(e.target.value)}
                    />
                </Page.HeaderActions>
            </Page.Header>

            <Page.Content className="overflow-auto px-0">
                <DataTable
                    columns={columns}
                    data={filteredLogs ?? []}
                    loading={loading}
                />
            </Page.Content>
        </Page.Root>
    );
};
