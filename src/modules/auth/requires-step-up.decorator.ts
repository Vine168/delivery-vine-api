import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { METADATA_KEY } from '../../common/constants/app.constants.js';

/**
 * Requires a fresh password confirmation, sent as the X-Step-Up-Token header.
 * For the routes that move money or decide where it goes; see StepUpGuard.
 */
export const RequiresStepUp = () =>
  applyDecorators(
    SetMetadata(METADATA_KEY.STEP_UP, true),
    ApiHeader({
      name: 'X-Step-Up-Token',
      required: false,
      description:
        'From POST /auth/step-up, made on this session in the last five minutes. A wrong or expired one is refused with 403 STEP_UP_REQUIRED.',
    }),
  );
