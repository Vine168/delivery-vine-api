import type { Prisma } from '../../generated/prisma/client.js';

/**
 * The exact columns each delivery query reads.
 *
 * Declared once so list endpoints stay narrow (no route polylines or pricing
 * snapshots in a history page) and so the mapper's input type is derived from
 * the query rather than hand-written.
 */
export const deliveryDetailSelect = {
  id: true,
  bookingCode: true,
  status: true,
  customerId: true,
  driverId: true,
  pickupAddress: true,
  pickupLatitude: true,
  pickupLongitude: true,
  pickupPlaceId: true,
  pickupContactName: true,
  pickupContactPhone: true,
  pickupNote: true,
  dropoffAddress: true,
  dropoffLatitude: true,
  dropoffLongitude: true,
  dropoffPlaceId: true,
  dropoffContactName: true,
  dropoffContactPhone: true,
  dropoffNote: true,
  distanceMeters: true,
  durationSeconds: true,
  routePolyline: true,
  currency: true,
  baseFare: true,
  distanceFare: true,
  timeFare: true,
  waitingFee: true,
  surgeAmount: true,
  serviceFee: true,
  codFee: true,
  subtotalAmount: true,
  discountAmount: true,
  totalAmount: true,
  pricingSnapshot: true,
  paymentMethod: true,
  paymentStatus: true,
  codEnabled: true,
  codAmount: true,
  codPayer: true,
  customerNote: true,
  cancelledByType: true,
  cancelReason: true,
  createdAt: true,
  confirmedAt: true,
  assignedAt: true,
  pickedUpAt: true,
  deliveredAt: true,
  cancelledAt: true,
  vehicleType: { select: { code: true, name: true } },
  driverVehicle: { select: { plateNumber: true, vehicleType: { select: { name: true } } } },
  driver: {
    select: {
      id: true,
      fullName: true,
      avatarFileId: true,
      ratingAverage: true,
      completedDeliveries: true,
      user: { select: { phone: true } },
    },
  },
  packages: {
    select: {
      id: true,
      size: true,
      quantity: true,
      weightKg: true,
      category: true,
      description: true,
      remarks: true,
      declaredValueAmount: true,
      declaredValueCurrency: true,
      photoFileId: true,
    },
  },
  rating: { select: { id: true } },
  statusHistory: {
    orderBy: { createdAt: 'asc' },
    select: { toStatus: true, actorType: true, reason: true, createdAt: true },
  },
} satisfies Prisma.DeliverySelect;

export const deliveryListSelect = {
  id: true,
  bookingCode: true,
  status: true,
  pickupAddress: true,
  dropoffAddress: true,
  totalAmount: true,
  currency: true,
  paymentMethod: true,
  paymentStatus: true,
  distanceMeters: true,
  createdAt: true,
  deliveredAt: true,
  vehicleType: { select: { code: true } },
  driver: { select: { fullName: true } },
} satisfies Prisma.DeliverySelect;

export type DeliveryDetail = Prisma.DeliveryGetPayload<{ select: typeof deliveryDetailSelect }>;
export type DeliveryListRow = Prisma.DeliveryGetPayload<{ select: typeof deliveryListSelect }>;
