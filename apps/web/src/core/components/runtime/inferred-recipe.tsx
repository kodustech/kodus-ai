"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@components/ui/tabs";
import { toast } from "@components/ui/toaster/use-toast";
import type { RuntimeEnvironment } from "@services/runtime/contracts";
import { shortSha } from "@services/runtime/format";
import { agentPrompt } from "@services/runtime/model/agent-prompt";
import {
    ENVIRONMENT_SECTION,
    INFERRED_RECIPE_CLEAN_BOOTS,
    inferredSuiteOrigin,
    isRecipeFailureBlocker,
    recipeReauthorWords,
} from "@services/runtime/model/environment";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import { useProposeInferredRecipe } from "@services/runtime/queries";
import {
    BotIcon,
    CopyIcon,
    ExternalLinkIcon,
    GitPullRequestIcon,
} from "lucide-react";

import { RuntimeSection } from "./section";
import { StatusChip } from "./status-chip";

export { INFERRED_RECIPE_CLEAN_BOOTS };

const bootsLabel = (n: number) =>
    `Booted from zero on ${n} clean machine${n === 1 ? "" : "s"}`;

/** The prompt, shown before it is copied, with where to paste it and what comes back. */
const AgentPromptPopover = ({
    name,
    onCopy,
}: {
    name: string;
    onCopy: () => void;
}) => (
    <Popover>
        <PopoverTrigger asChild>
            <Button size="sm" variant="helper" leftIcon={<BotIcon />}>
                Show the prompt
            </Button>
        </PopoverTrigger>
        <PopoverContent
            align="end"
            className="flex w-[28rem] flex-col gap-3 p-4">
            <span className="text-text-secondary text-xs">
                Paste it in a checkout of {name}. The agent writes{" "}
                <code className="font-mono">.kodus/workspace.yaml</code>, boots
                the app with it and opens a pull request. Once merged, set up
                again.
            </span>
            <pre
                aria-label="Prompt"
                className="bg-card-lv2 text-text-secondary text-2xs max-h-48 overflow-auto rounded-lg p-3 font-mono leading-relaxed whitespace-pre-wrap">
                {agentPrompt(name)}
            </pre>
            <Button
                size="sm"
                variant="primary"
                leftIcon={<CopyIcon />}
                className="self-end"
                onClick={onCopy}>
                Copy prompt
            </Button>
        </PopoverContent>
    </Popover>
);

/**
 * The recipe read from the repository: where it is and the commit it was read
 * at, so a Run or a failed setup leads to the file to change. Its text stays
 * in the repository (Kodus shows only recipes it generated).
 */
export const RepositoryRecipe = ({
    env,
}: {
    env: Pick<RuntimeEnvironment, "setup">;
}) => {
    const recipe = env.setup?.recipe;
    if (!recipe || recipe.state !== "found" || recipe.origin) return null;
    return (
        <RuntimeSection
            id={ENVIRONMENT_SECTION.recipe}
            title="Setup file"
            description="How Kody builds and starts the app. Every setup and Run reads it from the default branch.">
            <p className="text-text-secondary text-sm">
                <code className="text-text-primary font-mono">
                    {recipe.path}
                </code>
                {env.setup?.branch ? ` on ${env.setup.branch}` : ""}, read at{" "}
                <code className="font-mono">{shortSha(recipe.sha)}</code>.
                Change it by pull request; the next setup uses it.
            </p>
        </RuntimeSection>
    );
};

/**
 * The recipe Kodus inferred when the default branch has none (docs §4, the
 * deterministic first step of the learning loop), or the one Kody wrote when
 * nothing could be inferred (origin `authored`, with Kody's notes). Its text
 * passed the recipe checks, so it is shown as is. Once it booted twice in a
 * row, the dev opens the PR that adds it; until then, a second setup proves
 * it. When nothing could be inferred, the reason in plain words.
 */
export const InferredRecipe = ({
    env,
    canPropose,
    setupAction,
}: {
    env: Pick<RuntimeEnvironment, "environmentId" | "setup"> &
        Partial<Pick<RuntimeEnvironment, "repositoryName">>;
    /** The viewer can update the environment (the API checks it again). */
    canPropose: boolean;
    /** The "Set up again" button, for the second clean boot. */
    setupAction?: ReactNode;
}) => {
    const propose = useProposeInferredRecipe();
    const [pr, setPr] = useState<{ number: number; url: string }>();
    const setup = env.setup;
    const recipe = setup?.recipe;

    if (recipe?.inference) {
        const name = env.repositoryName ?? "this repository";
        const copyPrompt = async () => {
            try {
                await navigator.clipboard.writeText(agentPrompt(name));
                toast({ variant: "success", description: "Prompt copied" });
            } catch {
                toast({ variant: "danger", title: "Couldn't copy the prompt" });
            }
        };
        return (
            <RuntimeSection
                id={ENVIRONMENT_SECTION.recipe}
                title="No setup file yet"
                description="Nothing boots until this repository has a setup file: .kodus/workspace.yaml, which says how to build and start the app.">
                <div className="flex flex-col gap-0.5 text-sm">
                    <span className="text-text-tertiary text-xs">
                        What Kodus found
                    </span>
                    <span className="text-text-secondary">
                        {recipe.inference.message}
                    </span>
                </div>
                <ul
                    aria-label="Ways to get a setup file"
                    className="flex flex-col gap-2">
                    {setupAction && (
                        <li className="bg-card-lv2 flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-3">
                            <span className="flex flex-col gap-0.5">
                                <span className="text-text-primary text-sm font-medium">
                                    Let Kody try again
                                </span>
                                <span className="text-text-secondary text-xs">
                                    Kody reads the repository and writes the
                                    setup file; what stopped the last try goes
                                    back to it.
                                </span>
                            </span>
                            {setupAction}
                        </li>
                    )}
                    <li className="bg-card-lv2 flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-3">
                        <span className="flex flex-col gap-0.5">
                            <span className="text-text-primary text-sm font-medium">
                                Hand it to your coding agent
                            </span>
                            <span className="text-text-secondary text-xs">
                                Claude Code, Cursor or Codex already know how to
                                run the project. The prompt asks for the setup
                                file and a pull request.
                            </span>
                        </span>
                        <AgentPromptPopover name={name} onCopy={copyPrompt} />
                    </li>
                    <li className="bg-card-lv2 flex flex-col gap-0.5 rounded-lg px-4 py-3">
                        <span className="text-text-primary text-sm font-medium">
                            Write it yourself
                        </span>
                        <span className="text-text-secondary text-xs">
                            Add{" "}
                            <code className="font-mono">
                                .kodus/workspace.yaml
                            </code>{" "}
                            to the default branch; the next setup reads it.
                        </span>
                    </li>
                </ul>
            </RuntimeSection>
        );
    }
    const submitted = recipe?.origin === "submitted";
    // Written whole (by Kody or the developer's agent), never inferred: no learn-loop fix applies to it.
    const authored = recipe?.origin === "authored" || submitted;
    if (
        !setup ||
        (recipe?.origin !== "inferred" && !authored) ||
        !recipe.content
    )
        return null;

    const boots = recipe.cleanBoots ?? 0;
    // It did not boot as written, but Kody's learn loop found the one change
    // that boots it from zero twice (ENV-06). Only for an inferred recipe.
    const learned =
        !authored &&
        setup.state === "blocked" &&
        setup.learn?.proven?.origin === "inferred" &&
        setup.learn.proven.content &&
        setup.learn.proven.cleanBoots >= INFERRED_RECIPE_CLEAN_BOOTS
            ? setup.learn.proven
            : undefined;
    const proven =
        (setup.state === "active" && boots >= INFERRED_RECIPE_CLEAN_BOOTS) ||
        !!learned;

    // The e2e suite block the recipe author copied from the repository's CI, said so the team checks it before merging.
    const suiteOrigin = authored
        ? inferredSuiteOrigin(learned?.content ?? recipe.content)
        : null;

    const open = () =>
        propose.mutate(env.environmentId, {
            onSuccess: (out) => {
                setPr(out.pullRequest);
                toast({
                    variant: "success",
                    title: `Setup file PR #${out.pullRequest.number} opened`,
                    description:
                        "Merge it and every setup and Run boots from it.",
                });
            },
            onError: (error) =>
                toast({
                    variant: "danger",
                    title: "Couldn't open the setup file PR",
                    description: runtimeErrorMessage(error, {
                        fallback: "Try again in a moment.",
                        403: "You need permission to update this environment.",
                        409: "The setup file or the repository files changed since this setup. Set up again.",
                        503: "Kodus could not reach the Git platform. Check the Git integration and try again.",
                    }),
                }),
        });

    return (
        <RuntimeSection
            id={ENVIRONMENT_SECTION.recipe}
            title={
                submitted
                    ? "Setup file sent from your coding agent"
                    : authored
                      ? "Kody wrote the setup file"
                      : "Setup file inferred by Kodus"
            }
            description={
                submitted
                    ? "The default branch has no setup file, so this one, which a coding agent wrote and sent with kodus env recipe submit, is what every setup and Run boots. Commit it in a pull request: a committed setup file always wins."
                    : authored
                      ? "The default branch has no setup file and Kodus could not infer one from the compose file, Dockerfile or package.json, so Kody read the repository and wrote this one. It passed the same checks as a setup file you write."
                      : "The default branch has no setup file, so Kodus wrote this one from the repository files (compose, Dockerfile, package.json), without an LLM."
            }>
            <div className="flex flex-wrap items-center gap-2">
                {learned ? (
                    <StatusChip tone="success">
                        {`With Kody's fix: ${bootsLabel(learned.cleanBoots).toLowerCase()}`}
                    </StatusChip>
                ) : setup.state === "active" ? (
                    <StatusChip tone={proven ? "success" : "info"}>
                        {bootsLabel(boots)}
                    </StatusChip>
                ) : setup.state === "blocked" ? (
                    <StatusChip tone="danger">Did not boot</StatusChip>
                ) : (
                    <StatusChip tone="info">Booting</StatusChip>
                )}
            </div>
            {authored && recipeReauthorWords(setup, recipe.notes) && (
                <p role="status" className="text-text-secondary text-sm">
                    {recipeReauthorWords(setup, recipe.notes)}
                </p>
            )}
            {authored && recipe.notes && (
                <p
                    role="note"
                    aria-label="Kody's notes"
                    className="text-text-secondary text-sm break-words whitespace-pre-line">
                    <span className="text-text-primary font-medium">
                        Kody&apos;s notes:
                    </span>{" "}
                    {recipe.notes}
                </p>
            )}
            {suiteOrigin && (
                <p
                    role="note"
                    aria-label="E2e suite origin"
                    className="text-text-secondary text-sm break-words">
                    <span className="text-text-primary font-medium">
                        E2e suite:
                    </span>{" "}
                    Kody copied the suite block from the CI workflow{" "}
                    <code className="font-mono">{suiteOrigin.file}</code>, job{" "}
                    <code className="font-mono">{suiteOrigin.job}</code>: the
                    runner, command, specs and shards it runs there. Check them
                    before you merge the setup file.
                </p>
            )}
            <RecipeFiles
                label={
                    submitted
                        ? "Setup file sent from a coding agent"
                        : authored
                          ? "Setup file Kody wrote"
                          : "Inferred setup file"
                }
                path={recipe.path}
                content={learned?.content ?? recipe.content}
                files={learned ? [] : (recipe.files ?? [])}
            />
            {learned && (
                <p className="text-text-secondary text-sm">
                    It did not boot as Kodus wrote it. With one change (
                    {learned.fix.label}), it booted from zero on two clean
                    machines: this is the setup file the PR adds.
                </p>
            )}
            {setup.state === "blocked" && !learned && (
                <p className="text-text-secondary text-sm">
                    {submitted
                        ? "It did not boot: the blockers say why. Your coding agent reads them with kodus env status, fixes the setup file and sends it again."
                        : !authored
                          ? "It did not boot: the blockers say why. Fix the repository or write .kodus/workspace.yaml yourself, then set up again."
                          : isRecipeFailureBlocker(setup.blockers[0])
                            ? "It did not boot: the last setup says where. Set up again and Kody rewrites it from that failure, or write .kodus/workspace.yaml yourself."
                            : "The setup stopped before this setup file could boot: the last setup says why. Nothing in the setup file failed; set up again and it boots the same setup file."}
                </p>
            )}
            {setup.state === "active" && !proven && (
                <div className="flex flex-col gap-2">
                    <p className="text-text-secondary text-sm">
                        Kodus proposes it after it boots from zero on a second
                        clean machine. Set up again to prove it.
                    </p>
                    {setupAction && <div>{setupAction}</div>}
                </div>
            )}
            {proven &&
                (pr ? (
                    <Link
                        href={pr.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-sm">
                        Setup file PR #{pr.number}
                        <ExternalLinkIcon className="size-3.5" />
                    </Link>
                ) : (
                    <div className="flex flex-col gap-2">
                        <p className="text-text-secondary text-sm">
                            Open the PR that adds it as .kodus/workspace.yaml.
                            Once merged, you change it like any setup file.
                        </p>
                        <div>
                            {/* The page's next step already points here in amber: one lamp, not two. */}
                            <Button
                                size="sm"
                                variant="secondary"
                                leftIcon={<GitPullRequestIcon />}
                                loading={propose.isPending}
                                disabled={!canPropose}
                                onClick={open}>
                                Open the setup file PR
                            </Button>
                        </div>
                    </div>
                ))}
        </RuntimeSection>
    );
};

/**
 * The recipe and the build files under .kodus/ that boot with it (the compose files and Dockerfiles Kody or the
 * developer's agent wrote), one tab each: what the machine boots is the whole set, never the recipe alone.
 */
const RecipeFiles = ({
    label,
    path,
    content,
    files,
}: {
    label: string;
    path?: string;
    content: string;
    files: ReadonlyArray<{ path: string; content: string }>;
}) => {
    const pre = (text: string, aria: string) => (
        <pre
            aria-label={aria}
            className="bg-card-lv2 overflow-x-auto rounded-md p-3 font-mono text-xs leading-5">
            {text}
        </pre>
    );
    if (!files.length) return pre(content, label);
    const recipePath = path ?? ".kodus/workspace.yaml";
    const name = (p: string) => p.replace(/^\.kodus\//, "");
    return (
        <Tabs defaultValue={recipePath} aria-label={`${label} and its files`}>
            <TabsList>
                <TabsTrigger value={recipePath} type="button">
                    {name(recipePath)}
                </TabsTrigger>
                {files.map((f) => (
                    <TabsTrigger key={f.path} value={f.path} type="button">
                        {name(f.path)}
                    </TabsTrigger>
                ))}
            </TabsList>
            <TabsContent value={recipePath}>{pre(content, label)}</TabsContent>
            {files.map((f) => (
                <TabsContent key={f.path} value={f.path}>
                    {pre(f.content, f.path)}
                </TabsContent>
            ))}
        </Tabs>
    );
};
