import { ValidationPipe, type ValidationPipeOptions } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { AppException, type FieldError } from '../exceptions/app.exception.js';

/** Flattens nested class-validator errors into `packages[0].weightKg` paths. */
function flatten(errors: ValidationError[], parentPath = ''): FieldError[] {
  return errors.flatMap((error) => {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => ({ field: path, message }));
    const children = error.children?.length ? flatten(error.children, path) : [];
    return [...own, ...children];
  });
}

export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
  stopAtFirstError: false,
  validationError: { target: false, value: false },
  exceptionFactory: (errors: ValidationError[]) => AppException.validation(flatten(errors)),
};

export const createValidationPipe = (): ValidationPipe => new ValidationPipe(VALIDATION_PIPE_OPTIONS);
