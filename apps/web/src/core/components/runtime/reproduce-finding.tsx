"use client";

import { useMemo, useState } from "react";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@components/ui/dialog";
import { toast } from "@components/ui/toaster/use-toast";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import { useRunReproduction } from "@services/runtime/queries";
import { readReproductionDownload } from "@services/runtime/model/reproduction";
import { CopyIcon, DownloadIcon, FileJsonIcon } from "lucide-react";

const download = (filename: string, json: string) => {
    const url = URL.createObjectURL(
        new Blob([json], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.click();
    URL.revokeObjectURL(url);
};

/**
 * Recorded reproduction data for inspection. Copy/download never executes
 * client code or promises equivalent isolated replay.
 */
export const ReproduceFinding = ({
    runId,
    probeId,
    entryPoint,
}: {
    runId: string;
    probeId: string;
    entryPoint: string;
}) => {
    const [open, setOpen] = useState(false);
    const query = useRunReproduction(runId, probeId, open);
    const data = readReproductionDownload(query.data, { runId, probeId });
    const json = useMemo(() => data ? JSON.stringify(data.manifest, null, 2) : "", [data]);

    const copy = async () => {
        if (!data) return;
        try {
            await navigator.clipboard.writeText(json);
            toast({ variant: "success", title: "JSON copied" });
        } catch {
            toast({
                variant: "danger",
                title: "Couldn't copy",
                description: "Download the JSON instead.",
            });
        }
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button
                    variant="helper"
                    size="sm"
                    leftIcon={<FileJsonIcon />}
                    aria-label={`Reproduction data: ${entryPoint}`}>
                    Reproduction data
                </Button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Reproduction data</DialogTitle>
                    <DialogDescription>
                        Data only: recorded repository versions, the redacted check
                        and observations. This JSON does not execute code or recreate
                        the environment. An isolated replay is not available here.
                    </DialogDescription>
                </DialogHeader>
                {query.isPending ? (
                    <p className="text-text-secondary text-sm">
                        Loading reproduction data…
                    </p>
                ) : query.isError || !data ? (
                    <p className="text-danger text-sm" role="alert">
                        {runtimeErrorMessage(query.error, {
                            fallback:
                                "Reproduction data is unavailable for this finding.",
                        })}
                    </p>
                ) : (
                    <pre className="bg-card-lv1 max-h-[50vh] overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre">
                        {json}
                    </pre>
                )}
                <DialogFooter>
                    <Button
                        variant="secondary"
                        size="sm"
                        leftIcon={<CopyIcon />}
                        disabled={!data}
                        onClick={copy}>
                        Copy JSON
                    </Button>
                    <Button
                        variant="primary"
                        size="sm"
                        leftIcon={<DownloadIcon />}
                        disabled={!data}
                        onClick={() =>
                            data && download(data.filename, json)
                        }>
                        Download JSON
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
