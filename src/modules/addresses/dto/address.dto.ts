import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { AddressLabel } from '../../../generated/prisma/enums.js';
import { PhoneUtil } from '../../../common/utils/phone.util.js';

const NormalisePhone = () => Transform(({ value }) => (typeof value === 'string' ? PhoneUtil.normalise(value) : value));

export class CreateAddressDto {
  @ApiProperty({ enum: AddressLabel, default: AddressLabel.OTHER })
  @IsEnum(AddressLabel)
  label: AddressLabel = AddressLabel.OTHER;

  @ApiPropertyOptional({ example: 'Mum’s house', description: 'A name the customer gives this address.' })
  @IsString()
  @MaxLength(80)
  @IsOptional()
  title?: string;

  @ApiProperty({ example: 'St. 271, Sangkat Boeng Keng Kang Ti Muoy, Phnom Penh' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(400)
  addressLine: string;

  @ApiProperty({ example: 11.5564 })
  @Type(() => Number)
  @IsNumber()
  @IsLatitude({ message: 'Latitude must be between -90 and 90.' })
  latitude: number;

  @ApiProperty({ example: 104.9282 })
  @Type(() => Number)
  @IsNumber()
  @IsLongitude({ message: 'Longitude must be between -180 and 180.' })
  longitude: number;

  @ApiPropertyOptional({ description: 'Place id from the location search, when the address came from one.' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  placeId?: string;

  @ApiProperty({ example: 'Sok Dara' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  contactName: string;

  @ApiProperty({ example: '012345678' })
  @NormalisePhone()
  @Matches(/^\+\d{8,15}$/, { message: 'Contact phone number is invalid.' })
  contactPhone: string;

  @ApiPropertyOptional({ example: 'Blue gate, second floor' })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  remarks?: string;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}

export class UpdateAddressDto {
  @ApiPropertyOptional({ enum: AddressLabel })
  @IsEnum(AddressLabel)
  @IsOptional()
  label?: AddressLabel;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(80)
  @IsOptional()
  title?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(400)
  @IsOptional()
  addressLine?: string;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsNumber()
  @IsLatitude({ message: 'Latitude must be between -90 and 90.' })
  @IsOptional()
  latitude?: number;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsNumber()
  @IsLongitude({ message: 'Longitude must be between -180 and 180.' })
  @IsOptional()
  longitude?: number;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(120)
  @IsOptional()
  placeId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsOptional()
  contactName?: string;

  @ApiPropertyOptional({ example: '012345678' })
  @NormalisePhone()
  @Matches(/^\+\d{8,15}$/, { message: 'Contact phone number is invalid.' })
  @IsOptional()
  contactPhone?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  remarks?: string;
}

export class AddressDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: AddressLabel })
  label: AddressLabel;

  @ApiPropertyOptional({ nullable: true })
  title: string | null;

  @ApiProperty()
  addressLine: string;

  @ApiProperty({ example: 11.5564 })
  latitude: number;

  @ApiProperty({ example: 104.9282 })
  longitude: number;

  @ApiPropertyOptional({ nullable: true })
  placeId: string | null;

  @ApiProperty()
  contactName: string;

  @ApiProperty({ example: '+85512345678' })
  contactPhone: string;

  @ApiPropertyOptional({ nullable: true })
  remarks: string | null;

  @ApiProperty()
  isDefault: boolean;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;
}
