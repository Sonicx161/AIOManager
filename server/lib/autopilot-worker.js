// AUTOPILOT_WORKER parsing shared by boot (server/main.js) and the pulse route,
// so the flag clients see is always the flag boot acted on. Off spellings only;
// unset, empty and unrecognized values all leave the worker enabled.

const OFF_VALUES = new Set(['0', 'false', 'off', 'no'])

export function autopilotWorkerEnabled(raw = process.env.AUTOPILOT_WORKER) {
    return !OFF_VALUES.has(String(raw ?? '').trim().toLowerCase())
}
