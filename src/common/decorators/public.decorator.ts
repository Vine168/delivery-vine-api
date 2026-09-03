import { SetMetadata } from '@nestjs/common';
import { METADATA_KEY } from '../constants/app.constants.js';

/** Opts a route out of the global JWT guard. */
export const Public = () => SetMetadata(METADATA_KEY.IS_PUBLIC, true);
