/** @jest-environment jsdom */
// @ts-nocheck
import "@testing-library/jest-dom";

import { render, screen } from "@testing-library/react";

import { getSpecialists, SpecialistAgentsTable } from "./specialist-agents";

describe("getSpecialists", () => {
    it("adds up a lens's batches and keeps its worst status", () => {
        const rows = getSpecialists({
            specialists: [
                {
                    label: "lens-data-exposure",
                    status: "success",
                    batchIndex: 1,
                    kept: 1,
                    durationMs: 1000,
                    toolCalls: 2,
                },
                {
                    label: "lens-data-exposure",
                    status: "failed",
                    batchIndex: 2,
                    kept: 0,
                    durationMs: 500,
                    toolCalls: 1,
                    error: "Rate limited",
                },
            ],
        });

        expect(rows).toEqual([
            {
                label: "lens-data-exposure",
                name: "Data exposure",
                status: "failed",
                kept: 1,
                durationMs: 1500,
                toolCalls: 3,
                error: "Rate limited",
            },
        ]);
    });

    it("reads a lens stopped only when no batch ran it", () => {
        const rows = getSpecialists({
            specialists: [
                { label: "lens-a", status: "stopped", batchIndex: 1 },
                { label: "lens-a", status: "success", batchIndex: 2, kept: 2 },
                { label: "lens-b", status: "stopped", batchIndex: 1 },
            ],
        });

        expect(rows?.map((r) => [r.label, r.status, r.kept])).toEqual([
            ["lens-a", "success", 2],
            ["lens-b", "stopped", undefined],
        ]);
    });

    it("leaves a stopped batch's findings and unknown statuses out", () => {
        const rows = getSpecialists({
            specialists: [
                { label: "lens-a", status: "success", batchIndex: 1, kept: 1 },
                { label: "lens-a", status: "stopped", batchIndex: 2, kept: 4 },
                { label: "lens-b", status: "bogus", batchIndex: 1, kept: 9 },
                { label: "lens-c", status: "toString", batchIndex: 1 },
            ],
        });

        expect(rows?.map((r) => [r.label, r.status, r.kept])).toEqual([
            ["lens-a", "success", 1],
        ]);
    });

    it("is null for an entry that is not the specialists one", () => {
        expect(getSpecialists({ agentTrace: {} })).toBeNull();
    });
});

describe("SpecialistAgentsTable", () => {
    it("lists every agent and says why one failed", () => {
        render(
            <SpecialistAgentsTable
                rows={getSpecialists({
                    specialists: [
                        {
                            label: "lens-text-that-ships",
                            status: "success",
                            kept: 2,
                            durationMs: 58000,
                            toolCalls: 3,
                        },
                        {
                            label: "lens-changed-files-disagree",
                            status: "failed",
                            error: "Rate limited by the provider",
                        },
                    ],
                })}
            />,
        );

        expect(screen.getByText("2 agents (1 failed)")).toBeInTheDocument();
        expect(screen.getByText("Text that ships")).toBeInTheDocument();
        expect(screen.getByText("58s")).toBeInTheDocument();
        expect(
            screen.getByText("Rate limited by the provider"),
        ).toBeInTheDocument();
    });
});
