// The detail modal derives its own watch history only when the caller did not hand it
// the one the page already computed.

export function shouldDeriveModalHistory(open: boolean, provided: readonly unknown[] | undefined): boolean {
    return open && provided === undefined
}

export function pickModalHistory<T>(provided: T[] | undefined, derived: T[]): T[] {
    return provided ?? derived
}
