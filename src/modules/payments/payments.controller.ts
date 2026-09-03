import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiSuccessResponse } from '../../common/decorators/api-docs.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ResponseCode as ResponseCodeMeta } from '../../common/decorators/response-code.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { IdParamDto } from '../../common/dto/id-param.dto.js';
import { UserRole } from '../../generated/prisma/enums.js';
import { InitiatePaymentDto, PaymentDto, PaymentMethodDto } from './dto/payment.dto.js';
import { PaymentsService } from './payments.service.js';

@ApiTags('Payments')
@ApiBearerAuth()
@Roles(UserRole.CUSTOMER)
@Controller({ path: 'mobile/customer', version: '1' })
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('payment-methods')
  @ResponseCodeMeta(ResponseCode.PAYMENT_METHODS_FETCHED)
  @ApiOperation({
    summary: 'Payment methods',
    description:
      'Each method reports whether it is actually usable. A method that is not configured is returned as unavailable with a reason, rather than being silently hidden or failing at checkout.',
  })
  @ApiSuccessResponse({ code: ResponseCode.PAYMENT_METHODS_FETCHED, type: PaymentMethodDto, isArray: true })
  listMethods(): PaymentMethodDto[] {
    return this.payments.listMethods();
  }

  @Post('deliveries/:id/payment')
  @HttpCode(HttpStatus.CREATED)
  @ResponseCodeMeta(ResponseCode.PAYMENT_INITIATED)
  @ApiOperation({
    summary: 'Start paying for a delivery',
    description:
      'Returns the KHQR payload to render for bank payments, or an ordinary pending record for cash. Asking twice while a payment is still open returns the same one rather than issuing a second charge.',
  })
  @ApiSuccessResponse({ status: 201, code: ResponseCode.PAYMENT_INITIATED, type: PaymentDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.DELIVERY_NOT_FOUND },
    { status: 409, code: ResponseCode.PAYMENT_ALREADY_PAID },
    { status: 422, code: ResponseCode.PAYMENT_METHOD_NOT_SUPPORTED },
    { status: 503, code: ResponseCode.PAYMENT_PROVIDER_ERROR },
  )
  initiate(
    @CurrentUser('customerId') customerId: string,
    @Param() params: IdParamDto,
    @Body() dto: InitiatePaymentDto,
  ): Promise<PaymentDto> {
    return this.payments.initiate(customerId, params.id, dto);
  }

  @Get('deliveries/:id/payment')
  @ResponseCodeMeta(ResponseCode.PAYMENT_FETCHED)
  @ApiOperation({
    summary: 'Payment status',
    description:
      'Checks with the provider while a payment is still open, so a lost callback cannot leave a paid delivery looking unpaid.',
  })
  @ApiSuccessResponse({ code: ResponseCode.PAYMENT_FETCHED, type: PaymentDto })
  @ApiErrorResponses(
    { status: 404, code: ResponseCode.DELIVERY_NOT_FOUND },
    { status: 404, code: ResponseCode.PAYMENT_NOT_FOUND },
  )
  status(@CurrentUser('customerId') customerId: string, @Param() params: IdParamDto): Promise<PaymentDto> {
    return this.payments.status(customerId, params.id);
  }
}
