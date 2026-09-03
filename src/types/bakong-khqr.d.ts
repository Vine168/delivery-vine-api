/**
 * The KHQR SDK ships no types. Declared here rather than pulled from
 * DefinitelyTyped (which lags the package) — only the surface we actually use,
 * so a drift in the library shows up as a type error rather than an `any`.
 */
declare module 'bakong-khqr' {
  export const khqrData: {
    currency: { usd: number; khr: number };
    merchantType: { individual: string; merchant: string };
  };

  export interface IndividualInfoOptions {
    currency?: number;
    amount?: number;
    billNumber?: string;
    storeLabel?: string;
    terminalLabel?: string;
    mobileNumber?: string;
    purposeOfTransaction?: string;
    languagePreference?: string;
    merchantNameAlternateLanguage?: string;
    merchantCityAlternateLanguage?: string;
    upiMerchantAccount?: string;
    /** Milliseconds since the epoch. Required for a dynamic (amount-bearing) QR. */
    expirationTimestamp?: number;
  }

  export class IndividualInfo {
    constructor(
      bakongAccountID: string,
      merchantName: string,
      merchantCity: string,
      options?: IndividualInfoOptions,
    );
  }

  export class MerchantInfo {
    constructor(
      bakongAccountID: string,
      merchantName: string,
      merchantCity: string,
      merchantID: string,
      acquiringBank: string,
      options?: IndividualInfoOptions,
    );
  }

  export interface KHQRResponse {
    status: { code: number; errorCode: number | null; message: string | null };
    data?: { qr: string; md5: string };
  }

  export class BakongKHQR {
    constructor(token?: string);
    generateIndividual(info: IndividualInfo): KHQRResponse;
    generateMerchant(info: MerchantInfo): KHQRResponse;
  }
}
