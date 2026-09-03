import { Injectable } from '@nestjs/common';
import { LIMITS } from '../../common/constants/app.constants.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AddressDto, CreateAddressDto, UpdateAddressDto } from './dto/address.dto.js';

const addressSelect = {
  id: true,
  label: true,
  title: true,
  addressLine: true,
  latitude: true,
  longitude: true,
  placeId: true,
  contactName: true,
  contactPhone: true,
  remarks: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Exactly the shape `addressSelect` returns — kept in sync by the compiler. */
type AddressRow = Prisma.CustomerAddressGetPayload<{ select: typeof addressSelect }>;

@Injectable()
export class AddressesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(customerId: string): Promise<AddressDto[]> {
    const rows = await this.prisma.customerAddress.findMany({
      where: { customerId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
      select: addressSelect,
    });

    return rows.map((row) => this.toDto(row));
  }

  async findOne(customerId: string, id: string): Promise<AddressDto> {
    return this.toDto(await this.findOwnedOrThrow(customerId, id));
  }

  async create(customerId: string, dto: CreateAddressDto): Promise<AddressDto> {
    const existing = await this.prisma.customerAddress.count({ where: { customerId, deletedAt: null } });

    if (existing >= LIMITS.MAX_CUSTOMER_ADDRESSES) {
      throw AppException.unprocessable(
        ResponseCode.ADDRESS_LIMIT_REACHED,
        `You can save up to ${LIMITS.MAX_CUSTOMER_ADDRESSES} addresses.`,
      );
    }

    // The first address a customer saves is their default, whatever they asked for.
    const shouldBeDefault = dto.isDefault === true || existing === 0;

    const created = await this.prisma.$transaction(async (tx) => {
      if (shouldBeDefault) {
        await tx.customerAddress.updateMany({
          where: { customerId, isDefault: true, deletedAt: null },
          data: { isDefault: false },
        });
      }

      return tx.customerAddress.create({
        data: {
          customerId,
          label: dto.label,
          title: dto.title,
          addressLine: dto.addressLine,
          latitude: dto.latitude,
          longitude: dto.longitude,
          placeId: dto.placeId,
          contactName: dto.contactName,
          contactPhone: dto.contactPhone,
          remarks: dto.remarks,
          isDefault: shouldBeDefault,
        },
        select: addressSelect,
      });
    });

    return this.toDto(created);
  }

  async update(customerId: string, id: string, dto: UpdateAddressDto): Promise<AddressDto> {
    await this.findOwnedOrThrow(customerId, id);

    const updated = await this.prisma.customerAddress.update({
      where: { id },
      data: { ...dto },
      select: addressSelect,
    });

    return this.toDto(updated);
  }

  /**
   * Moves the default in one transaction. A partial unique index guarantees at
   * most one default per customer even if two requests race.
   */
  async setDefault(customerId: string, id: string): Promise<AddressDto> {
    await this.findOwnedOrThrow(customerId, id);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.customerAddress.updateMany({
        where: { customerId, isDefault: true, deletedAt: null, NOT: { id } },
        data: { isDefault: false },
      });

      return tx.customerAddress.update({
        where: { id },
        data: { isDefault: true },
        select: addressSelect,
      });
    });

    return this.toDto(updated);
  }

  /**
   * Soft delete — past deliveries snapshot their addresses, but keeping the row
   * means an address the customer is still looking at never vanishes mid-flow.
   */
  async remove(customerId: string, id: string): Promise<void> {
    const address = await this.findOwnedOrThrow(customerId, id);

    await this.prisma.$transaction(async (tx) => {
      await tx.customerAddress.update({
        where: { id },
        data: { deletedAt: new Date(), isDefault: false },
      });

      if (address.isDefault) {
        // Promote the most recently used remaining address.
        const next = await tx.customerAddress.findFirst({
          where: { customerId, deletedAt: null },
          orderBy: { updatedAt: 'desc' },
          select: { id: true },
        });

        if (next) {
          await tx.customerAddress.update({ where: { id: next.id }, data: { isDefault: true } });
        }
      }
    });
  }

  private async findOwnedOrThrow(customerId: string, id: string): Promise<AddressRow> {
    const address = await this.prisma.customerAddress.findFirst({
      where: { id, customerId, deletedAt: null },
      select: addressSelect,
    });

    if (!address) {
      throw AppException.notFound(ResponseCode.ADDRESS_NOT_FOUND);
    }

    return address;
  }

  private toDto(row: AddressRow): AddressDto {
    return {
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
