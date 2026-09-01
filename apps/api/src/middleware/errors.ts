import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import { ApiError, badRequest, notFound } from '../errors.js';
import { logger } from '../logger.js';

/** Validates and replaces `req.body`, turning Zod issues into a 400 payload. */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      next(zodToApiError(result.error));
      return;
    }
    req.body = result.data;
    next();
  };
}

export function zodToApiError(error: ZodError): ApiError {
  return badRequest(
    'validation_failed',
    'Some of the values you sent are not valid.',
    error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );
}

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}

export function notFoundHandler() {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    next(notFound('That endpoint does not exist.'));
  };
}

/**
 * Terminal error handler.
 *
 * Only `ApiError` messages reach the client. Anything else is logged with its
 * stack and answered with a generic message, so an unexpected failure cannot
 * leak a SQL fragment or a file path to a caller.
 */
export function errorHandler() {
  return (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (error instanceof ZodError) {
      const apiError = zodToApiError(error);
      res.status(apiError.status).json(apiError.toBody());
      return;
    }

    if (error instanceof ApiError) {
      if (error.retryAfter !== undefined) res.setHeader('Retry-After', String(error.retryAfter));
      if (error.status >= 500) {
        logger.error('request.failed', { path: req.path, code: error.code, message: error.message });
      }
      res.status(error.status).json(error.toBody());
      return;
    }

    logger.error('request.unhandled_error', {
      path: req.path,
      method: req.method,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    res.status(500).json({
      error: { code: 'internal_error', message: 'Something went wrong. Please try again.' },
    });
  };
}
