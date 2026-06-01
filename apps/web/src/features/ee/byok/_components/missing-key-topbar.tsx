import { Link } from "@components/ui/link";
import { ArrowRightIcon } from "lucide-react";
import { isSelfHosted } from "src/core/utils/self-hosted";

export const BYOKMissingKeyTopbar = () => {
    return (
        <div className="bg-warning/30 px-4 py-2 text-center text-sm text-pretty">
            No LLM provider configured. Kodus can&apos;t review PRs until you
            add a key
            {isSelfHosted ? (
                <>
                    {" — via BYOK settings or your "}
                    <code className="bg-card-lv2 rounded px-1 py-0.5 font-mono text-xs">
                        .env
                    </code>{" "}
                    file.
                </>
            ) : (
                "."
            )}
            <Link href="/organization/byok" className="mx-2 font-bold">
                Set LLM keys
                <ArrowRightIcon className="ml-1 inline size-5" />
            </Link>
        </div>
    );
};
