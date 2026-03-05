"use client";

import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@components/ui/dropdown-menu";
import { ChevronDownIcon } from "lucide-react";

type ActionType = "all" | "add" | "create" | "edit" | "delete" | "clone";

interface ActionFilterProps {
    selectedAction: ActionType;
    onActionChange: (action: ActionType) => void;
}

const actions = [
    {
        value: "all" as const,
        label: "All actions",
        color: "bg-alert/10 text-alert ring-alert/64 [--button-foreground:var(--color-alert)]",
    },
    {
        value: "add" as const,
        label: "Add",
        color: "bg-success/10 text-success ring-success/64 [--button-foreground:var(--color-success)]",
    },
    {
        value: "create" as const,
        label: "Create",
        color: "bg-success/10 text-success ring-success/64 [--button-foreground:var(--color-success)]",
    },
    {
        value: "edit" as const,
        label: "Edit",
        color: "bg-info/10 text-info ring-info/64 [--button-foreground:var(--color-info)]",
    },
    {
        value: "delete" as const,
        label: "Delete",
        color: "bg-danger/10 text-danger ring-danger/64 [--button-foreground:var(--color-danger)]",
    },
    {
        value: "clone" as const,
        label: "Clone",
        color: "bg-warning/10 text-warning ring-warning/64 [--button-foreground:var(--color-warning)]",
    },
];

export const ActionFilter = ({
    selectedAction,
    onActionChange,
}: ActionFilterProps) => {
    const currentAction = actions.find(
        (action) => action.value === selectedAction,
    );

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    size="md"
                    variant="helper"
                    rightIcon={<ChevronDownIcon />}
                    className="justify-between">
                    <div className="flex items-center gap-2">
                        <Badge
                            className={`h-6 min-h-auto rounded-lg px-2 text-[10px] leading-px uppercase ring-1 ${currentAction?.color}`}>
                            {currentAction?.label}
                        </Badge>
                    </div>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                {actions.map((action) => (
                    <DropdownMenuItem
                        key={action.value}
                        onClick={() => onActionChange(action.value)}>
                        <Badge
                            className={`h-6 min-h-auto rounded-lg px-2 text-[10px] leading-px uppercase ring-1 ${action.color}`}>
                            {action.label}
                        </Badge>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
