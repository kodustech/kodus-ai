"use client";

import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import { Heading } from "@components/ui/heading";
import { Link } from "@components/ui/link";
import { SyntaxHighlight } from "@components/ui/syntax-highlight";
import type { IssueItem } from "@services/issues/types";
import {
    BracesIcon,
    FlaskConicalIcon,
    ShieldIcon,
    UserIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

import {
    cweUrl,
    formatSymbolLines,
    OWNER_ORIGIN_NOTE,
    reproductionStatus,
    VULNERABILITY_CLASS_LABEL,
} from "./format";

const linkClassName =
    "text-text-secondary link-hover:text-primary-light link-focused:text-primary-light underline";

const toneClassName = {
    danger: "text-danger",
    warning: "text-warning",
    neutral: "text-text-secondary",
} as const;

/** Rows for the issue sheet's link block: CWE and class, function, owner. */
export const IssueSecurityFacts = ({
    issue,
}: {
    issue: Pick<IssueItem, "security" | "owner">;
}) => {
    const { security, owner } = issue;
    const cwe = security?.cwe;
    const cweLink = cwe ? cweUrl(cwe) : undefined;
    const vulnerabilityClass = security?.vulnerabilityClass
        ? VULNERABILITY_CLASS_LABEL[security.vulnerabilityClass]
        : undefined;
    const symbol = security ? formatSymbolLines(security) : undefined;
    const ownerNote = owner?.origin
        ? OWNER_ORIGIN_NOTE[owner.origin]
        : undefined;

    return (
        <>
            {(cwe || vulnerabilityClass) && (
                <div className="flex gap-3">
                    <ShieldIcon className="text-secondary-light size-4.5 shrink-0" />
                    <span className="text-text-secondary">
                        {cwe &&
                            (cweLink ? (
                                <Link
                                    target="_blank"
                                    href={cweLink}
                                    className={linkClassName}>
                                    {cwe}
                                </Link>
                            ) : (
                                cwe
                            ))}
                        {cwe && vulnerabilityClass && " · "}
                        {vulnerabilityClass}
                    </span>
                </div>
            )}

            {symbol && (
                <div className="flex gap-3">
                    <BracesIcon className="text-secondary-light size-4.5 shrink-0" />
                    <code className="text-text-secondary">{symbol}</code>
                </div>
            )}

            {owner && (
                <div className="flex gap-3">
                    <UserIcon className="text-secondary-light size-4.5 shrink-0" />
                    <span className="text-text-secondary">
                        @{owner.username}
                        {ownerNote && (
                            <span className="text-text-tertiary">
                                {" "}
                                ({ownerNote})
                            </span>
                        )}
                    </span>
                </div>
            )}
        </>
    );
};

/** Attack path and reproduction, above the description. */
export const IssueSecurityEvidence = ({
    issue,
}: {
    issue: Pick<IssueItem, "security" | "language">;
}) => {
    const evidence = issue.security?.evidence;
    const attackPath = evidence?.attackPath ?? [];
    const reproduction = evidence?.reproduction;

    if (attackPath.length === 0 && !reproduction) return null;

    const status = reproduction ? reproductionStatus(reproduction) : undefined;

    return (
        <div className="mt-10 flex flex-col gap-10 px-6">
            {attackPath.length > 0 && (
                <div>
                    <Heading variant="h3" className="mb-2">
                        Attack path
                    </Heading>

                    <ol className="text-text-secondary list-outside list-decimal space-y-2 pl-5 text-sm">
                        {attackPath.map((step, i) => (
                            <li key={`${step.file}:${step.line}:${i}`}>
                                <code className="text-text-primary break-all">
                                    {step.file}:{step.line}
                                </code>
                                {step.note && <> — {step.note}</>}
                            </li>
                        ))}
                    </ol>
                </div>
            )}

            {reproduction && status && (
                <div className="flex flex-col gap-3 text-sm">
                    <Heading variant="h3">Reproduction</Heading>

                    <p
                        className={cn(
                            "flex items-center gap-2",
                            toneClassName[status.tone],
                        )}>
                        <FlaskConicalIcon className="size-4 shrink-0" />
                        {status.label}
                    </p>

                    {reproduction.command && (
                        <SyntaxHighlight language="bash" wrap={false}>
                            {reproduction.command}
                        </SyntaxHighlight>
                    )}

                    {reproduction.content && (
                        <CodeCollapsible
                            title="Test file"
                            subtitle={reproduction.path}
                            language={issue.language}>
                            {reproduction.content}
                        </CodeCollapsible>
                    )}

                    {reproduction.output && (
                        <CodeCollapsible title="Output" language="text">
                            {reproduction.output}
                        </CodeCollapsible>
                    )}
                </div>
            )}
        </div>
    );
};

const CodeCollapsible = ({
    title,
    subtitle,
    language,
    children,
}: {
    title: string;
    subtitle?: string;
    language: string;
    children: string;
}) => (
    <Collapsible>
        <CollapsibleTrigger asChild>
            <button
                type="button"
                className="text-text-secondary hover:text-text-primary flex w-full items-center gap-2 text-left text-sm">
                <span className="text-text-primary font-medium">{title}</span>
                {subtitle && (
                    <code className="truncate text-xs">{subtitle}</code>
                )}
                <CollapsibleIndicator className="ml-auto" />
            </button>
        </CollapsibleTrigger>

        <CollapsibleContent className="pt-3 pb-0">
            <SyntaxHighlight language={language} wrap={false}>
                {children}
            </SyntaxHighlight>
        </CollapsibleContent>
    </Collapsible>
);
