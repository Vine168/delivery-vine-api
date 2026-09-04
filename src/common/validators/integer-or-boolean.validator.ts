import { ValidatorConstraint, type ValidatorConstraintInterface } from 'class-validator';

/**
 * Accepts a whole number or a boolean.
 *
 * Used where the acceptable type depends on data rather than the class — a
 * settings value, whose kind the catalogue knows. This only rules out
 * nonsense; the catalogue then rejects the wrong kind with a message that
 * names the setting.
 */
@ValidatorConstraint({ name: 'isIntegerOrBoolean', async: false })
export class IsIntegerOrBoolean implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'boolean' || (typeof value === 'number' && Number.isInteger(value));
  }

  defaultMessage(): string {
    return 'Value must be a whole number or true/false.';
  }
}
