import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEvent } from '../../common/constants/events.js';
import { DeliveryExecutionService } from './delivery-execution.service.js';

interface LocationReported {
  driverId: string;
  deliveryId: string;
  latitude: number;
  longitude: number;
}

/**
 * Turns the driver's location stream into a status change.
 *
 * IN_TRANSIT is not a button in the driver app — it is what the platform
 * observes once the driver has actually left the pickup, which is harder to
 * misreport than a tap.
 */
@Injectable()
export class DeliveryExecutionListener {
  constructor(private readonly execution: DeliveryExecutionService) {}

  @OnEvent(DomainEvent.DRIVER_LOCATION_REPORTED)
  async onLocationReported(event: LocationReported): Promise<void> {
    await this.execution.markInTransitIfMoved(event.deliveryId, {
      latitude: event.latitude,
      longitude: event.longitude,
    });
  }
}
