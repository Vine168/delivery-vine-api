import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AdminPermissionDto {
  @ApiProperty({ example: 'deliveries.cancel' })
  code: string;

  @ApiProperty({ example: 'Deliveries' })
  module: string;

  @ApiProperty({ example: 'Cancel' })
  action: string;

  @ApiProperty({ example: 'Cancel a delivery on a customer’s behalf' })
  description: string;
}

export class AdminRoleSummaryDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Operations' })
  name: string;

  @ApiProperty({ example: 'operations' })
  slug: string;

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiProperty({ example: false, description: 'System roles cannot be renamed or deleted.' })
  isSystem: boolean;

  @ApiProperty({ example: 14 })
  permissionCount: number;
}

export class AdminSessionDto {
  @ApiProperty()
  adminId: string;

  @ApiProperty()
  userId: string;

  @ApiProperty({ example: 'Sok Dara' })
  fullName: string;

  @ApiProperty({ example: '+85510000001' })
  phone: string;

  @ApiPropertyOptional({ nullable: true })
  email: string | null;

  @ApiPropertyOptional({ nullable: true })
  avatarUrl: string | null;

  @ApiPropertyOptional({ nullable: true, type: AdminRoleSummaryDto })
  role: AdminRoleSummaryDto | null;

  @ApiProperty({
    example: true,
    description: 'A super admin passes every permission check regardless of role.',
  })
  isSuperAdmin: boolean;

  @ApiProperty({
    type: [String],
    example: ['admin.access', 'dashboard.view', 'deliveries.view'],
    description: 'What this operator may do. The dashboard uses it to decide which screens to render.',
  })
  permissions: string[];

  @ApiPropertyOptional({ nullable: true })
  lastLoginAt: string | null;
}
