import { SessionManager } from './session-manager';

describe('SessionManager cleanup timer', () => {
    it('does not keep the process alive', () => {
        const manager = new SessionManager();
        try {
            const timer = (manager as any).cleanupTimer as NodeJS.Timeout;
            expect(timer.hasRef()).toBe(false);
        } finally {
            manager.destroy();
        }
    });

    it('stops the timer on destroy', () => {
        const manager = new SessionManager();
        manager.destroy();
        expect((manager as any).cleanupTimer).toBeUndefined();
    });
});
