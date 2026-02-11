import { normalizeAddonUrl } from '@/lib/utils';

interface RestorationState {
    status: 'idle' | 'restoring' | 'failed' | 'healthy';
    failureCount: number;
    lastFailureTime: number;
    circuitState: 'closed' | 'open' | 'half-open';
    lastRestorationAttempt?: number;
    restorationAttempts: number;
}

class RestorationManager {
    private states = new Map<string, RestorationState>();
    private readonly MAX_FAILURES = 3;
    private readonly CIRCUIT_COOLDOWN = 30 * 60 * 1000; // 30 mins

    private getState(addonUrl: string): RestorationState {
        const normalized = normalizeAddonUrl(addonUrl).toLowerCase();
        if (!this.states.has(normalized)) {
            this.states.set(normalized, {
                status: 'idle',
                failureCount: 0,
                lastFailureTime: 0,
                circuitState: 'closed',
                restorationAttempts: 0
            });
        }
        return this.states.get(normalized)!;
    }

    canAttemptRestore(addonUrl: string, autoRestoreEnabled: boolean): boolean {
        if (!autoRestoreEnabled) return false;

        const state = this.getState(addonUrl);

        if (state.circuitState === 'open') {
            if (Date.now() - state.lastFailureTime < this.CIRCUIT_COOLDOWN) {
                return false;
            }
            state.circuitState = 'half-open';
        }

        if (state.restorationAttempts > 0) {
            const backoffTime = Math.pow(3, state.restorationAttempts - 1) * 5 * 60 * 1000;
            if (Date.now() - (state.lastRestorationAttempt || 0) < backoffTime) {
                return false;
            }
        }

        return true;
    }

    recordAttempt(addonUrl: string) {
        const state = this.getState(addonUrl);
        state.status = 'restoring';
        state.lastRestorationAttempt = Date.now();
        state.restorationAttempts++;
    }

    recordSuccess(addonUrl: string) {
        const state = this.getState(addonUrl);
        state.status = 'healthy';
        state.failureCount = 0;
        state.restorationAttempts = 0;
        state.circuitState = 'closed';
    }

    recordFailure(addonUrl: string) {
        const state = this.getState(addonUrl);
        state.status = 'failed';
        state.failureCount++;
        state.lastFailureTime = Date.now();

        if (state.failureCount >= this.MAX_FAILURES) {
            state.circuitState = 'open';
        }
    }

    getStatus(addonUrl: string): RestorationState {
        return this.getState(addonUrl);
    }

    resetCircuit(addonUrl: string) {
        const state = this.getState(addonUrl);
        state.circuitState = 'closed';
        state.failureCount = 0;
        state.restorationAttempts = 0;
        state.status = 'idle';
    }
}

export const restorationManager = new RestorationManager();
