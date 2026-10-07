import { LogController, type FastifyReply, type FastifyRequest } from "fastify";

/** Quiet successful requests while keeping Fastify failures visible. The
 * default controller includes error.message, which can contain source text. */
class SafeHttpLogController extends LogController {
  override incomingRequest() {}
  override requestCompleted() {}
  override routeNotFound() {}

  override defaultErrorLog(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const fields = {
      event: "http.request_failed",
      req: request,
      res: reply,
      err: error,
    };
    if (reply.statusCode >= 500)
      request.log.error(fields, "http.request_failed");
    else request.log.warn(fields, "http.request_failed");
  }
  override streamError(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    request.log.warn(
      { event: "http.stream_failed", res: reply, err: error },
      "http.stream_failed",
    );
  }
  override writeHeadError(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    request.log.warn(
      { event: "http.response_failed", res: reply, err: error },
      "http.response_failed",
    );
  }
  override serializerError(
    error: Error,
    request: FastifyRequest,
    _reply: FastifyReply,
    metadata: { statusCode: number },
  ) {
    request.log.error(
      {
        event: "http.serialization_failed",
        statusCode: metadata.statusCode,
        err: error,
      },
      "http.serialization_failed",
    );
  }
}

export function createHttpLogController() {
  return new SafeHttpLogController();
}
