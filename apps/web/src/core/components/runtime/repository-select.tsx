"use client";

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import type { CodeReviewScope } from "@services/parameters/use-code-review-scopes";

/** Picks one of the team's repositories; the Runs list is per repository. */
export const RepositorySelect = ({
    repositories,
    value,
    onChange,
}: {
    repositories: CodeReviewScope[];
    value: string | undefined;
    onChange: (repositoryId: string) => void;
}) => (
    <Select value={value ?? ""} onValueChange={onChange}>
        <SelectTrigger className="w-72" aria-label="Repository">
            <SelectValue placeholder="Choose a repository" />
        </SelectTrigger>
        <SelectContent>
            {repositories.map((repository) => (
                <SelectItem key={repository.id} value={repository.id}>
                    {repository.name}
                </SelectItem>
            ))}
        </SelectContent>
    </Select>
);
