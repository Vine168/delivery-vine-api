import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  userId?: string;
  role?: string;
  customerId?: string;
  driverId?: string;
  ip?: string;
  userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Ambient per-request metadata for logs and audit trails, without threading a
 * context object through every service signature. Uses Node's own
 * AsyncLocalStorage — no third-party CLS package required.
 */
export const RequestContextStore = {
  run<T>(context: RequestContext, callback: () => T): T {
    return storage.run(context, callback);
  },

  get(): RequestContext | undefined {
    return storage.getStore();
  },

  requestId(): string | undefined {
    return storage.getStore()?.requestId;
  },

  /** Mutates the active context — used by the auth guard once the user is known. */
  set(patch: Partial<RequestContext>): void {
    const current = storage.getStore();
    if (current) Object.assign(current, patch);
  },
};
