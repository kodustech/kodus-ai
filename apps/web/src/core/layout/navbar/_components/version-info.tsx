"use client";

import { Link } from "@components/ui/link";
import { typedFetch } from "@services/fetch";
import { useQuery } from "@tanstack/react-query";

type VersionData = {
    current: string;
    latest: string | null;
    hasUpdate: boolean;
};

const RELEASES_URL = "https://github.com/kodustech/kodus-ai/releases/latest";

export const VERSION_QUERY = {
    queryKey: ["app-version"],
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
        typedFetch<VersionData>("/api/version", { signal }),
    staleTime: 1000 * 60 * 60,
    gcTime: 1000 * 60 * 60 * 6,
    refetchOnWindowFocus: false,
    retry: 1,
};

export const VersionInfo = ({
    showUpdate = false,
}: {
    showUpdate?: boolean;
}) => {
    const { data } = useQuery(VERSION_QUERY);

    if (!data || data.current === "unknown") return null;

    return (
        <div className="text-text-tertiary flex items-center gap-1.5 text-xs">
            <span>{data.current}</span>
            {showUpdate && data.hasUpdate && data.latest && (
                <Link
                    href={RELEASES_URL}
                    target="_blank"
                    className="text-primary-light hover:underline">
                    {data.latest} available
                </Link>
            )}
        </div>
    );
};
