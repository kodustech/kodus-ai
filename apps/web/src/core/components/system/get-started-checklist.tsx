"use client";

import { useState } from "react";
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
import { UserRole } from "@enums";
import { useEffectOnce } from "@hooks/use-effect-once";
import { ArrowRight } from "lucide-react";
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

export const GetStartedChecklist = () => {
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
        <div className="absolute right-8 bottom-4 h-12">
            <Popover open={isOpen} onOpenChange={_setIsOpen}>
                <PopoverTrigger asChild>
                    <Button
                        size="lg"
                        variant="primary"
                        className="group h-full overflow-visible text-black"
                        leftIcon={
                            <div className="-mr-2 -mb-0.5 -ml-3 size-11">
                                <Image src="/assets/images/kody/look-right.png" />
                            </div>
                        }
                        rightIcon={
                            <div
                                className={cn(
                                    "group-data-[state=open]:hidden",
                                    "bg-tertiary-dark text-tertiary-light rounded-full",
                                    "absolute -top-2 right-0",
                                    "flex size-4 items-center justify-center",
                                )}>
                                !
                            </div>
                        }>
                        Get started!
                    </Button>
                </PopoverTrigger>

                <PopoverContent
                    align="end"
                    side="top"
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
                                        {t.label}{" "}
                                        <ArrowRight className="size-4" />
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
        </div>
    );
};
