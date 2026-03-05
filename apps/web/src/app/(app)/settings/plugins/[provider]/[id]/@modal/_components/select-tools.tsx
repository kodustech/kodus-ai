"use client";

import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import { Checkbox } from "@components/ui/checkbox";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import { Heading } from "@components/ui/heading";
import { Input } from "@components/ui/input";
import { ToggleGroup } from "@components/ui/toggle-group";
import type { getMCPPluginTools } from "@services/mcp-manager/fetch";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { AlertTriangleIcon, SearchIcon } from "lucide-react";
import type { AwaitedReturnType } from "src/core/types";
import { cn } from "src/core/utils/components";

export const SelectTools = ({
    selectedTools,
    setSelectedToolsAction,
    tools,
    defaultOpen,
}: {
    defaultOpen: boolean;
    selectedTools: Array<string>;
    setSelectedToolsAction: Dispatch<SetStateAction<Array<string>>>;
    tools: AwaitedReturnType<typeof getMCPPluginTools>;
}) => {
    const canEdit = usePermission(Action.Update, ResourceType.PluginSettings);
    const alphabeticallySortedTools = useMemo(
        () => tools.sort((a, b) => (a.name > b.name ? 1 : -1)),
        [tools],
    );

    const [searchQuery, setSearchQuery] = useState("");
    const filteredTools = useMemo(() => {
        const lowerQuery = searchQuery.toLowerCase();
        return alphabeticallySortedTools.filter(
            (t) =>
                t.name.toLowerCase().includes(lowerQuery) ||
                t.description.toLowerCase().includes(lowerQuery),
        );
    }, [alphabeticallySortedTools, searchQuery]);

    const isAllToolsSelected = useMemo(
        () => selectedTools.length === tools.length,
        [selectedTools.length, tools.length],
    );

    return (
        <Collapsible defaultOpen={defaultOpen}>
            <Card className="w-full" color="lv1">
                <CollapsibleTrigger asChild>
                    <Button
                        size="sm"
                        variant="cancel"
                        className="min-h-auto w-full py-0"
                        leftIcon={<CollapsibleIndicator />}>
                        <CardHeader className="flex-row justify-between px-0 py-4">
                            <span className="text-sm font-bold">
                                Selected tools
                            </span>

                            <div className="flex items-center gap-1 text-sm">
                                <span className="font-bold">
                                    {selectedTools.length}
                                </span>
                                <span>of {tools.length}</span>

                                {selectedTools.length === 0 && (
                                    <AlertTriangleIcon className="text-alert ml-2" />
                                )}
                            </div>
                        </CardHeader>
                    </Button>
                </CollapsibleTrigger>

                <CollapsibleContent className="pb-0">
                    <div className="mt-1 mb-2 flex items-center gap-2 px-3">
                        <Input
                            size="md"
                            value={searchQuery}
                            className="w-full flex-1"
                            placeholder="Search by name or description..."
                            onChange={(e) => setSearchQuery(e.target.value)}
                            leftIcon={
                                <SearchIcon className="text-text-secondary" />
                            }
                        />

                        <Button
                            size="md"
                            variant="primary-dark"
                            disabled={!canEdit}
                            onClick={() => {
                                if (isAllToolsSelected) {
                                    return setSelectedToolsAction([]);
                                }

                                setSelectedToolsAction(
                                    tools.map(({ slug }) => slug),
                                );
                            }}>
                            {isAllToolsSelected ? "Unselect all" : "Select all"}
                        </Button>
                    </div>

                    <div className="max-h-120 overflow-auto px-3 py-1">
                        <ToggleGroup.Root
                            type="multiple"
                            value={selectedTools}
                            onValueChange={setSelectedToolsAction}
                            className="columns-2 space-y-2 gap-x-2 pb-4">
                            {filteredTools.map((tool) => (
                                <ToggleGroup.ToggleGroupItem
                                    asChild
                                    key={tool.slug}
                                    value={tool.slug}>
                                    <Button
                                        size="sm"
                                        variant="helper"
                                        disabled={!canEdit}
                                        className="w-full items-start justify-start gap-3 py-4 font-normal">
                                        <Checkbox
                                            decorative
                                            className={cn(
                                                "size-5",
                                                tool.warning &&
                                                    "[--button-background:var(--color-warning)]",
                                            )}
                                            checked={selectedTools.includes(
                                                tool.slug,
                                            )}
                                        />

                                        <div className="flex flex-col">
                                            <Heading
                                                variant="h3"
                                                className={cn(
                                                    "text-text-primary min-h-5",
                                                    tool.warning &&
                                                        "text-warning",
                                                )}>
                                                {tool.name}

                                                {tool.warning && (
                                                    <AlertTriangleIcon className="text-warning ml-1.5 inline" />
                                                )}
                                            </Heading>

                                            <span className="text-xs">
                                                {tool.description}
                                            </span>
                                        </div>
                                    </Button>
                                </ToggleGroup.ToggleGroupItem>
                            ))}
                        </ToggleGroup.Root>
                    </div>
                </CollapsibleContent>
            </Card>
        </Collapsible>
    );
};
