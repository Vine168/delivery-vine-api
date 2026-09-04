/**
 * Every permission the back office recognises.
 *
 * One entry per real capability, named for what an operator does rather than
 * for the table it touches. The dashboard's inherited list had 113 codes with
 * overlapping meanings (`admins.*` beside `users.*`, `cod.*` beside
 * `finance.*`); this is the curated replacement, and it is the only source of
 * truth — the seeder writes it to the database and every endpoint names one of
 * these codes.
 *
 * Adding a screen means adding a permission here, not editing an enum.
 */
export interface PermissionDefinition {
  code: string;
  module: string;
  action: string;
  description: string;
}

export const PERMISSION_CATALOGUE: PermissionDefinition[] = [
  // ── Access ──
  { code: 'admin.access', module: 'Admin', action: 'Access', description: 'Sign in to the back office' },

  // ── Dashboard ──
  { code: 'dashboard.view', module: 'Dashboard', action: 'View', description: 'View the operations dashboard' },

  // ── Deliveries ──
  { code: 'deliveries.view', module: 'Deliveries', action: 'View', description: 'View deliveries and their timelines' },
  { code: 'deliveries.cancel', module: 'Deliveries', action: 'Cancel', description: 'Cancel a delivery on a customer’s behalf' },
  { code: 'deliveries.reassign', module: 'Deliveries', action: 'Assign', description: 'Return a delivery to matching or assign a driver' },
  { code: 'deliveries.export', module: 'Deliveries', action: 'Export', description: 'Export delivery records' },

  // ── Customers ──
  { code: 'customers.view', module: 'Customers', action: 'View', description: 'View customer accounts' },
  { code: 'customers.suspend', module: 'Customers', action: 'Suspend', description: 'Suspend or reinstate a customer' },
  { code: 'customers.export', module: 'Customers', action: 'Export', description: 'Export customer records' },

  // ── Drivers ──
  { code: 'drivers.view', module: 'Drivers', action: 'View', description: 'View driver accounts and documents' },
  { code: 'drivers.approve', module: 'Drivers', action: 'Approve', description: 'Approve or reject a driver application' },
  { code: 'drivers.suspend', module: 'Drivers', action: 'Suspend', description: 'Suspend or reinstate a driver' },
  { code: 'drivers.edit', module: 'Drivers', action: 'Edit', description: 'Review documents, vehicles and zone assignments' },
  { code: 'drivers.export', module: 'Drivers', action: 'Export', description: 'Export driver records' },

  // ── Finance ──
  { code: 'finance.view', module: 'Finance', action: 'View', description: 'View revenue, earnings and payouts' },
  { code: 'finance.withdrawals.review', module: 'Finance', action: 'Approve', description: 'Approve or reject a withdrawal request' },
  { code: 'finance.withdrawals.settle', module: 'Finance', action: 'Settle', description: 'Record a payout as sent, failed or completed' },
  {
    code: 'finance.remittance',
    module: 'Finance',
    action: 'Record cash',
    description: 'Record cash handed in by a driver against what they owe',
  },
  {
    code: 'finance.refund',
    module: 'Finance',
    action: 'Refund',
    description: 'Refund a customer and record that the money went back',
  },
  { code: 'finance.adjust', module: 'Finance', action: 'Adjust', description: 'Credit or debit a driver wallet manually' },
  { code: 'finance.export', module: 'Finance', action: 'Export', description: 'Export financial records' },

  // ── Pricing ──
  { code: 'pricing.view', module: 'Pricing', action: 'View', description: 'View pricing rules and vehicle types' },
  { code: 'pricing.manage', module: 'Pricing', action: 'Manage', description: 'Create and change pricing rules' },

  // ── Promotions ──
  { code: 'promoCodes.view', module: 'Promotions', action: 'View', description: 'View promo codes and their usage' },
  { code: 'promoCodes.manage', module: 'Promotions', action: 'Manage', description: 'Create, change and retire promo codes' },

  // ── Zones ──
  { code: 'zones.view', module: 'Zones', action: 'View', description: 'View service zones' },
  { code: 'zones.manage', module: 'Zones', action: 'Manage', description: 'Create and change service zones' },

  // ── Communications ──
  { code: 'notifications.view', module: 'Communications', action: 'View', description: 'View sent notifications' },
  { code: 'notifications.send', module: 'Communications', action: 'Send', description: 'Send notifications to customers or drivers' },

  // ── Access control ──
  { code: 'roles.view', module: 'Roles', action: 'View', description: 'View roles and their permissions' },
  { code: 'roles.manage', module: 'Roles', action: 'Manage', description: 'Create roles and change what they can do' },
  { code: 'admins.view', module: 'Administrators', action: 'View', description: 'View back-office accounts' },
  { code: 'admins.manage', module: 'Administrators', action: 'Manage', description: 'Create back-office accounts and assign roles' },

  // ── Platform ──
  { code: 'settings.view', module: 'Settings', action: 'View', description: 'View platform settings' },
  { code: 'settings.manage', module: 'Settings', action: 'Manage', description: 'Change platform settings' },
  { code: 'audit.view', module: 'Audit', action: 'View', description: 'View the audit trail' },
];

/** Compile-time constants so an endpoint cannot name a permission that does not exist. */
export const Permissions = Object.fromEntries(
  PERMISSION_CATALOGUE.map((permission) => [
    permission.code.replaceAll('.', '_').toUpperCase(),
    permission.code,
  ]),
) as Record<string, string>;

/**
 * Roles created on a fresh install.
 *
 * Super Admin is deliberately not listed: it is a flag on the account rather
 * than a bundle of permissions, so it cannot be accidentally narrowed by
 * editing a role.
 */
export const SYSTEM_ROLES: { name: string; slug: string; description: string; permissions: string[] }[] = [
  {
    name: 'Operations',
    slug: 'operations',
    description: 'Runs deliveries day to day: dispatch, drivers and customers.',
    permissions: [
      'admin.access',
      'dashboard.view',
      'deliveries.view',
      'deliveries.cancel',
      'deliveries.reassign',
      'customers.view',
      'customers.suspend',
      'drivers.view',
      'drivers.approve',
      'drivers.suspend',
      'drivers.edit',
      'zones.view',
      'notifications.view',
      'notifications.send',
    ],
  },
  {
    name: 'Finance',
    slug: 'finance',
    description: 'Handles payouts, earnings and pricing.',
    permissions: [
      'admin.access',
      'dashboard.view',
      'deliveries.view',
      'deliveries.export',
      'finance.view',
      'finance.withdrawals.review',
      'finance.withdrawals.settle',
      'finance.remittance',
      'finance.refund',
      'finance.export',
      'pricing.view',
      'pricing.manage',
      'promoCodes.view',
      'promoCodes.manage',
      'drivers.view',
    ],
  },
  {
    name: 'Support',
    slug: 'support',
    description: 'Reads everything and answers customers; changes nothing.',
    permissions: [
      'admin.access',
      'dashboard.view',
      'deliveries.view',
      'customers.view',
      'drivers.view',
      'promoCodes.view',
      'zones.view',
      'notifications.view',
    ],
  },
];

/** Lookup by code, for validating what a role is asked to grant. */
export const PERMISSIONS_BY_CODE = new Map(
  PERMISSION_CATALOGUE.map((permission) => [permission.code, permission]),
);
