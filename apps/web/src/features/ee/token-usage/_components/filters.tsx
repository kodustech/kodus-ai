"use client";

import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
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
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";

import { useTokenUsageFilters } from "../_hooks/filter.hook";

export const Filters = ({
    models,
    filters,
}: {
    models: string[];
    filters: ReturnType<typeof useTokenUsageFilters>;
}) => {
    const {
        currentFilter,
        selectedModels,
        prNumber,
        developer,
        handleFilterChange,
        handleModelChange,
        handlePrNumberChange,
        handleDeveloperChange,
        setSelectedModels,
        getModelSelectionText,
    } = filters;

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

            <Select
                onValueChange={handleFilterChange}
                defaultValue={currentFilter}>
                <SelectTrigger className="w-[200px]">
                    <SelectValue placeholder="Filter by" />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="by-pr">By PR</SelectItem>
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
            {currentFilter === "by-developer" && (
                <Input
                    type="text"
                    placeholder="Developer"
                    value={developer}
                    onChange={handleDeveloperChange}
                    className="w-[150px]"
                />
            )}
        </div>
    );
};
