"use client";

import { ExternalReferencesDisplay } from "./external-references-display";

const exampleExternalReferences = {
    references: [
        {
            filePath: "README.md",
            repositoryName: "task-api-example",
        },
    ],
    syncErrors: [],
    processingStatus: "completed" as const,
};

const exampleWithErrors = {
    references: [
        {
            filePath: "docs/api.md",
            repositoryName: "my-project",
        },
        {
            filePath: "CONTRIBUTING.md",
            repositoryName: "my-project",
        },
    ],
    syncErrors: [
        "Failed to fetch content from repository 'old-repo'",
        "File 'docs/old-guide.md' was deleted",
    ],
    processingStatus: "failed" as const,
};

const exampleProcessing = {
    references: [],
    syncErrors: [],
    processingStatus: "processing" as const,
};

export function ExternalReferencesTestPage() {
    return (
        <div className="space-y-6 p-6">
            <div>
                <h1 className="mb-4 text-2xl font-bold">
                    External References Display Examples
                </h1>

                <div className="max-w-md space-y-6">
                    <div>
                        <h2 className="mb-2 text-sm font-semibold">
                            Completed with 1 reference
                        </h2>
                        <ExternalReferencesDisplay
                            externalReferences={exampleExternalReferences}
                        />
                    </div>

                    <div>
                        <h2 className="mb-2 text-sm font-semibold">
                            Failed with 2 references and errors
                        </h2>
                        <ExternalReferencesDisplay
                            externalReferences={exampleWithErrors}
                        />
                    </div>

                    <div>
                        <h2 className="mb-2 text-sm font-semibold">
                            Processing status
                        </h2>
                        <ExternalReferencesDisplay
                            externalReferences={exampleProcessing}
                        />
                    </div>

                    <div>
                        <h2 className="mb-2 text-sm font-semibold">
                            No references (hidden)
                        </h2>
                        <ExternalReferencesDisplay
                            externalReferences={undefined}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
