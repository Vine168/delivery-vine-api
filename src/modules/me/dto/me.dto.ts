import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClientApp, DriverApprovalStatus, UserStatus } from '../../../generated/prisma/enums.js';

export class MeAccountDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: '+85512345678' })
  phone: string;

  @ApiPropertyOptional({ nullable: true, example: 'dara@example.com' })
  email: string | null;

  @ApiProperty({ enum: UserStatus })
  status: UserStatus;

  @ApiPropertyOptional({
    enum: ClientApp,
    nullable: true,
    description: 'The app this session signed in through; null for a build that did not say.',
  })
  app: ClientApp | null;
}

export class MeCustomerDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Sok Dara', description: 'The name the person chose for the customer app.' })
  fullName: string;

  @ApiPropertyOptional({ nullable: true })
  avatarUrl: string | null;

  @ApiProperty({
    example: false,
    description: 'True while an operator has stopped this account booking. The driver side is unaffected.',
  })
  suspended: boolean;
}

export class MeDriverDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Chan Sopheak', description: 'The name on the driver’s ID, locked once approved.' })
  fullName: string;

  @ApiPropertyOptional({ nullable: true })
  avatarUrl: string | null;

  @ApiProperty({ enum: DriverApprovalStatus })
  approvalStatus: DriverApprovalStatus;

  @ApiPropertyOptional({
    nullable: true,
    description: 'When the application was handed in; null while it is still being filled out.',
  })
  submittedAt: string | null;

  @ApiProperty({ example: false })
  canGoOnline: boolean;

  @ApiProperty({
    type: [String],
    example: ['DRIVER_NOT_APPROVED'],
    description:
      'What still stands between the driver and going online, as response codes — the same list the driver profile shows as a checklist.',
  })
  blockers: string[];
}

export class MeDto {
  @ApiProperty({ type: MeAccountDto })
  account: MeAccountDto;

  @ApiPropertyOptional({ type: MeCustomerDto, nullable: true })
  customer: MeCustomerDto | null;

  @ApiPropertyOptional({
    type: MeDriverDto,
    nullable: true,
    description: 'Null until the account applies to drive — the driver app shows its Apply screen.',
  })
  driver: MeDriverDto | null;
}
