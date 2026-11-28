/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type {
    EnvironmentLearn,
    EnvironmentSetup,
} from "@services/runtime/contracts";
import { useProposeInferredRecipe } from "@services/runtime/queries";
import { render, screen } from "@testing-library/react";

import { InferredRecipe } from "./inferred-recipe";
import { KodyAttempts } from "./kody-attempts";

jest.mock("@services/runtime/queries", () => ({
    useProposeInferredRecipe: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));
jest.mock("next/link", () => ({
    __esModule: true,
    default: ({
        children,
        href,
    }: {
        children: React.ReactNode;
        href: string;
    }) => <a href={href}>{children}</a>,
}));

beforeEach(() => {
    (useProposeInferredRecipe as jest.Mock).mockReturnValue({
        mutate: jest.fn(),
        isPending: false,
    });
});

const attempt = (
    over: Partial<EnvironmentLearn["attempts"][number]> = {},
): EnvironmentLearn["attempts"][number] => ({
    n: 1,
    signature: "compose_up",
    fix: {
        id: "set_env:SESSION_STORE_URL",
        action: "set_env",
        label: "Give SESSION_STORE_URL a test value",
    },
    result: "blocked",
    blocker: {
        kind: "unknown",
        signature: "compose_up",
        title: "The project failed to build or start",
    },
    setupKey: "k1",
    at: "2026-11-04T12:00:00.000Z",
    ...over,
});

describe("KodyAttempts", () => {
    it("lists each typed change Kody tried and how it ended, in template words", () => {
        render(
            <KodyAttempts
                learn={{
                    tried: [{ signature: "compose_up", count: 3 }],
                    attempts: [
                        attempt(),
                        attempt({
                            n: 2,
                            fix: undefined,
                            result: "refused",
                            refusal: "not_in_evidence",
                            blocker: undefined,
                        }),
                        attempt({
                            n: 3,
                            fix: {
                                id: "raise_health_timeout:300s",
                                action: "raise_health_timeout",
                                label: "Wait up to 5 minutes for the ready check",
                            },
                            result: "booted_once",
                            cleanBoots: 1,
                        }),
                    ],
                    stopped: "cap",
                }}
            />,
        );
        expect(screen.getByText("Kody tried")).toBeInTheDocument();
        expect(
            screen.getByText("Give SESSION_STORE_URL a test value"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                "Did not boot: The project failed to build or start",
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                "Not tried: it named something the failure log does not show",
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByText("Booted once, not on the second clean machine"),
        ).toBeInTheDocument();
        expect(screen.getByText(/Kody tried 3 changes/)).toBeInTheDocument();
    });

    it("renders nothing without attempts (no LLM, or nothing to change): the card stays as it is", () => {
        const { container } = render(
            <KodyAttempts
                learn={{ tried: [], attempts: [], stopped: "llm_unavailable" }}
            />,
        );
        expect(container).toBeEmptyDOMElement();
        expect(render(<KodyAttempts />).container).toBeEmptyDOMElement();
    });
});

describe("InferredRecipe with Kody's fix", () => {
    const INFERRED =
        "version: 1\nservices:\n  compose:\n    files: [compose.yaml]\n    public: web\n  expose:\n    - { service: web, port: 3000, kind: http }\n";
    const FIXED = INFERRED.replace(
        "    public: web\n",
        '    public: web\n    env:\n      SESSION_STORE_URL: "http://kodus-fake.invalid"\n',
    );
    const setup: EnvironmentSetup = {
        state: "blocked",
        steps: [],
        blockers: [],
        requestedAt: "2026-11-04T12:00:00.000Z",
        updatedAt: "2026-11-04T12:05:00.000Z",
        recipe: {
            path: ".kodus/workspace.yaml",
            sha: "a".repeat(40),
            state: "found",
            origin: "inferred",
            cleanBoots: 0,
            content: INFERRED,
        },
        learn: {
            tried: [],
            attempts: [attempt({ result: "booted", cleanBoots: 2 })],
            stopped: "proven",
            proven: {
                signature: "compose_up",
                fix: {
                    id: "set_env:SESSION_STORE_URL",
                    action: "set_env",
                    label: "Give SESSION_STORE_URL a test value",
                },
                digest: "sha256:abc",
                cleanBoots: 2,
                origin: "inferred",
                content: FIXED,
            },
        },
    };

    it("shows the fixed recipe and offers its PR even though the setup is blocked", () => {
        render(
            <InferredRecipe
                env={{ environmentId: "env-1", setup }}
                canPropose
            />,
        );
        expect(screen.getByLabelText("Inferred setup file").textContent).toBe(
            FIXED,
        );
        expect(
            screen.getByText(
                "With Kody's fix: booted from zero on 2 clean machines",
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /Open the setup file PR/ }),
        ).toBeEnabled();
    });
});
