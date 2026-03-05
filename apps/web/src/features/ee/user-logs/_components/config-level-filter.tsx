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

type ConfigLevel = "all" | "main" | "global" | "repository";

interface ConfigLevelFilterProps {
    selectedLevel: ConfigLevel;
    onLevelChange: (level: ConfigLevel) => void;
}

const levels = [
    { value: "all" as const, label: "All levels" },
    { value: "main" as const, label: "Main" },
    { value: "global" as const, label: "Global" },
    { value: "repository" as const, label: "Repository" },
];

export const ConfigLevelFilter = ({
    selectedLevel,
    onLevelChange,
}: ConfigLevelFilterProps) => {
    const currentLevel = levels.find((level) => level.value === selectedLevel);

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    size="md"
                    variant="helper"
                    rightIcon={<ChevronDownIcon />}
                    className="justify-between">
                    <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="capitalize">
                            {currentLevel?.label}
                        </Badge>
                    </div>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                {levels.map((level) => (
                    <DropdownMenuItem
                        key={level.value}
                        onClick={() => onLevelChange(level.value)}>
                        <Badge variant="secondary" className="capitalize">
                            {level.label}
                        </Badge>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
