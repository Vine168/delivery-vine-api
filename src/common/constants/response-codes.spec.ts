import { describe, expect, it } from 'vitest';
import { ResponseCode, humaniseCode, messageForCode, successMessageForCode } from './response-codes.js';

describe('response codes', () => {
  it('reads naturally for a success without an explicit message', () => {
    expect(successMessageForCode(ResponseCode.DELIVERY_CREATED)).toBe('Delivery created successfully.');
    expect(successMessageForCode(ResponseCode.ADDRESSES_FETCHED)).toBe('Addresses fetched successfully.');
  });

  it('never says "successfully" in a failure message', () => {
    expect(messageForCode(ResponseCode.ADDRESS_NOT_FOUND)).toBe('Address not found.');
    expect(messageForCode(ResponseCode.PROMO_EXPIRED)).toBe('Promo expired.');

    for (const code of Object.values(ResponseCode)) {
      expect(messageForCode(code)).not.toMatch(/not found successfully|expired successfully/i);
    }
  });

  it('prefers the curated message over the humanised one', () => {
    expect(messageForCode(ResponseCode.DELIVERY_ALREADY_ASSIGNED)).toBe(
      'This delivery has already been assigned to another driver.',
    );
    expect(successMessageForCode(ResponseCode.DELIVERY_ALREADY_ASSIGNED)).toBe(
      messageForCode(ResponseCode.DELIVERY_ALREADY_ASSIGNED),
    );
  });

  it('humanises without trailing punctuation', () => {
    expect(humaniseCode('DRIVER_DOCUMENT_UPLOADED')).toBe('Driver document uploaded');
  });

  it('gives every code a non-empty message ending in a full stop', () => {
    for (const code of Object.values(ResponseCode)) {
      const message = messageForCode(code);
      expect(message.length).toBeGreaterThan(3);
      expect(message.endsWith('.')).toBe(true);
    }
  });
});
