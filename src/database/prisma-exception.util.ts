import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/exceptions/app.exception.js';
import { ResponseCode } from '../common/constants/response-codes.js';

/** Prisma error codes we translate deliberately. Anything else stays a 500. */
const PRISMA_ERROR = {
  UNIQUE_CONSTRAINT: 'P2002',
  FOREIGN_KEY_CONSTRAINT: 'P2003',
  CONSTRAINT_FAILED: 'P2004',
  RECORD_NOT_FOUND: 'P2025',
  VALUE_TOO_LONG: 'P2000',
  TRANSACTION_CONFLICT: 'P2034',
} as const;

interface PrismaKnownError {
  code: string;
  meta?: Record<string, unknown>;
  message: string;
}

export function isPrismaKnownError(error: unknown): error is PrismaKnownError {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    /^P\d{4}$/.test((error as { code: string }).code)
  );
}

/**
 * Names of the partial unique indexes that enforce the assignment race. When
 * Postgres rejects a write on one of these, the correct answer is 409 with a
 * precise code — not a generic conflict.
 */
const CONFLICT_INDEX_CODES: Record<string, ResponseCode> = {
  DeliveryAssignment_delivery_accepted_key: ResponseCode.DELIVERY_ALREADY_ASSIGNED,
  DeliveryAssignment_driver_accepted_key: ResponseCode.DRIVER_HAS_ACTIVE_DELIVERY,
  Delivery_driver_active_key: ResponseCode.DRIVER_HAS_ACTIVE_DELIVERY,
};

function constraintTarget(error: PrismaKnownError): string {
  const target = error.meta?.target;
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) return target.join(', ');
  return '';
}

/**
 * Translates a Prisma error into an AppException, or returns null when the
 * error is not one we map (the caller then rethrows).
 */
export function translatePrismaError(error: unknown, fallbackNotFoundCode?: ResponseCode): AppException | null {
  if (!isPrismaKnownError(error)) return null;

  switch (error.code) {
    case PRISMA_ERROR.UNIQUE_CONSTRAINT: {
      const target = constraintTarget(error);
      const mapped = CONFLICT_INDEX_CODES[target];
      if (mapped) {
        return new AppException(mapped, HttpStatus.CONFLICT);
      }
      return new AppException(
        ResponseCode.CONFLICT,
        HttpStatus.CONFLICT,
        `A record with the same ${target || 'value'} already exists.`,
      );
    }

    case PRISMA_ERROR.RECORD_NOT_FOUND:
      return AppException.notFound(fallbackNotFoundCode ?? ResponseCode.NOT_FOUND);

    case PRISMA_ERROR.FOREIGN_KEY_CONSTRAINT:
      return AppException.badRequest(
        ResponseCode.VALIDATION_ERROR,
        'A referenced record does not exist.',
      );

    case PRISMA_ERROR.TRANSACTION_CONFLICT:
      return AppException.conflict(
        ResponseCode.CONFLICT,
        'The request conflicted with another concurrent operation. Please retry.',
      );

    case PRISMA_ERROR.VALUE_TOO_LONG:
      return AppException.badRequest(ResponseCode.VALIDATION_ERROR, 'A submitted value is too long.');

    default:
      return null;
  }
}
