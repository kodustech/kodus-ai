/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import type { RuntimeEnvironmentSuite } from "@services/runtime/contracts";
import {
    useEnvironmentSuite,
    useResumeSuiteSelection,
    useUpdateEnvironmentSettings,
} from "@services/runtime/queries";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { EnvironmentSuiteSection } from "./e2e-suite";

jest.mock("next/link", () => ({
    __esModule: true,
    default: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: ReactNode;
    }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));
jest.mock("@services/runtime/queries", () => ({
    useEnvironmentSuite: jest.fn(),
    useResumeSuiteSelection: jest.fn(),
    useUpdateEnvironmentSettings: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

beforeAll(() => {
    global.ResizeObserver = class {
        observe = jest.fn();
        unobserve = jest.fn();
        disconnect = jest.fn();
    };
});

const MAIN = "a41c0d3".padEnd(40, "0");
const suite = (
    over: Partial<RuntimeEnvironmentSuite> = {},
): RuntimeEnvironmentSuite => ({
    environmentId: "env-1",
    recipe: {
        runner: "playwright",
        specs: "e2e/**/*.spec.ts",
        command: "npx playwright test {specs} --reporter=junit",
        results: "results/*.xml",
        shards: 3,
        gate: "default",
        baseline: true,
    },
    lastBaseline: {
        sha: MAIN,
        specs: 24,
        passed: 22,
        failed: 2,
        finishedAt: "2026-11-24T14:02:00.000Z",
    },
    selection: { enabled: true },
    ci: { enabled: false, source: "deployment" },
    ...over,
});

const update = jest.fn();
const resume = jest.fn();
const show = (data: RuntimeEnvironmentSuite | undefined, canManage = true) => {
    (useEnvironmentSuite as jest.Mock).mockReturnValue({
        data,
        isLoading: false,
        isError: false,
    });
    return render(
        <EnvironmentSuiteSection environmentId="env-1" canManage={canManage} />,
    );
};
beforeEach(() => {
    update.mockReset();
    resume.mockReset();
    (useUpdateEnvironmentSettings as jest.Mock).mockReturnValue({
        mutate: update,
        isPending: false,
    });
    (useResumeSuiteSelection as jest.Mock).mockReturnValue({
        mutate: resume,
        isPending: false,
    });
});

describe("Settings, e2e suite", () => {
    it("is not there for an environment whose recipe declares no suite", () => {
        const { container } = show(suite({ recipe: undefined }));
        expect(container).toBeEmptyDOMElement();
    });

    it("shows what the recipe says as facts, with the way to edit it, and no control for what the recipe owns", () => {
        show(suite());
        const recipe = screen.getByRole("region", { name: "From the recipe" });
        for (const text of [
            "Runner",
            "Playwright",
            "e2e/**/*.spec.ts · 24 files",
            "npx playwright test {specs} --reporter=junit",
            "results/*.xml",
            "a41c0d3 · 22 passed, 2 failed",
            "Maximum hosts per run",
            "3",
            "Neutral: only a confirmed regression fails the check",
        ])
            expect(within(recipe).getByText(text)).toBeInTheDocument();
        expect(
            within(recipe).getByRole("link", {
                name: "Edit .kodus/workspace.yaml",
            }),
        ).toHaveAttribute("href", "/runtime/environments/env-1#recipe");
        // The shard ceiling and the gate are the recipe's: no select, no radio.
        expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
        expect(screen.queryByRole("radio")).not.toBeInTheDocument();
        expect(
            screen.getByText(/suite\.shards and suite\.gate/),
        ).toBeInTheDocument();
    });

    it("says nothing about a pause unless the shadow check braked selection", () => {
        show(suite());
        expect(
            screen.queryByRole("region", { name: "Selection paused" }),
        ).not.toBeInTheDocument();
    });

    it("shows the pause with its reason, and Resume selection asks the Runtime once", () => {
        show(
            suite({
                selection: {
                    enabled: true,
                    brake: {
                        off: false,
                        fullPrsLeft: 8,
                        miss: { prNumber: 38, specs: ["e2e/search.spec.ts"] },
                    },
                },
            }),
        );
        const banner = screen.getByRole("region", { name: "Selection paused" });
        expect(
            within(banner).getByText(
                "Spec selection is paused for the next 8 pull requests",
            ),
        ).toBeInTheDocument();
        expect(banner).toHaveTextContent("PR #38");
        expect(banner).toHaveTextContent("e2e/search.spec.ts");
        fireEvent.click(
            within(banner).getByRole("button", { name: "Resume selection" }),
        );
        expect(resume).toHaveBeenCalledWith("env-1", expect.anything());
    });

    it("hides Resume selection from who may not manage the environment", () => {
        show(
            suite({
                selection: {
                    enabled: true,
                    brake: { off: true, fullPrsLeft: 10 },
                },
            }),
            false,
        );
        expect(
            screen.getByRole("region", { name: "Selection paused" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Resume selection" }),
        ).not.toBeInTheDocument();
    });

    it("has the two switches the environment owns, as they are saved, and Save sends only what changed", () => {
        show(suite({ ci: { enabled: false, source: "deployment" } }));
        const selection = screen.getByRole("switch", {
            name: "Run only the specs the change reaches",
        });
        const ci = screen.getByRole("switch", {
            name: "Run on every push, as a CI check",
        });
        expect(selection).toBeChecked();
        expect(ci).not.toBeChecked();
        const save = screen.getByRole("button", { name: "Save" });
        expect(save).toBeDisabled();
        fireEvent.click(selection);
        fireEvent.click(save);
        expect(update).toHaveBeenCalledWith(
            { environmentId: "env-1", suiteSelection: false },
            expect.anything(),
        );
        update.mockReset();
        fireEvent.click(ci);
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(update).toHaveBeenCalledWith(
            { environmentId: "env-1", suiteSelection: false, suiteCi: true },
            expect.anything(),
        );
    });

    it("says where the CI default comes from, and Cancel puts the switches back", () => {
        show(suite({ ci: { enabled: true, source: "deployment" } }));
        expect(
            screen.getByText(/follows this deployment's default/i),
        ).toBeInTheDocument();
        const ci = screen.getByRole("switch", {
            name: "Run on every push, as a CI check",
        });
        expect(ci).toBeChecked();
        fireEvent.click(ci);
        expect(ci).not.toBeChecked();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(ci).toBeChecked();
        expect(update).not.toHaveBeenCalled();
    });

    it("is read only for who may not manage the environment: the switches are off the table and there is no Save", () => {
        show(suite(), false);
        expect(
            screen.getByRole("switch", {
                name: "Run only the specs the change reaches",
            }),
        ).toBeDisabled();
        expect(
            screen.queryByRole("button", { name: "Save" }),
        ).not.toBeInTheDocument();
    });
});
