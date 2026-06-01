"use client";

import { Children, createContext, use, useState } from "react";
import { ChevronDownIcon, FolderIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

import { Button } from "./button";
import { Checkbox } from "./checkbox";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "./collapsible";
import { RadioGroup } from "./radio-group";

const TreeContext = createContext<{
    multiple: boolean;
    values: string[];
    onToggle: (value: string) => void;
}>({ multiple: false, values: [], onToggle: () => {} });

type TreeRootSingleProps = React.PropsWithChildren & {
    multiple?: false;
    value: string | undefined;
    onValueChange: (value: string) => void;
};

type TreeRootMultipleProps = React.PropsWithChildren & {
    multiple: true;
    value: string[];
    onValueChange: (value: string[]) => void;
};

const TreeRoot = (props: TreeRootSingleProps | TreeRootMultipleProps) => {
    if (props.multiple) {
        const handleToggle = (val: string) => {
            const current = props.value;
            if (current.includes(val)) {
                props.onValueChange(current.filter((v) => v !== val));
            } else {
                props.onValueChange([...current, val]);
            }
        };

        return (
            <div className="text-sm">
                <TreeContext
                    value={{
                        multiple: true,
                        values: props.value,
                        onToggle: handleToggle,
                    }}>
                    {props.children}
                </TreeContext>
            </div>
        );
    }

    return (
        <div className="text-sm">
            <TreeContext
                value={{ multiple: false, values: [], onToggle: () => {} }}>
                <RadioGroup.Root
                    className="gap-0"
                    value={props.value}
                    onValueChange={props.onValueChange}>
                    {props.children}
                </RadioGroup.Root>
            </TreeContext>
        </div>
    );
};

const TreeFolder = (
    props: React.PropsWithChildren & {
        name: string;
        value: string;
        disabled?: boolean;
        onOpenChange?: (open: boolean) => void;
        hasChildren?: boolean;
    },
) => {
    const [open, setOpen] = useState(false);
    const ctx = use(TreeContext);

    const hasChildren =
        props.hasChildren ?? Children.toArray(props.children).some((c) => !!c);

    const handleOpenChange = (newOpen: boolean) => {
        setOpen(newOpen);
        props.onOpenChange?.(newOpen);
    };

    const isChecked = ctx.multiple && ctx.values.includes(props.value);

    return (
        <Collapsible
            open={open}
            onOpenChange={handleOpenChange}
            disabled={!hasChildren}>
            <div className="flex w-fit items-center gap-3">
                {ctx.multiple ? (
                    <Checkbox
                        checked={isChecked}
                        disabled={props.disabled}
                        onCheckedChange={() => ctx.onToggle(props.value)}
                        className="peer"
                    />
                ) : (
                    <RadioGroup.Item
                        value={props.value}
                        className="peer"
                        disabled={props.disabled}
                    />
                )}

                <CollapsibleTrigger asChild>
                    <Button
                        size="sm"
                        variant="cancel"
                        data-disabled={undefined}
                        className={cn(
                            "flex items-center px-0 py-0 font-medium",
                            (ctx.multiple ? isChecked : false) &&
                                "text-text-primary",
                            !ctx.multiple &&
                                "peer-data-[state=checked]:text-text-primary",
                        )}>
                        <div className="flex items-center gap-2">
                            <FolderIcon className="size-5" />

                            <div className="flex items-center gap-2">
                                <span>{props.name}</span>
                            </div>
                        </div>

                        {hasChildren && (
                            <ChevronDownIcon
                                className={cn(
                                    "text-text-tertiary size-3! shrink-0 transition duration-200",
                                    open ? "rotate-180" : "rotate-0",
                                )}
                            />
                        )}
                    </Button>
                </CollapsibleTrigger>
            </div>

            <CollapsibleContent className="mb-1 ml-1.5 border-l pb-0 pl-3">
                {props.children}
            </CollapsibleContent>
        </Collapsible>
    );
};

export const Tree = {
    Root: TreeRoot,
    Folder: TreeFolder,
};
