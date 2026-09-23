import { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<unknown>;

// Express 4 does not catch rejected promises thrown inside async route handlers,
// so an unhandled rejection propagates up and crashes the whole Node process.
// Wrap every async handler with this so errors are forwarded to next() instead.
export function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
