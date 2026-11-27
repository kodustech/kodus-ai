"use client";

import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import type { RunsRepositories } from "@services/runtime/model/runs-repositories";

/**
 * Picks one of the team's repositories; the Runs list is per repository. The ones with an environment come first,
 * with its state: only they can have Runs. The others follow under their own label.
 */
export const RepositorySelect = ({
    repositories,
    value,
    onChange,
}: {
    repositories: Pick<RunsRepositories, "withEnvironment" | "others">;
    value: string | undefined;
    onChange: (repositoryId: string) => void;
}) => (
    <Select value={value ?? ""} onValueChange={onChange}>
        <SelectTrigger className="w-72" aria-label="Repository">
            <SelectValue placeholder="Choose a repository" />
        </SelectTrigger>
        <SelectContent>
            {repositories.withEnvironment.length > 0 && (
                <SelectGroup>
                    <SelectLabel>With an environment</SelectLabel>
                    {repositories.withEnvironment.map((repository) => (
                        <SelectItem key={repository.id} value={repository.id}>
                            {repository.name}
                            {repository.status && (
                                <span className="text-text-tertiary ml-2 text-xs">
                                    {repository.status.label}
                                </span>
                            )}
                        </SelectItem>
                    ))}
                </SelectGroup>
            )}
            {repositories.others.length > 0 && (
                <SelectGroup>
                    {repositories.withEnvironment.length > 0 && (
                        <SelectLabel>No environment</SelectLabel>
                    )}
                    {repositories.others.map((repository) => (
                        <SelectItem key={repository.id} value={repository.id}>
                            {repository.name}
                        </SelectItem>
                    ))}
                </SelectGroup>
            )}
        </SelectContent>
    </Select>
);
