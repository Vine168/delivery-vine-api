import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { RequiresMobileAccount } from '../../common/decorators/capability.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface.js';
import { MeDto } from './dto/me.dto.js';
import { MeService } from './me.service.js';

@ApiTags('Account')
@ApiBearerAuth()
// Any mobile account: a customer barred from booking still needs to be told
// so, and a driver who is suspended still needs their first screen.
@RequiresMobileAccount()
@Controller({ path: 'mobile', version: '1' })
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get('me')
  @ResponseCodeMeta(ResponseCode.PROFILE_FETCHED)
  @ApiOperation({
    summary: 'Who is signed in, and what each side of the account may do',
    description:
      'One call for both apps to choose their first screen: call it at launch and after signing in. `driver` is null until the account applies to drive — the driver app shows its Apply screen — and otherwise carries the approval status and whatever still stands between the driver and going online. `customer.suspended` is true while an operator has stopped the account booking.',
  })
  @ApiSuccessResponse({ code: ResponseCode.PROFILE_FETCHED, type: MeDto })
  find(@CurrentUser() user: AuthenticatedUser): Promise<MeDto> {
    return this.me.find(user);
  }
}
