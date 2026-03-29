import {
    hasUnsavedChanges,
    registerNavigationGuard,
    triggerNavigationBlock,
} from '../../../apps/web/src/core/utils/navigation-guard';

describe('core navigation guard', () => {
    afterEach(() => {
        // Clear all registered guards between tests.
        const cleanA = registerNavigationGuard('cleanup-a', {
            isDirty: () => false,
            onBlock: () => undefined,
        });
        const cleanB = registerNavigationGuard('cleanup-b', {
            isDirty: () => false,
            onBlock: () => undefined,
        });

        cleanA();
        cleanB();
    });

    it('reports unsaved changes when any registered guard is dirty', () => {
        const cleanup = registerNavigationGuard('dirty-form', {
            isDirty: () => true,
            onBlock: () => undefined,
        });

        expect(hasUnsavedChanges()).toBe(true);

        cleanup();
        expect(hasUnsavedChanges()).toBe(false);
    });

    it('triggers only the first dirty guard', () => {
        const firstOnBlock = jest.fn();
        const secondOnBlock = jest.fn();

        const cleanupFirst = registerNavigationGuard('first', {
            isDirty: () => true,
            onBlock: firstOnBlock,
        });
        const cleanupSecond = registerNavigationGuard('second', {
            isDirty: () => true,
            onBlock: secondOnBlock,
        });

        triggerNavigationBlock();

        expect(firstOnBlock).toHaveBeenCalledTimes(1);
        expect(secondOnBlock).not.toHaveBeenCalled();

        cleanupFirst();
        cleanupSecond();
    });

    it('ignores clean guards when triggering a block', () => {
        const cleanOnBlock = jest.fn();
        const dirtyOnBlock = jest.fn();

        const cleanupClean = registerNavigationGuard('clean', {
            isDirty: () => false,
            onBlock: cleanOnBlock,
        });
        const cleanupDirty = registerNavigationGuard('dirty', {
            isDirty: () => true,
            onBlock: dirtyOnBlock,
        });

        triggerNavigationBlock();

        expect(cleanOnBlock).not.toHaveBeenCalled();
        expect(dirtyOnBlock).toHaveBeenCalledTimes(1);

        cleanupClean();
        cleanupDirty();
    });
});
