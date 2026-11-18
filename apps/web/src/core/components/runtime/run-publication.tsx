import type { RunPublication } from "@services/runtime/contracts";
import {
    publicationLine,
    type PublicationKind,
} from "@services/runtime/model/publication";

import { RelativeTime } from "./relative-time";
import { StatusChip } from "./status-chip";

const KIND_LABEL: Record<PublicationKind, string> = {
    check: "Check",
    comment: "Comment",
};

const PublicationRow = ({
    kind,
    publication,
}: {
    kind: PublicationKind;
    publication: RunPublication;
}) => {
    const view = publication[kind];
    const line = publicationLine(kind, view);
    return (
        <li className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-text-secondary w-20">
                    {KIND_LABEL[kind]}
                </span>
                <StatusChip tone={line.tone}>{line.label}</StatusChip>
                {view.at && view.status !== "not_expected" && (
                    <span className="text-text-tertiary text-xs">
                        <RelativeTime at={view.at} />
                    </span>
                )}
            </div>
            {line.detail && (
                <p className="text-text-tertiary pl-22 text-xs">
                    {line.detail}
                </p>
            )}
        </li>
    );
};

/**
 * What the pull request shows for this Run: the check and the comment, as
 * the product recorded them. A simulation says that it posts nothing.
 */
export const RunPublicationStatus = ({
    publication,
}: {
    publication: RunPublication | undefined;
}) => {
    if (!publication) return null;
    if (!publication.postsToPullRequest) {
        return (
            <p role="note" className="text-text-secondary text-sm">
                Simulation: Kodus posts nothing on the pull request for this
                Run. The result is only on this page.
            </p>
        );
    }
    return (
        <ul className="flex flex-col gap-3" aria-label="On the pull request">
            <PublicationRow kind="check" publication={publication} />
            <PublicationRow kind="comment" publication={publication} />
        </ul>
    );
};
