import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/pagination.dto.js';
import { PhoneUtil } from '../../../common/utils/phone.util.js';
import { UserStatus } from '../../../generated/prisma/enums.js';
import { AdminPermissionDto } from './admin-session.dto.js';

/** Accepts what a person types (`012 345 678`) and stores E.164. */
const NormalisePhone = () =>
  Transform(({ value }) => (typeof value === 'string' ? PhoneUtil.normalise(value) : value));

// ── Roles ────────────────────────────────────────────────────────────────

export class AdminCreateRoleDto {
  @ApiProperty({ example: 'Dispatch supervisor' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ example: 'Watches the live map and reassigns stalled jobs' })
  @IsString()
  @MaxLength(280)
  @IsOptional()
  description?: string;

  @ApiProperty({
    type: [String],
    example: ['admin.access', 'dashboard.view', 'deliveries.view', 'deliveries.reassign'],
    description:
      'Permission codes from GET /admin/permissions. Every role needs admin.access or its holders cannot sign in to the back office at all.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  permissions: string[];
}

export class AdminUpdateRoleDto {
  @ApiPropertyOptional({ example: 'Dispatch supervisor' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(280)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Replaces the role’s permissions outright. Omit to leave them alone.',
  })
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @IsOptional()
  permissions?: string[];
}

export class AdminRoleDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Operations' })
  name: string;

  @ApiProperty({ example: 'operations' })
  slug: string;

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiProperty({
    example: true,
    description: 'System roles come from the platform’s own catalogue and cannot be edited or deleted.',
  })
  isSystem: boolean;

  @ApiProperty({ type: [AdminPermissionDto] })
  permissions: AdminPermissionDto[];

  @ApiProperty({ example: 3, description: 'Operators holding this role.' })
  adminCount: number;

  @ApiProperty()
  createdAt: string;
}

// ── Administrators ───────────────────────────────────────────────────────

export class AdminTeamQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Matches a name, phone number or email address.' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  search?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(32)
  @IsOptional()
  roleId?: string;

  @ApiPropertyOptional({ enum: UserStatus })
  @IsString()
  @IsOptional()
  status?: UserStatus;
}

export class AdminCreateAdministratorDto {
  @ApiProperty({ example: '012345678', description: 'Their sign-in identity. One phone, one back-office account.' })
  @NormalisePhone()
  @Matches(/^\+\d{8,15}$/, { message: 'Phone number is invalid.' })
  phone: string;

  @ApiProperty({ example: 'Sok Dara' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName: string;

  @ApiPropertyOptional({ example: 'dara@roktenh.com' })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiProperty({
    example: 'Passw0rd!23',
    description:
      'The password this operator signs in with first. Set it with them, or hand it over out of band — it is never returned by any endpoint afterwards.',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;

  @ApiProperty({ description: 'The role that decides what they may do.' })
  @IsString()
  @IsNotEmpty()
  roleId: string;
}

export class AdminUpdateAdministratorDto {
  @ApiPropertyOptional({ example: 'Sok Dara' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsOptional()
  fullName?: string;

  @ApiPropertyOptional({ example: 'dara@roktenh.com' })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  roleId?: string;

  @ApiPropertyOptional({
    description:
      'Grant or revoke unrestricted access. Only a super admin may change this, and never on their own account.',
  })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  isSuperAdmin?: boolean;
}

export class AdminResetPasswordDto {
  @ApiProperty({ example: 'N3wPassw0rd!' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}

export class AdminAdministratorDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  userId: string;

  @ApiProperty({ example: 'Sok Dara' })
  fullName: string;

  @ApiProperty({ example: '+85512345678' })
  phone: string;

  @ApiPropertyOptional({ nullable: true })
  email: string | null;

  @ApiPropertyOptional({ nullable: true })
  avatarUrl: string | null;

  @ApiProperty({ enum: UserStatus })
  status: UserStatus;

  @ApiPropertyOptional({ nullable: true, description: 'Null only for a super admin with no role assigned.' })
  roleId: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Operations' })
  roleName: string | null;

  @ApiProperty({ example: false })
  isSuperAdmin: boolean;

  @ApiProperty({ example: 14, description: 'How many permissions this account effectively holds.' })
  permissionCount: number;

  @ApiPropertyOptional({ nullable: true })
  lastLoginAt: string | null;

  @ApiProperty()
  createdAt: string;
}

// ── Audit log ────────────────────────────────────────────────────────────

export class AdminAuditQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ example: 'Delivery' })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  entityType?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(64)
  @IsOptional()
  entityId?: string;

  @ApiPropertyOptional({ description: 'The operator who acted.' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  actorUserId?: string;

  @ApiPropertyOptional({ example: 'withdrawal.settle', description: 'Matches part of the action name.' })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  action?: string;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsDateString()
  @IsOptional()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsDateString()
  @IsOptional()
  dateTo?: string;
}

export class AdminAuditEntryDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'withdrawal.settle' })
  action: string;

  @ApiProperty({ example: 'Withdrawal' })
  entityType: string;

  @ApiPropertyOptional({ nullable: true })
  entityId: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Settled KHR 100000 to Chan Sopheak (ABA-TRX-9F2K10)' })
  summary: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'The values before the change.' })
  before: Record<string, unknown> | null;

  @ApiPropertyOptional({ nullable: true, description: 'The values after it.' })
  after: Record<string, unknown> | null;

  @ApiPropertyOptional({ nullable: true })
  ipAddress: string | null;

  @ApiPropertyOptional({ nullable: true })
  actorUserId: string | null;

  @ApiProperty({ example: 'Sok Dara', description: '“System” when the platform acted on its own.' })
  actorName: string;

  @ApiProperty()
  createdAt: string;
}
