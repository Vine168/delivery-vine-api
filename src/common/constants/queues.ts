export const QUEUE = {
  DELIVERY_MATCHING: 'delivery-matching',
  DELIVERY_TIMEOUT: 'delivery-timeout',
  NOTIFICATION: 'notification',
  PAYMENT: 'payment',
  MAINTENANCE: 'maintenance',
} as const;

export const JOB = {
  // delivery-matching
  DISPATCH_ROUND: 'dispatch-round',
  // delivery-timeout
  EXPIRE_OFFER: 'expire-offer',
  EXPIRE_SEARCH: 'expire-search',
  // notification
  SEND_PUSH: 'send-push',
  SEND_CAMPAIGN: 'send-campaign',
  SEND_SMS: 'send-sms',
  // payment
  POLL_PAYMENT_STATUS: 'poll-payment-status',
  EXPIRE_PAYMENT: 'expire-payment',
  // maintenance
  RECONCILE_EARNINGS: 'reconcile-earnings',
  PRUNE_TRACK_POINTS: 'prune-track-points',
  PRUNE_IDEMPOTENCY_KEYS: 'prune-idempotency-keys',
  PRUNE_OTP_RECORDS: 'prune-otp-records',
  PRUNE_AUTH_RECORDS: 'prune-auth-records',
  PRUNE_ORPHANED_FILES: 'prune-orphaned-files',
} as const;
