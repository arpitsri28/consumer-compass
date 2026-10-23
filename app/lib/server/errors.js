export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorResponse(error) {
  const known = error instanceof HttpError;
  return Response.json(
    {
      error: {
        code: known ? error.code : "INTERNAL_ERROR",
        message: known ? error.message : "An unexpected error occurred.",
        ...(known && error.details ? { details: error.details } : {}),
      },
    },
    { status: known ? error.status : 500, headers: { "Cache-Control": "no-store" } },
  );
}
