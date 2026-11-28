/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import {
    BOOT_TITLE,
    bootFailureRun,
    SUMDB_ERROR_LINE,
} from "@services/runtime/model/__fixtures__/run-detail";
import { bootFailureOf } from "@services/runtime/model/boot-failure";
import { fireEvent, render, screen } from "@testing-library/react";

import { BootFailurePanel } from "./boot-failure";

describe("BootFailurePanel", () => {
    it("shows the title, the error line highlighted and the last lines, the rest one click away", () => {
        render(<BootFailurePanel failure={bootFailureOf(bootFailureRun())!} />);
        expect(screen.getByText(BOOT_TITLE)).toBeInTheDocument();
        const list = screen.getByRole("list", {
            name: "Last log lines of this PR",
        });
        expect(list.querySelectorAll("li")).toHaveLength(6);
        expect(
            screen.getByText(`#12 12.03 ${SUMDB_ERROR_LINE}`).closest("li"),
        ).toHaveClass("text-danger");
        fireEvent.click(
            screen.getByRole("button", {
                name: "Show all 10 lines the machine kept",
            }),
        );
        expect(list.querySelectorAll("li")).toHaveLength(10);
    });
});
