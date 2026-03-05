import { Button } from "@components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@components/ui/command";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import { formatDistanceToNow } from "date-fns";
import { ChevronsUpDown } from "lucide-react";

type PullRequest = {
    id: string;
    pull_number: number;
    repository: string;
    repositoryId: string;
    title: string;
    url: string;
    lastActivityAt?: string;
};

export const SelectPullRequest = (props: {
    id?: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    disabled?: boolean;

    value?: PullRequest;
    onChange: (value: PullRequest) => void;
    pullRequests: PullRequest[];
}) => {
    const {
        id = "select-pull-request",
        open,
        onOpenChange,
        disabled,
        pullRequests,
        onChange,
        value,
    } = props;

    const PRsGroupedByRepository = pullRequests.reduce(
        (acc, current) => {
            if (!acc[current.repository]) acc[current.repository] = [];
            acc[current.repository].push(current);
            return acc;
        },
        {} as Record<string, typeof pullRequests>,
    );

    const formatLastActivity = (date?: string) => {
        if (!date) return null;
        const parsed = new Date(date);
        if (Number.isNaN(parsed.getTime())) return null;
        return formatDistanceToNow(parsed, { addSuffix: true });
    };

    const selectedLastActivity = formatLastActivity(value?.lastActivityAt);

    return (
        <Popover open={open} onOpenChange={onOpenChange} modal>
            <PopoverTrigger asChild>
                <Button
                    id={id}
                    type="button"
                    size="lg"
                    variant="helper"
                    disabled={disabled}
                    className="flex min-h-16 w-full justify-between">
                    <div className="flex w-full items-center">
                        {!value ? (
                            <span className="text-text-tertiary flex-1">
                                Choose a pull request...
                            </span>
                        ) : (
                            <div className="flex flex-1 flex-col gap-1">
                                <span className="text-primary-light text-xs">
                                    {value.repository}
                                </span>

                                <span className="text-text-secondary line-clamp-1 wrap-anywhere">
                                    <strong>#{value.pull_number}</strong>{" "}
                                    {value.title}
                                </span>
                                {selectedLastActivity && (
                                    <span className="text-text-tertiary text-xs">
                                        Last activity {selectedLastActivity}
                                    </span>
                                )}
                            </div>
                        )}
                    </div>

                    <ChevronsUpDown className="-mr-2 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>

            <PopoverContent
                align="start"
                className="w-[var(--radix-popover-trigger-width)] p-0">
                <Command
                    className="w-full"
                    filter={(value, search) => {
                        const [repository, pr_number] = value.split("#");

                        const foundPullRequest = pullRequests.find(
                            (pr) =>
                                pr.pull_number.toString() === pr_number &&
                                pr.repository === repository,
                        );

                        if (foundPullRequest) {
                            const prNumberString =
                                foundPullRequest.pull_number.toString();
                            const prTitleLower =
                                foundPullRequest.title.toLowerCase();
                            const searchLower = search.toLowerCase(); // For case-insensitive title search

                            if (
                                prNumberString.includes(search) || // Original search term for number
                                `#${prNumberString}`.includes(search) || // Original search term for #number
                                prTitleLower.includes(searchLower)
                            ) {
                                return 1;
                            }
                        }

                        return 0;
                    }}>
                    <CommandInput placeholder="Search by title or number" />

                    <CommandList className="overflow-y-auto">
                        <CommandEmpty className="flex h-full items-center justify-center">
                            No pull request found with current search query
                        </CommandEmpty>

                        <div className="max-h-72">
                            {Object.entries(PRsGroupedByRepository).map(
                                ([repository, prs]) => (
                                    <CommandGroup
                                        heading={repository}
                                        key={repository}>
                                        {prs.map((pr) => {
                                            const lastActivity =
                                                formatLastActivity(
                                                    pr.lastActivityAt,
                                                );
                                            return (
                                                <CommandItem
                                                    key={`${pr.id}_${pr.pull_number}`}
                                                    value={`${repository}#${pr.pull_number}`}
                                                    onSelect={() =>
                                                        onChange(pr)
                                                    }
                                                    className="flex items-start justify-start">
                                                    <span className="flex flex-col items-start gap-1 text-left">
                                                        <span className="text-text-secondary line-clamp-2">
                                                            <strong className="mr-2 font-mono">
                                                                #
                                                                {pr.pull_number}
                                                            </strong>

                                                            {pr.title}
                                                        </span>
                                                        {lastActivity && (
                                                            <span className="text-text-tertiary text-xs">
                                                                Last activity{" "}
                                                                {lastActivity}
                                                            </span>
                                                        )}
                                                    </span>
                                                </CommandItem>
                                            );
                                        })}
                                    </CommandGroup>
                                ),
                            )}
                        </div>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
};
