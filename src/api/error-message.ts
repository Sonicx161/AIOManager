export async function readApiErrorMessage(res: Response): Promise<string> {
    const body = await res.json().catch(() => null) as { error?: unknown } | null
    if (body && typeof body.error === 'string' && body.error) return body.error
    return `The server sent an unexpected reply (HTTP ${res.status}). Try again. If it keeps happening, tell whoever runs this AIOManager server and mention the code.`
}
