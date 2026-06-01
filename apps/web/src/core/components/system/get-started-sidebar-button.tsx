"use client";

import { useEffect, useState } from "react";
import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
import { Image } from "@components/ui/image";
import { Link } from "@components/ui/link";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import { Progress } from "@components/ui/progress";
import { Separator } from "@components/ui/separator";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { UserRole } from "@enums";
import { useEffectOnce } from "@hooks/use-effect-once";
import { ArrowRight, Sparkles } from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";
import { useConfig } from "@providers/ConfigProvider";
import { cn } from "src/core/utils/components";
import { ClientSideCookieHelpers } from "src/core/utils/cookie";
import type { PublicConfig } from "@config/publicConfig";

// TASKS is built per-render so the "Explore our docs" href can come from
// useConfig() instead of process.env (which used to inline at build time).
function buildTasks(cfg: PublicConfig) {
    return [
        {
            label: "Create a Kody Rule",
            key: "get-started/create-kody-rule",
            href: "/settings/code-review/global/kody-rules",
        },
        {
            label: "Adjust your workspace settings",
            key: "get-started/adjust-workspace-settings",
            href: "/settings/code-review/global/general",
        },
        {
            label: "Connect a new repository",
            key: "get-started/connect-new-repository",
            href: "/settings/git",
        },
        {
            label: "Explore our docs",
            key: "get-started/explore-docs",
            href: cfg.supportDocsUrl as `https://${string}`,
        },
        {
            label: "Invite a teammate to Kodus",
            key: "get-started/invite-teammate",
            href: "/settings/subscription?tab=admins",
        },
    ] as const;
}

type Task = ReturnType<typeof buildTasks>[number];

const HIDDEN_STATE_KEY = "get-started/hidden";

export const GetStartedSidebarButton = () => {
    const { role } = useAuth();
    const cfg = useConfig();
    const TASKS = buildTasks(cfg);
    const MAX = TASKS.length;
    if (role !== UserRole.OWNER) return null;

    const [isOpen, _setIsOpen] = useState(false);
    const [isVisible, _setIsVisible] = useState(false);

    const [tasksCompletion, _setTasksCompletion] = useState(
        TASKS.reduce(
            (acc, current) => {
                acc[current.key] =
                    ClientSideCookieHelpers(current.key).get() === "true";
                return acc;
            },
            {} as Record<Task["key"], boolean>,
        ),
    );

    useEffectOnce(() => {
        if (ClientSideCookieHelpers(HIDDEN_STATE_KEY).get() !== "true") {
            _setIsVisible(true);
        }
    });

    useEffect(() => {
        if (!isVisible) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            // Cmd/Ctrl + Alt/Option + G
            if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === "KeyG") {
                e.preventDefault();
                document
                    .querySelector<HTMLButtonElement>(
                        "[data-get-started-button]",
                    )
                    ?.click();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isVisible]);

    if (!isVisible) return null;

    const closePopover = () => {
        ClientSideCookieHelpers(HIDDEN_STATE_KEY).set("true");
        _setIsVisible(false);
    };

    const setTaskCompletion = (key: Task["key"]) => {
        ClientSideCookieHelpers(key).set("true");

        _setTasksCompletion((tc) => {
            const newTasksCompletion = { ...tc, [key]: true };

            if (Object.values(newTasksCompletion).every((t) => t)) {
                closePopover();
            }

            return newTasksCompletion;
        });

        _setIsOpen(false);
    };

    const value = Object.values(tasksCompletion).filter((t) => t).length;

    return (
        <Popover open={isOpen} onOpenChange={_setIsOpen}>
            <TooltipProvider>
                <Tooltip delayDuration={300}>
                    <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                            <button
                                data-get-started-button
                                className={cn(
                                    "group relative flex flex-col items-center justify-center",
                                    "w-full px-2 py-4",
                                    "text-text-tertiary hover:text-text-primary",
                                    "hover:bg-background-tertiary transition-all duration-200",
                                    "cursor-pointer border-0 bg-transparent",
                                )}>
                                <Sparkles className="mb-2 size-5" />
                                <span
                                    className="text-md leading-tight font-medium tracking-tight"
                                    style={{
                                        writingMode: "vertical-rl",
                                        textOrientation: "mixed",
                                    }}>
                                    Get Started
                                </span>
                                {value < MAX && (
                                    <div
                                        className={cn(
                                            "bg-primary text-primary-foreground rounded-full",
                                            "absolute top-2 right-2",
                                            "flex size-5 items-center justify-center",
                                            "text-[10px] font-bold",
                                        )}>
                                        {MAX - value}
                                    </div>
                                )}
                            </button>
                        </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="left" sideOffset={10}>
                        <div className="flex flex-col gap-1">
                            <span className="font-semibold">Get Started</span>
                            <span className="text-text-tertiary text-[11px]">
                                ⌘⌥G
                            </span>
                            {value < MAX && (
                                <span className="text-text-tertiary text-[11px]">
                                    {MAX - value} tasks remaining
                                </span>
                            )}
                        </div>
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>

            <PopoverContent
                align="end"
                side="left"
                sideOffset={10}
                className="w-72">
                <div className="relative">
                    <h3 className="font-bold">Getting started</h3>

                    <div className="-mx-4">
                        <Separator className="mt-3 mb-4" />
                    </div>

                    <div className="absolute -right-1 -bottom-3 size-14">
                        <Image src="/assets/images/kody/look-left-with-paws.png" />
                    </div>
                </div>

                <div className="text-text-tertiary mb-1 flex justify-end gap-0.5 text-xs">
                    <span className="text-text-primary">{value}</span>/
                    <span>{MAX}</span>
                </div>

                <Progress
                    max={MAX}
                    value={value}
                    variant="secondary"
                    className="h-3"
                />

                <div className="my-4 flex flex-col gap-2">
                    {TASKS.map((t) => (
                        <Link
                            key={t.key}
                            href={t.href}
                            onClick={() => setTaskCompletion(t.key)}>
                            <li className="text-text-secondary flex items-center gap-1 text-[13px]">
                                <Checkbox
                                    decorative
                                    checked={tasksCompletion[t.key]}
                                    className="pointer-events-none mr-2 size-5"
                                />

                                <div
                                    className={cn(
                                        "flex items-center gap-1",
                                        tasksCompletion[t.key] &&
                                            "line-through",
                                    )}>
                                    {t.label} <ArrowRight className="size-4" />
                                </div>
                            </li>
                        </Link>
                    ))}
                </div>

                <Button
                    size="xs"
                    variant="cancel"
                    className="text-tertiary-light w-full"
                    onClick={() => closePopover()}>
                    Dismiss
                </Button>
            </PopoverContent>
        </Popover>
    );
};
