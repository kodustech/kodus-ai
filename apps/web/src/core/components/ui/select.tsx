"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { CheckIcon, ChevronDown } from "lucide-react";
import { cn } from "src/core/utils/components";

import { Button } from "./button";
import { Spinner } from "./spinner";

const Select = SelectPrimitive.Root;

const SelectGroup = SelectPrimitive.Group;

const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef<
    React.ComponentRef<typeof SelectPrimitive.Trigger>,
    React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> &
        Partial<React.ComponentPropsWithoutRef<typeof Button>>
>(({ className, loading, disabled, children, ...props }, ref) => (
    <SelectPrimitive.Trigger
        ref={ref}
        {...props}
        disabled={disabled || loading}
        className={cn(
            "ring-card-lv3 w-full justify-between font-normal ring-1",
            "data-placeholder:text-text-placeholder/50",
            className,
        )}
        asChild>
        <Button
            size={props.size ?? "lg"}
            variant={props.variant ?? "helper"}
            data-disabled={undefined}
            data-loading={loading ? "true" : undefined}
            rightIcon={
                loading ? (
                    <Spinner className="-mr-1.5 size-(--icon-size)! fill-(--button-foreground)/10 text-(--button-foreground)" />
                ) : (
                    <SelectPrimitive.Icon asChild>
                        <ChevronDown className="-mr-1.5" />
                    </SelectPrimitive.Icon>
                )
            }>
            {children}
        </Button>
    </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectContent = React.forwardRef<
    React.ComponentRef<typeof SelectPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => (
    <SelectPrimitive.Portal>
        <SelectPrimitive.Content
            ref={ref}
            position={position}
            {...props}
            className={cn(
                "relative z-50 overflow-hidden rounded-xl shadow-md backdrop-blur-2xl",
                "bg-card-lv2 ring-card-lv3 ring-1",
                "select-content-open:animate-in select-content-open:fade-in-0 select-content-open:zoom-in-95",
                "select-content-closed:animate-out select-content-closed:fade-out-0 select-content-closed:zoom-out-95",
                "select-content-bottom-side:slide-in-from-top-2",
                "select-content-left-side:slide-in-from-right-2",
                "select-content-right-side:slide-in-from-left-2",
                "select-content-top-side:slide-in-from-bottom-2",

                position === "popper" &&
                    cn(
                        "select-content-top-side:-translate-y-1",
                        "select-content-bottom-side:translate-y-1",
                        "select-content-left-side:-translate-x-1",
                        "select-content-right-side:translate-x-1",
                    ),
                className,
            )}>
            <SelectPrimitive.Viewport
                className={cn(
                    "max-h-72 space-y-1 overflow-y-auto p-1",
                    position === "popper" &&
                        "h-(--radix-select-trigger-height) w-full min-w-(--radix-select-trigger-width)",
                )}>
                {children}
            </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef<
    React.ComponentRef<typeof SelectPrimitive.Label>,
    React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
    <SelectPrimitive.Label
        ref={ref}
        className={cn("py-1.5 pr-2 pl-8 text-sm font-semibold", className)}
        {...props}
    />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

const SelectItem = React.forwardRef<
    React.ComponentRef<typeof SelectPrimitive.Item>,
    React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> &
        Partial<React.ComponentPropsWithoutRef<typeof Button>>
>(({ className, children, ...props }, ref) => (
    <SelectPrimitive.Item
        ref={ref}
        className={cn(
            "text-text-primary flex w-full items-center justify-between rounded-xl text-sm font-normal outline-hidden select-none",
            "select-item-selected:bg-card-lv3",
            "select-item-focused:ring-1 select-item-focused:ring-primary-light",
            "select-item-disabled:bg-transparent select-item-disabled:text-text-placeholder/30",
            className,
        )}
        {...props}
        asChild>
        <Button
            size="lg"
            variant="helper"
            rightIcon={
                <SelectPrimitive.ItemIndicator
                    className="text-primary-light -mr-2 shrink-0"
                    asChild>
                    <CheckIcon />
                </SelectPrimitive.ItemIndicator>
            }>
            <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        </Button>
    </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef<
    React.ComponentRef<typeof SelectPrimitive.Separator>,
    React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
    <SelectPrimitive.Separator
        ref={ref}
        className={cn("bg-card-lv3 my-1 h-px", className)}
        {...props}
    />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
};
