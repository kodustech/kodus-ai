/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import { toast } from "@components/ui/toaster/use-toast";
import type { EnvironmentSetup } from "@services/runtime/contracts";
import { useProposeInferredRecipe } from "@services/runtime/queries";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { InferredRecipe, RepositoryRecipe } from "./inferred-recipe";

jest.mock("@services/runtime/queries", () => ({
    useProposeInferredRecipe: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));
jest.mock("next/link", () => ({
    __esModule: true,
    default: ({ children, href }: { children: ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

const mutate = jest.fn();
beforeEach(() => {
    mutate.mockReset();
    (toast as jest.Mock).mockReset();
    (useProposeInferredRecipe as jest.Mock).mockReturnValue({
        mutate,
        isPending: false,
    });
});

const CONTENT =
    "version: 1\nservices:\n  compose:\n    files: [compose.yaml]\n    public: web\n  expose:\n    - { service: web, port: 3000, kind: http }\n";

const setup = (
    over: Partial<EnvironmentSetup> = {},
    recipe: Partial<NonNullable<EnvironmentSetup["recipe"]>> = {},
): EnvironmentSetup => ({
    state: "active",
    steps: [],
    blockers: [],
    requestedAt: "2026-11-03T12:00:00.000Z",
    updatedAt: "2026-11-03T12:02:00.000Z",
    recipe: {
        path: ".kodus/workspace.yaml",
        sha: "a".repeat(40),
        state: "found",
        digest: "sha256:abc",
        origin: "inferred",
        cleanBoots: 2,
        content: CONTENT,
        ...recipe,
    },
    ...over,
});

const env = (s?: EnvironmentSetup) => ({ environmentId: "env-1", setup: s });

describe("InferredRecipe", () => {
    it("shows the recipe and opens the PR once it booted on two clean machines, then links it", () => {
        render(<InferredRecipe env={env(setup())} canPropose />);
        expect(screen.getByLabelText("Inferred setup file").textContent).toBe(
            CONTENT,
        );
        expect(
            screen.getByText("Booted from zero on 2 clean machines"),
        ).toBeInTheDocument();
        fireEvent.click(
            screen.getByRole("button", { name: /Open the setup file PR/ }),
        );
        expect(mutate).toHaveBeenCalledWith("env-1", expect.any(Object));
        act(() =>
            mutate.mock.calls[0][1].onSuccess({
                pullRequest: {
                    number: 52,
                    url: "https://github.com/acme/shop/pull/52",
                },
            }),
        );
        expect(
            screen.getByRole("link", { name: /Setup file PR #52/ }),
        ).toHaveAttribute("href", "https://github.com/acme/shop/pull/52");
        expect(
            screen.queryByRole("button", { name: /Open the setup file PR/ }),
        ).not.toBeInTheDocument();
        expect(toast).toHaveBeenCalledWith(
            expect.objectContaining({ title: "Setup file PR #52 opened" }),
        );
    });

    it("after one clean boot, asks for a second setup instead of the PR (ENV-06)", () => {
        render(
            <InferredRecipe
                env={env(setup({}, { cleanBoots: 1 }))}
                canPropose
                setupAction={<button type="button">Set up again</button>}
            />,
        );
        expect(
            screen.getByText("Booted from zero on 1 clean machine"),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /Open the setup file PR/ }),
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Set up again" }),
        ).toBeInTheDocument();
    });

    it("shows the PR button disabled to who cannot update the environment", () => {
        render(<InferredRecipe env={env(setup())} canPropose={false} />);
        expect(
            screen.getByRole("button", { name: /Open the setup file PR/ }),
        ).toBeDisabled();
    });

    it("says it did not boot when the setup with it was blocked, with no PR", () => {
        render(
            <InferredRecipe
                env={env(
                    setup({ state: "blocked" }, { cleanBoots: undefined }),
                )}
                canPropose
            />,
        );
        expect(screen.getByText("Did not boot")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /Open the setup file PR/ }),
        ).not.toBeInTheDocument();
    });

    it("a 409 says the recipe or the files changed", () => {
        render(<InferredRecipe env={env(setup())} canPropose />);
        fireEvent.click(
            screen.getByRole("button", { name: /Open the setup file PR/ }),
        );
        act(() =>
            mutate.mock.calls[0][1].onError(
                Object.assign(new Error("conflict"), {
                    statusCode: 409,
                    status: 409,
                }),
            ),
        );
        expect(toast).toHaveBeenCalledWith(
            expect.objectContaining({
                variant: "danger",
                title: "Couldn't open the setup file PR",
            }),
        );
    });

    it("explains in plain words when nothing could be inferred", () => {
        const message =
            "There is no compose file and no Dockerfile at the repository root, so Kodus has nothing to infer a recipe from.";
        render(
            <InferredRecipe
                env={env(
                    setup(
                        { state: "blocked" },
                        {
                            state: "absent",
                            origin: undefined,
                            content: undefined,
                            cleanBoots: undefined,
                            inference: { reason: "no_build_files", message },
                        },
                    ),
                )}
                canPropose
                setupAction={<button type="button">Set up again</button>}
            />,
        );
        expect(screen.getByText(message)).toBeInTheDocument();
        expect(
            screen.queryByLabelText("Inferred setup file"),
        ).not.toBeInTheDocument();
        // The three ways out, each with its action where there is one.
        const ways = screen.getByRole("list", {
            name: "Ways to get a setup file",
        });
        expect(ways).toHaveTextContent("Let Kody try again");
        expect(
            screen.getByRole("button", { name: "Set up again" }),
        ).toBeInTheDocument();
        expect(ways).toHaveTextContent("Hand it to your coding agent");
        // The prompt is shown before it is copied.
        fireEvent.click(
            screen.getByRole("button", { name: "Show the prompt" }),
        );
        expect(screen.getByLabelText("Prompt")).toHaveTextContent(
            "Write .kodus/workspace.yaml for this repository",
        );
        expect(
            screen.getByRole("button", { name: "Copy prompt" }),
        ).toBeInTheDocument();
        expect(ways).toHaveTextContent("Write it yourself");
    });

    it("says Kody wrote the recipe, with Kody's notes, and offers the PR after two clean boots like the inferred one", () => {
        const notes = "The root compose file; the API answers on 3000.";
        render(
            <InferredRecipe
                env={env(setup({}, { origin: "authored", notes }))}
                canPropose
            />,
        );
        expect(
            screen.getByText("Kody wrote the setup file"),
        ).toBeInTheDocument();
        expect(
            screen.queryByText("Setup file inferred by Kodus"),
        ).not.toBeInTheDocument();
        expect(screen.getByLabelText("Kody's notes")).toHaveTextContent(notes);
        expect(screen.getByLabelText("Setup file Kody wrote").textContent).toBe(
            CONTENT,
        );
        fireEvent.click(
            screen.getByRole("button", { name: /Open the setup file PR/ }),
        );
        expect(mutate).toHaveBeenCalledWith("env-1", expect.any(Object));
    });

    it("says which CI workflow and job Kody copied the e2e suite block from, so it is checked before merging", () => {
        const content = `${CONTENT}\n# suite: origin inferred from .github/workflows/e2e.yml job cypress; keys: runner, command, specs, shards, results. Edit it freely; results.junit is the engine's default glob.\nsuite:\n  runner: cypress\n`;
        render(
            <InferredRecipe
                env={env(setup({}, { origin: "authored", content }))}
                canPropose
            />,
        );
        const note = screen.getByLabelText("E2e suite origin");
        expect(note).toHaveTextContent(".github/workflows/e2e.yml");
        expect(note).toHaveTextContent("job cypress");
    });

    it("says nothing of the suite's origin when the setup file has no inferred suite block", () => {
        render(
            <InferredRecipe
                env={env(setup({}, { origin: "authored" }))}
                canPropose
            />,
        );
        expect(
            screen.queryByLabelText("E2e suite origin"),
        ).not.toBeInTheDocument();
    });

    it("a recipe Kody wrote that booted once asks for a second setup", () => {
        render(
            <InferredRecipe
                env={env(setup({}, { origin: "authored", cleanBoots: 1 }))}
                canPropose
                setupAction={<button type="button">Set up again</button>}
            />,
        );
        expect(
            screen.getByText("Kody wrote the setup file"),
        ).toBeInTheDocument();
        expect(screen.queryByLabelText("Kody's notes")).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /Open the setup file PR/ }),
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Set up again" }),
        ).toBeInTheDocument();
    });

    it("shows the build files sent with the setup file, one tab each, so the whole set the machine boots can be read", () => {
        render(
            <InferredRecipe
                env={env(
                    setup(
                        { state: "setting_up" },
                        {
                            origin: "submitted",
                            cleanBoots: 0,
                            files: [
                                {
                                    path: ".kodus/compose.yaml",
                                    content: "services:\n  app: {}\n",
                                },
                                {
                                    path: ".kodus/Dockerfile.backend",
                                    content: "FROM node:22-trixie\n",
                                },
                            ],
                        },
                    ),
                )}
                canPropose
            />,
        );
        expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
            "workspace.yaml",
            "compose.yaml",
            "Dockerfile.backend",
        ]);
        expect(
            screen.getByLabelText("Setup file sent from a coding agent"),
        ).toHaveTextContent("version: 1");
        fireEvent.mouseDown(
            screen.getByRole("tab", { name: "Dockerfile.backend" }),
        );
        expect(
            screen.getByLabelText(".kodus/Dockerfile.backend"),
        ).toHaveTextContent("FROM node:22-trixie");
    });

    it("a setup file with no build files shows it alone, with no tabs", () => {
        render(<InferredRecipe env={env(setup())} canPropose />);
        expect(screen.queryByRole("tab")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Inferred setup file")).toHaveTextContent(
            "version: 1",
        );
    });

    it("shows nothing for a recipe read from the repository", () => {
        const { container } = render(
            <InferredRecipe
                env={env(setup({}, { origin: undefined, content: undefined }))}
                canPropose
            />,
        );
        expect(container).toBeEmptyDOMElement();
    });
});

describe("RepositoryRecipe", () => {
    it("says where the repository's recipe is and the commit it was read at", () => {
        render(
            <RepositoryRecipe
                env={env(
                    setup(
                        { branch: "main" },
                        { origin: undefined, content: undefined },
                    ),
                )}
            />,
        );
        const section = screen.getByRole("region", { name: "Setup file" });
        expect(section).toHaveAttribute("id", "recipe");
        expect(section).toHaveTextContent(
            ".kodus/workspace.yaml on main, read at aaaaaaa",
        );
    });

    it("shows nothing for a recipe Kodus generated or when there is none", () => {
        const { container, rerender } = render(
            <RepositoryRecipe env={env(setup())} />,
        );
        expect(container).toBeEmptyDOMElement();
        rerender(<RepositoryRecipe env={env(undefined)} />);
        expect(container).toBeEmptyDOMElement();
    });
});
