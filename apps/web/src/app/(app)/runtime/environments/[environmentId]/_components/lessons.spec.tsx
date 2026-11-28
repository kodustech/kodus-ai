/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { RuntimeLesson } from "@services/runtime/contracts";
import {
    useEnvironmentLessons,
    useUpdateEnvironmentLesson,
} from "@services/runtime/queries";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { EnvironmentLessons } from "./lessons";

jest.mock("@services/runtime/queries", () => ({
    useEnvironmentLessons: jest.fn(),
    useUpdateEnvironmentLesson: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

const LESSON: RuntimeLesson = {
    lessonId: "a".repeat(32),
    scope: "repo",
    signature: "missing_env:SESSION_SECRET",
    kind: "missing_env",
    problem: "The app needs SESSION_SECRET, which the environment doesn't set",
    cause: "The app reads an environment variable the machine did not set.",
    fix: {
        id: "set_env:SESSION_SECRET",
        action: "set_env",
        summary: "Set SESSION_SECRET in services.compose.env of the recipe.",
    },
    helped: 3,
    firstAt: "2026-11-01T10:00:00.000Z",
    lastAt: "2026-11-04T10:00:00.000Z",
    origin: {
        sha: "f00dbabe".padEnd(40, "0"),
        branch: "main",
        at: "2026-11-01T10:00:00.000Z",
        repositoryId: "repo-1",
    },
};

const mutate = jest.fn();
beforeEach(() => {
    mutate.mockReset();
    (useUpdateEnvironmentLesson as jest.Mock).mockReturnValue({
        mutate,
        isPending: false,
    });
});

describe("EnvironmentLessons", () => {
    it("shows the problem, cause, what worked and where it was proven", () => {
        (useEnvironmentLessons as jest.Mock).mockReturnValue({
            data: [LESSON],
            isLoading: false,
            isError: false,
        });
        render(<EnvironmentLessons environmentId="env-1" canManage={false} />);
        const row = within(
            screen.getByRole("list", { name: "Lessons" }),
        ).getByRole("listitem");
        expect(row).toHaveTextContent(
            "Set SESSION_SECRET in services.compose.env of the recipe.",
        );
        expect(row).toHaveTextContent("f00dbab");
        expect(row).toHaveTextContent("helped 3×");
        expect(row).toHaveTextContent("This repository");
        // Only an org admin acts on memory.
        expect(within(row).queryByRole("button")).not.toBeInTheDocument();
    });

    it("promotes to the org after confirming", () => {
        (useEnvironmentLessons as jest.Mock).mockReturnValue({
            data: [LESSON],
            isLoading: false,
            isError: false,
        });
        render(<EnvironmentLessons environmentId="env-1" canManage />);
        fireEvent.click(
            screen.getByRole("button", { name: "Use in the whole org" }),
        );
        expect(mutate).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Promote" }));
        expect(mutate).toHaveBeenCalledWith(
            {
                environmentId: "env-1",
                lessonId: LESSON.lessonId,
                action: "promote",
            },
            expect.anything(),
        );
    });

    it("offers no promotion for an org lesson, and says when nothing was learned", () => {
        (useEnvironmentLessons as jest.Mock).mockReturnValue({
            data: [{ ...LESSON, scope: "org" }],
            isLoading: false,
            isError: false,
        });
        const { rerender } = render(
            <EnvironmentLessons environmentId="env-1" canManage />,
        );
        expect(
            screen.queryByRole("button", { name: "Use in the whole org" }),
        ).not.toBeInTheDocument();
        expect(screen.getByText("Whole org")).toBeInTheDocument();
        (useEnvironmentLessons as jest.Mock).mockReturnValue({
            data: [],
            isLoading: false,
            isError: false,
        });
        rerender(<EnvironmentLessons environmentId="env-1" canManage />);
        expect(screen.getByText(/Nothing learned yet/)).toBeInTheDocument();
    });
});
