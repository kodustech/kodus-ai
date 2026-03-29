type NavigationGuardConfig = {
    isDirty: () => boolean;
    onBlock: () => void;
};

const guards = new Map<string, NavigationGuardConfig>();

export function registerNavigationGuard(
    id: string,
    config: NavigationGuardConfig,
) {
    guards.set(id, config);

    return () => {
        guards.delete(id);
    };
}

export function hasUnsavedChanges(): boolean {
    for (const guard of guards.values()) {
        if (guard.isDirty()) {
            return true;
        }
    }

    return false;
}

export function triggerNavigationBlock(): void {
    for (const guard of guards.values()) {
        if (!guard.isDirty()) {
            continue;
        }

        guard.onBlock();
        return;
    }
}
