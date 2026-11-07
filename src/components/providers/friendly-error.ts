const NETWORK = /^(failed to fetch|load failed|networkerror|network request failed)/i
const PARSE = /unexpected (end of json|token)|is not valid json|json parse/i

export function friendlyError(error: unknown, fallback: string, networkMessage = 'Could not reach the AIOManager server. Check that it is running and your connection, then try again.'): string {
    if (!(error instanceof Error)) return fallback
    const message = error.message.trim()
    if (!message) return fallback
    if (NETWORK.test(message)) return networkMessage
    if (error instanceof SyntaxError || PARSE.test(message)) return 'The server sent an unreadable response. Try again in a moment.'
    return message
}
