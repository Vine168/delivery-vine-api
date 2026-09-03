import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { UserRole } from '../../generated/prisma/enums.js';
import { PromoValidationDto, ValidatePromoDto } from './dto/promo.dto.js';
import { PromoCodesService } from './promo-codes.service.js';

@ApiTags('Promotions')
@ApiBearerAuth()
@Roles(UserRole.CUSTOMER)
@Controller({ path: 'mobile/customer/promos', version: '1' })
export class PromoCodesController {
  constructor(private readonly promos: PromoCodesService) {}

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @ResponseCodeMeta(ResponseCode.PROMO_VALID)
  @ApiOperation({
    summary: 'Check a promo code against an order',
    description:
      'Validates existence, activity, window, currency, minimum order, vehicle restriction, global usage and this customer’s usage, and returns the discount it would give. The code is validated again when the booking is written.',
  })
  @ApiSuccessResponse({ code: ResponseCode.PROMO_VALID, type: PromoValidationDto })
  @ApiErrorResponses(
    { status: 422, code: ResponseCode.PROMO_NOT_FOUND },
    { status: 422, code: ResponseCode.PROMO_EXPIRED },
    { status: 422, code: ResponseCode.PROMO_MIN_ORDER_NOT_MET },
    { status: 422, code: ResponseCode.PROMO_CUSTOMER_LIMIT_REACHED },
    { status: 422, code: ResponseCode.PROMO_VEHICLE_NOT_ELIGIBLE },
  )
  validate(
    @CurrentUser('customerId') customerId: string,
    @Body() dto: ValidatePromoDto,
  ): Promise<PromoValidationDto> {
    return this.promos.validate({ ...dto, customerId });
  }
}
