import { describe, expect, it } from 'vitest';
import { detectFileType } from './file-signature.util.js';

const bytes = (...values: number[]) => Buffer.from(values);
const pad = (buffer: Buffer, length = 64) => Buffer.concat([buffer, Buffer.alloc(Math.max(0, length - buffer.length))]);

describe('detectFileType', () => {
  it('identifies the formats we accept', () => {
    expect(detectFileType(pad(bytes(0xff, 0xd8, 0xff, 0xe0)))?.mimeType).toBe('image/jpeg');
    expect(detectFileType(pad(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)))?.mimeType).toBe('image/png');
    expect(detectFileType(pad(Buffer.concat([Buffer.from('RIFF'), bytes(1, 2, 3, 4), Buffer.from('WEBP')])))?.mimeType).toBe(
      'image/webp',
    );
    expect(detectFileType(pad(Buffer.from('%PDF-1.7')))?.mimeType).toBe('application/pdf');
  });

  it('returns the right extension for the storage key', () => {
    expect(detectFileType(pad(bytes(0xff, 0xd8, 0xff)))?.extension).toBe('jpg');
    expect(detectFileType(pad(Buffer.from('%PDF-')))?.extension).toBe('pdf');
  });

  it('accepts HEIC from iPhones', () => {
    const heic = Buffer.concat([bytes(0, 0, 0, 0x20), Buffer.from('ftypheic'), Buffer.alloc(32)]);
    expect(detectFileType(heic)?.mimeType).toBe('image/heic');
  });

  it('rejects an MP4, which shares the HEIC container header', () => {
    const mp4 = Buffer.concat([bytes(0, 0, 0, 0x20), Buffer.from('ftypisom'), Buffer.alloc(32)]);
    expect(detectFileType(mp4)).toBeNull();
  });

  it('rejects a script no matter what it is called', () => {
    expect(detectFileType(pad(Buffer.from('<?php system($_GET["c"]); ?>')))).toBeNull();
    expect(detectFileType(pad(Buffer.from('#!/bin/sh\nrm -rf /')))).toBeNull();
    expect(detectFileType(pad(Buffer.from('GIF89a')))).toBeNull(); // real GIF, still not on the list
  });

  it('rejects an empty or truncated file', () => {
    expect(detectFileType(Buffer.alloc(0))).toBeNull();
    expect(detectFileType(bytes(0xff))).toBeNull();
    expect(detectFileType(bytes(0x89, 0x50))).toBeNull();
  });

  it('is not fooled by a valid signature that appears later in the file', () => {
    const smuggled = Buffer.concat([Buffer.from('<?php ?>'), bytes(0xff, 0xd8, 0xff)]);
    expect(detectFileType(smuggled)).toBeNull();
  });
});
