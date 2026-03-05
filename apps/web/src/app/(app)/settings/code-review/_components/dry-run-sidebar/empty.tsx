import { FlaskConical } from "lucide-react";

export const EmptyState = () => (
    <div className="flex h-full flex-1 flex-col items-center justify-center space-y-4 rounded-lg p-4 py-16 text-center">
        <div className="bg-card-lv2 flex h-16 w-16 items-center justify-center rounded-full">
            <FlaskConical className="text-primary-light h-8 w-8" />
        </div>
        <div className="space-y-1">
            <h3 className="text-lg font-semibold">Ready to test?</h3>
            <p className="text-text-tertiary max-w-sm text-sm">
                Select a closed Pull Request above and run a test to see exactly
                how Kodus will review code with your current settings.
            </p>
        </div>
    </div>
);
