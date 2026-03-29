"use client";

import { useEffect, useState } from "react";
import { Button } from "@components/ui/button";
import { SvgGithub } from "@components/ui/icons/SvgGithub";
import { Link } from "@components/ui/link";
import { useQuery } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

const repository = "kodustech/kodus-ai";
const repositoryUrl = `https://github.com/${repository}`;
const localStorageKey = "hide-github-stars-on-navbar";
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

const GithubStarsContent = () => {
    const [visible, setVisible] = useState(true);

    useEffect(() => {
        setVisible(localStorage.getItem(localStorageKey) !== "true");
    }, []);

    const { data } = useQuery({
        queryKey: ["github-project-repository-data"],
        staleTime: CACHE_TTL_MS,
        gcTime: CACHE_TTL_MS * 6,
        refetchOnWindowFocus: false,
        retry: 1,
        queryFn: async ({ signal }) => {
            try {
                const response = await fetch("/api/github-stars", {
                    signal,
                });

                if (!response.ok) {
                    return null;
                }

                const payload = (await response.json()) as {
                    stargazers_count: number | null;
                };

                if (typeof payload.stargazers_count !== "number") {
                    return null;
                }

                return payload;
            } catch {
                return null;
            }
        },
    });

    if (!visible) return null;

    return (
        <div className={cn("group relative flex gap-px")}>
            <div className="absolute -top-2 -right-1 z-1 hidden group-hover:block">
                <Button
                    size="icon-xs"
                    variant="tertiary"
                    className="size-4 [--icon-size:calc(var(--spacing)*3)]"
                    onClick={() => {
                        localStorage.setItem(localStorageKey, "true");
                        setVisible(false);
                    }}>
                    <XIcon />
                </Button>
            </div>

            <Link target="_blank" href={repositoryUrl}>
                <Button
                    decorative
                    size="sm"
                    variant="helper"
                    className="rounded-r-none"
                    leftIcon={<SvgGithub />}>
                    Star
                </Button>
            </Link>

            {data ? (
                <Link target="_blank" href={`${repositoryUrl}/stargazers`}>
                    <Button
                        active
                        decorative
                        size="sm"
                        variant="helper"
                        className={cn(
                            "button-focused:text-primary-light",
                            "button-hover:text-primary-light",
                            "rounded-l-none",
                        )}>
                        {data.stargazers_count}
                    </Button>
                </Link>
            ) : null}
        </div>
    );
};

export const GithubStars = () => {
    return <GithubStarsContent />;
};
