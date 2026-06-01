"use client";

import { useState } from "react";
import { Tree } from "@components/ui/tree";
import { useDirectoryLoader } from "@services/codeManagement/hooks/use-directory-loader";
import { useLazyRepositoryTree } from "@services/codeManagement/hooks/use-lazy-repository-tree";
import { useSuspenseGetCodeReviewParameter } from "@services/parameters/hooks";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { safeArray } from "src/core/utils/safe-array";

interface DirectoryItem {
    name: string;
    path: string;
    sha: string;
    hasChildren: boolean;
}

const LazyTreeFolder = ({
    directory,
    loadDirectory,
    repository,
    repositoryId,
    excludeGroupId,
}: {
    directory: DirectoryItem;
    loadDirectory: (path: string | null) => Promise<DirectoryItem[]>;
    repository: any;
    repositoryId: string;
    excludeGroupId?: string;
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const path = `/${directory.path}`;

    const { data: children, isLoading } = useDirectoryLoader(
        loadDirectory,
        directory.path,
        repositoryId,
        isOpen && directory.hasChildren,
    );

    const isDisabled = safeArray(repository?.directories).some(
        (group: any) =>
            group.id !== excludeGroupId &&
            safeArray(group.folders).some(
                (f: any) =>
                    path.startsWith(`${f.path}/`) || path === f.path,
            ),
    );

    return (
        <Tree.Folder
            key={directory.path}
            name={directory.name}
            value={path}
            disabled={isDisabled}
            hasChildren={directory.hasChildren}
            onOpenChange={setIsOpen}>
            {isLoading && (
                <div className="ml-4 py-1 text-xs text-gray-500">
                    Loading...
                </div>
            )}

            {!isLoading &&
                children &&
                children.length > 0 &&
                children.map((child) => (
                    <LazyTreeFolder
                        key={child.path}
                        directory={child}
                        loadDirectory={loadDirectory}
                        repository={repository}
                        repositoryId={repositoryId}
                        excludeGroupId={excludeGroupId}
                    />
                ))}

            {!isLoading && children && children.length === 0 && (
                <div className="ml-4 py-1 text-xs text-gray-400">Empty</div>
            )}
        </Tree.Folder>
    );
};

export const GitDirectorySelector = ({
    repositoryId,
    excludeGroupId,
    ...props
}: {
    repositoryId: string;
    excludeGroupId?: string;
} & React.ComponentProps<typeof Tree.Root>) => {
    const { teamId } = useSelectedTeamId();
    const { configValue } = useSuspenseGetCodeReviewParameter(teamId);

    const repository = safeArray(configValue?.repositories).find(
        (r) => r.id === repositoryId,
    );

    const { repositoryName, rootDirectories, isLoadingRoot, loadDirectory } =
        useLazyRepositoryTree({
            repositoryId,
            teamId,
        });

    if (isLoadingRoot || !repositoryName) {
        return <div>Loading...</div>;
    }

    return (
        <Tree.Root {...props}>
            <Tree.Folder
                value="/"
                name={repositoryName}
                disabled={repository?.isSelected}>
                {safeArray(rootDirectories).map((dir) => {
                    return (
                        <LazyTreeFolder
                            key={dir.path}
                            directory={dir}
                            loadDirectory={loadDirectory}
                            repository={repository}
                            repositoryId={repositoryId}
                            excludeGroupId={excludeGroupId}
                        />
                    );
                })}
            </Tree.Folder>
        </Tree.Root>
    );
};
