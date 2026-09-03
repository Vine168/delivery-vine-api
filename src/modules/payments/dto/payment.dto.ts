import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { Currency, PaymentMethod, PaymentStatus } from '../../../generated/prisma/enums.js';

export class InitiatePaymentDto {
  @ApiProperty({ enum: PaymentMethod, description: 'How the customer wants to pay this delivery.' })
  @IsEnum(PaymentMethod)
  method: PaymentMethod;
}

export class PaymentMethodDto {
  @ApiProperty({ enum: PaymentMethod })
  method: PaymentMethod;

  @ApiProperty({ example: 'Cash on delivery' })
  label: string;

  @ApiProperty({ example: true })
  available: boolean;

  @ApiPropertyOptional({ nullable: true, example: 'KHQR payments are not configured yet.' })
  unavailableReason: string | null;

  @ApiProperty({ example: false, description: 'Whether the customer pays before the delivery starts.' })
  prepaid: boolean;
}

export class PaymentDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  deliveryId: string;

  @ApiProperty({ enum: PaymentMethod })
  method: PaymentMethod;

  @ApiProperty({ enum: PaymentStatus })
  status: PaymentStatus;

  @ApiProperty({ example: 15_800 })
  amount: number;

  @ApiProperty({ enum: Currency })
  currency: Currency;

  @ApiPropertyOptional({
    nullable: true,
    description: 'KHQR payload to render as a QR code. Null for cash.',
    example: '00020101021229130009merchant@aclb…',
  })
  qrString: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Deep link into a banking app, when the provider offers one.' })
  deepLink: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'When an unpaid QR stops being valid.' })
  expiresAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  paidAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  failureReason: string | null;

  @ApiProperty()
  createdAt: string;
}
