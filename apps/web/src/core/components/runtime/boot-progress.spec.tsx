/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { render, screen } from "@testing-library/react";

import { BootProgress } from "./boot-progress";

describe("BootProgress", () => {
    const progress = {
        phases: [
            {
                phase: "fetch",
                state: "done" as const,
                at: "2026-11-04T17:00:09Z",
                ms: 9323,
            },
            {
                phase: "compose",
                state: "started" as const,
                at: "2026-11-04T17:00:10Z",
            },
        ],
        lines: ["#13 [go-builder 29/42] RUN go mod download"],
        updatedAt: "2026-11-04T17:01:00Z",
    };

    it("shows each machine phase with its time and the running one's live output", () => {
        render(<BootProgress progress={progress} live />);
        expect(screen.getByText("Download the code")).toBeInTheDocument();
        expect(screen.getByText("Build and start")).toBeInTheDocument();
        expect(screen.getByText("Running")).toBeInTheDocument();
        expect(screen.getByLabelText("Live output")).toHaveTextContent(
            "RUN go mod download",
        );
    });

    it("says a phase stopped once the boot is over", () => {
        render(<BootProgress progress={progress} live={false} />);
        expect(screen.getByText("Stopped")).toBeInTheDocument();
        expect(screen.getByLabelText("Last output")).toBeInTheDocument();
    });

    it("says what the last setup that booted took, overall and per phase", () => {
        render(
            <BootProgress
                progress={progress}
                live={false}
                last={{
                    finishedAt: "2026-11-03T10:00:00Z",
                    totalMs: 720_000,
                    phases: [
                        { phase: "fetch", ms: 10_000 },
                        { phase: "compose", ms: 600_000 },
                    ],
                }}
            />,
        );
        expect(
            screen.getByText(/The last setup that booted took/),
        ).toHaveTextContent("The last setup that booted took 12 min 00 s");
        expect(screen.getByText("last time 10 min 00 s")).toBeInTheDocument();
        expect(screen.getByText("last time 10 s")).toBeInTheDocument();
    });
});
