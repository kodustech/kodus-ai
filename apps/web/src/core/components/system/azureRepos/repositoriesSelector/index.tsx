"use client";

import React, { useState } from "react";
import AutoComplete from "@components/system/autoComplete";
import { getRepositories } from "@services/codeManagement/fetch";

import styles from "./styles.module.css";

export default function AzureReposRepositoriesSelector({
    teamId,
    organizationSelected,
    selectedRepositories,
    setSelectedRepositories,
}: {
    teamId: any;
    organizationSelected: any;
    selectedRepositories: any;
    setSelectedRepositories: any;
}): React.ReactNode {
    const [repositories, setRepositories] = React.useState<any[]>([]);
    const [originalRepositories, setOriginalRepositories] = useState<any[]>([]);
    const [isLoading, setIsLoading] = React.useState<boolean>(true);

    React.useEffect(() => {
        const fetchData = async () => {
            setIsLoading(true);
            const response = await getRepositories(
                teamId,
                organizationSelected,
            );
            const data = Array.isArray(response) ? response : [];

            setOriginalRepositories(data);

            setRepositories(
                data
                    ?.sort((a: any, b: any) => a?.name?.localeCompare(b?.name))
                    .map((repository) => {
                        return {
                            label: repository.name,
                            value: repository.id,
                            project: repository?.project,
                            default_branch: repository?.default_branch,
                        };
                    }),
            );

            setSelectedRepositories(
                data
                    .filter((repository) => repository.selected)
                    .map((repository) => {
                        return {
                            label: repository.name,
                            value: repository.id,
                            project: repository?.project,
                        };
                    }),
            );

            setIsLoading(false);
        };

        fetchData();
    }, [organizationSelected]);

    function setRepository(selectedRepository: any) {
        setSelectedRepositories(selectedRepository);
    }

    return (
        <div className={styles.root}>
            <AutoComplete
                data={repositories}
                placeholder="Select repositories"
                onChange={setRepository}
                value={selectedRepositories}
                isMulti={true}
                isLoading={isLoading}></AutoComplete>
        </div>
    );
}
