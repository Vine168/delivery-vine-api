/**
 * Realtime (Socket.IO) event names. Clients subscribe to rooms; the server is
 * the only writer. Keep names dot-namespaced and stable.
 */
export const WsEvent = {
  // Server → driver
  DRIVER_REQUEST_RECEIVED: 'driver.request.received',
  DRIVER_REQUEST_EXPIRED: 'driver.request.expired',
  DRIVER_REQUEST_CANCELLED: 'driver.request.cancelled',
  DRIVER_AVAILABILITY_UPDATED: 'driver.availability.updated',

  // Server → customer & driver (delivery room)
  DELIVERY_DRIVER_ASSIGNED: 'delivery.driver_assigned',
  DELIVERY_STATUS_UPDATED: 'delivery.status.updated',
  DELIVERY_DRIVER_LOCATION_UPDATED: 'delivery.driver_location_updated',
  DELIVERY_ARRIVED_PICKUP: 'delivery.arrived_pickup',
  DELIVERY_PICKED_UP: 'delivery.picked_up',
  DELIVERY_ARRIVED_DROPOFF: 'delivery.arrived_dropoff',
  DELIVERY_COMPLETED: 'delivery.completed',
  DELIVERY_CANCELLED: 'delivery.cancelled',
  DELIVERY_PAYMENT_UPDATED: 'delivery.payment.updated',

  // Chat
  CHAT_MESSAGE_CREATED: 'chat.message.created',
  CHAT_MESSAGE_READ: 'chat.message.read',

  // Client → server
  CLIENT_SUBSCRIBE_DELIVERY: 'delivery.subscribe',
  CLIENT_UNSUBSCRIBE_DELIVERY: 'delivery.unsubscribe',
  CLIENT_DRIVER_LOCATION: 'driver.location.push',

  // Connection lifecycle
  CONNECTION_READY: 'connection.ready',
  CONNECTION_ERROR: 'connection.error',
} as const;

export const WsRoom = {
  user: (userId: string) => `user:${userId}`,
  driver: (driverId: string) => `driver:${driverId}`,
  delivery: (deliveryId: string) => `delivery:${deliveryId}`,
  conversation: (conversationId: string) => `conversation:${conversationId}`,
} as const;

/**
 * In-process domain events (@nestjs/event-emitter). Modules publish these
 * instead of importing each other, which keeps the dependency graph acyclic.
 */
export const DomainEvent = {
  DELIVERY_CONFIRMED: 'delivery.confirmed',
  DELIVERY_STATUS_CHANGED: 'delivery.status_changed',
  DELIVERY_ASSIGNED: 'delivery.assigned',
  DELIVERY_COMPLETED: 'delivery.completed',
  DELIVERY_CANCELLED: 'delivery.cancelled',
  DELIVERY_EXPIRED: 'delivery.expired',
  DRIVER_WENT_ONLINE: 'driver.went_online',
  DRIVER_WENT_OFFLINE: 'driver.went_offline',
  DRIVER_LOCATION_REPORTED: 'driver.location_reported',
  PAYMENT_STATUS_CHANGED: 'payment.status_changed',
  WITHDRAWAL_STATUS_CHANGED: 'withdrawal.status_changed',
  MESSAGE_CREATED: 'message.created',
} as const;
