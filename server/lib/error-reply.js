import { applyAccountStateErrorMapping } from '../admin/account-state.js'

export const GENERIC_SERVER_ERROR = 'Internal Server Error'

// Explicit marker for application errors whose 5xx message is deliberately
// client-facing (approved upstream-failure copy and the like). An HTTP status
// alone is not evidence that a message is public: Fastify attaches
// statusCode 500 to its own internal errors (e.g. invalid payload type), and
// library/driver errors can carry any status. Code that throws a 5xx and
// wants its text shown to the client must opt in through this helper.
export function markPublicError(error) {
    if (error && typeof error === 'object') error.isPublicError = true
    return error
}

const isMarkedPublicError = (error) => error?.isPublicError === true

export function publicErrorMessage(error) {
    const explicit = error?.statusCode ?? error?.status
    const status = Number(explicit) || 500
    // 4xx contracts (validation, auth, deliberate rejections) keep their text.
    if (status < 500) return error?.message || 'Request failed'
    // 5xx text reaches the client only through the explicit marker above;
    // every other 5xx, status or not, is masked. The full error still goes
    // to the server log.
    if (isMarkedPublicError(error)) return error?.message || GENERIC_SERVER_ERROR
    return GENERIC_SERVER_ERROR
}

export function serverErrorHandler(error, request, reply) {
    const stateBody = applyAccountStateErrorMapping(error, reply)
    if (stateBody) {
        reply.header('Cache-Control', 'no-store')
        return stateBody
    }
    const status = error.statusCode || error.status || 500
    // A client killing its own connection (tab close, navigation, an extension aborting
    // in-flight requests) surfaces here as stream teardown, not a server fault.
    const clientAborted = error.code === 'FST_ERR_REQUEST_ABORTED'
        || error.code === 'ERR_STREAM_PREMATURE_CLOSE'
        || request.raw.socket?.destroyed === true
    if (clientAborted) {
        request.log.info(`Client aborted ${request.method}:${request.routeOptions?.url || request.url.split('?')[0]}`)
    } else if (status >= 500) {
        request.log.error({ err: error }, `Unhandled error on ${request.method}:${request.routeOptions?.url || request.url.split('?')[0]}`)
    }
    if (status >= 400) reply.header('Cache-Control', 'no-store')
    reply.status(status >= 400 && status < 600 ? status : 500)
    return { error: publicErrorMessage(error) }
}

