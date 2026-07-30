import { Skeleton } from "@components/ui/skeleton";

export default function Loading() {
    return (
        <div className="flex flex-col gap-2">
            <div className="grid grid-cols-4 gap-2">
                <Skeleton className="h-32" />
                <Skeleton className="h-32" />
                <Skeleton className="h-32" />
                <Skeleton className="h-32" />
            </div>
            <Skeleton className="h-80" />
            <div className="grid grid-cols-2 gap-2">
                <Skeleton className="h-72" />
                <Skeleton className="h-72" />
            </div>
            <Skeleton className="h-96" />
        </div>
    );
}
