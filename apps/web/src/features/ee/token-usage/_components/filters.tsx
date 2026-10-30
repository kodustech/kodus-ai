"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@components/ui/command";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@components/ui/dropdown-menu";
import { Input } from "@components/ui/input";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";

import { useGetSelectedRepositories } from "@services/codeManagement/hooks";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { safeArray } from "src/core/utils/safe-array";

import { useTokenUsageFilters } from "../_hooks/filter.hook";

export const Filters = ({
    models,
    developers,
    teamId,
    filters,
}: {
    models: string[];
    developers: string[];
    teamId: string;
    filters: ReturnType<typeof useTokenUsageFilters>;
}) => {
    const {
        currentFilter,
        selectedModels,
        prNumber,
        developer,
        selectedRepositoryId,
        handleRepositoryChange,
        handleFilterChange,
        handleModelChange,
        handlePrNumberChange,
        handleDeveloperChange,
        handleDeveloperSelect,
        setSelectedModels,
        getModelSelectionText,
    } = filters;
    const [developerOpen, setDeveloperOpen] = useState(false);

    const { data: repositories } = useGetSelectedRepositories(teamId);
    const repoOptions = safeArray(repositories);
    const [repoOpen, setRepoOpen] = useState(false);
    const selectedRepoName = selectedRepositoryId
        ? (repoOptions.find((r) => r.id === selectedRepositoryId)?.name ??
          "All repositories")
        : "All repositories";

    return (
        <div className="flex gap-4">
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        size="md"
                        variant="helper"
                        className="max-w-[350px] min-w-[200px] justify-between">
                        <span className="truncate">
                            {getModelSelectionText()}
                        </span>
                        <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    className="max-w-[400px] min-w-[200px]"
                    onCloseAutoFocus={(e) => e.preventDefault()}>
                    <DropdownMenuLabel>Models</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        onSelect={(e) => {
                            e.preventDefault();

                            if (selectedModels.length === models.length) {
                                setSelectedModels([]);
                            } else {
                                setSelectedModels(models);
                            }
                        }}>
                        <div className="flex items-center gap-2">
                            <Checkbox
                                checked={
                                    selectedModels.length === models.length
                                }
                            />
                            <span>All models</span>
                        </div>
                    </DropdownMenuItem>
                    {models.map((model) => (
                        <DropdownMenuItem
                            key={model}
                            onSelect={(e) => {
                                e.preventDefault();
                                handleModelChange(model);
                            }}>
                            <div className="flex items-center gap-2">
                                <Checkbox
                                    checked={selectedModels.includes(model)}
                                />
                                <span className="break-all">{model}</span>
                            </div>
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>

            {repoOptions.length > 0 && (
                <Popover open={repoOpen} onOpenChange={setRepoOpen} modal>
                    <PopoverTrigger asChild>
                        <Button
                            size="md"
                            variant="helper"
                            role="combobox"
                            aria-expanded={repoOpen}
                            className="w-[220px] justify-between">
                            <span className="truncate">
                                {selectedRepoName}
                            </span>
                            <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
                        </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[260px] p-0" align="start">
                        <Command>
                            <CommandInput placeholder="Search repositories..." />
                            <CommandList className="max-h-64 overflow-y-auto">
                                <CommandEmpty>
                                    No repository found.
                                </CommandEmpty>
                                <CommandGroup>
                                    <CommandItem
                                        value="All repositories"
                                        onSelect={() => {
                                            handleRepositoryChange("");
                                            setRepoOpen(false);
                                        }}>
                                        <span>All repositories</span>
                                        {!selectedRepositoryId && (
                                            <CheckIcon className="text-primary-light -mr-2 size-5" />
                                        )}
                                    </CommandItem>
                                    {repoOptions.map((repo) => (
                                        <CommandItem
                                            key={repo.id}
                                            value={repo.name}
                                            onSelect={() => {
                                                handleRepositoryChange(repo.id);
                                                setRepoOpen(false);
                                            }}>
                                            <span className="truncate">
                                                {repo.name}
                                            </span>
                                            {selectedRepositoryId ===
                                                repo.id && (
                                                <CheckIcon className="text-primary-light -mr-2 size-5 shrink-0" />
                                            )}
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            </CommandList>
                        </Command>
                    </PopoverContent>
                </Popover>
            )}

            <Select
                onValueChange={handleFilterChange}
                defaultValue={currentFilter}>
                <SelectTrigger className="w-[200px]">
                    <SelectValue placeholder="Filter by" />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="by-pr">By PR</SelectItem>
                    <SelectItem value="by-review">By Review</SelectItem>
                    <SelectItem value="by-developer">By Developer</SelectItem>
                </SelectContent>
            </Select>
            {currentFilter === "by-pr" && (
                <Input
                    type="number"
                    placeholder="PR Number"
                    value={prNumber}
                    onChange={handlePrNumberChange}
                    className="w-[150px]"
                />
            )}
            {currentFilter === "by-developer" &&
                (developers.length > 0 ? (
                    <Popover
                        open={developerOpen}
                        onOpenChange={setDeveloperOpen}
                        modal>
                        <PopoverTrigger asChild>
                            <Button
                                size="md"
                                variant="helper"
                                role="combobox"
                                aria-expanded={developerOpen}
                                className="w-[200px] justify-between">
                                <span className="truncate">
                                    {developer || "All developers"}
                                </span>
                                <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent
                            className="w-[240px] p-0"
                            align="start">
                            <Command>
                                <CommandInput placeholder="Search developers..." />
                                <CommandList className="max-h-64 overflow-y-auto">
                                    <CommandEmpty>
                                        No developer found.
                                    </CommandEmpty>
                                    <CommandGroup>
                                        <CommandItem
                                            value="All developers"
                                            onSelect={() => {
                                                handleDeveloperSelect("");
                                                setDeveloperOpen(false);
                                            }}>
                                            <span>All developers</span>
                                            {!developer && (
                                                <CheckIcon className="text-primary-light -mr-2 size-5" />
                                            )}
                                        </CommandItem>
                                        {developers.map((dev) => (
                                            <CommandItem
                                                key={dev}
                                                value={dev}
                                                onSelect={() => {
                                                    handleDeveloperSelect(dev);
                                                    setDeveloperOpen(false);
                                                }}>
                                                <span className="truncate">
                                                    {dev}
                                                </span>
                                                {developer === dev && (
                                                    <CheckIcon className="text-primary-light -mr-2 size-5 shrink-0" />
                                                )}
                                            </CommandItem>
                                        ))}
                                    </CommandGroup>
                                </CommandList>
                            </Command>
                        </PopoverContent>
                    </Popover>
                ) : (
                    // Fallback to free text when the roster is empty (e.g. the
                    // window has no attributable PR authors yet).
                    <Input
                        type="text"
                        placeholder="Developer"
                        value={developer}
                        onChange={handleDeveloperChange}
                        className="w-[150px]"
                    />
                ))}
        </div>
    );
};
