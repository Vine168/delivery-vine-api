/**
 * MIME detection by content, not by the client's say-so.
 *
 * A mobile app can label a PHP script `image/jpeg`; the browser and the
 * filename extension are equally unreliable. We read the first bytes and only
 * accept a file whose actual signature is on the allow-list.
 */
interface Signature {
  mimeType: string;
  extension: string;
  /** Byte pattern at `offset`; `null` matches any byte (wildcards). */
  bytes: (number | null)[];
  offset?: number;
}

const SIGNATURES: Signature[] = [
  { mimeType: 'image/jpeg', extension: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/png', extension: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // RIFF....WEBP
  {
    mimeType: 'image/webp',
    extension: 'webp',
    bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
  },
  // ....ftypheic / ftypheix / ftypmif1 (HEIC from iPhones)
  {
    mimeType: 'image/heic',
    extension: 'heic',
    bytes: [null, null, null, null, 0x66, 0x74, 0x79, 0x70],
  },
  { mimeType: 'application/pdf', extension: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
];

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);

export interface DetectedFileType {
  mimeType: string;
  extension: string;
}

function matches(buffer: Buffer, signature: Signature): boolean {
  const offset = signature.offset ?? 0;
  if (buffer.length < offset + signature.bytes.length) return false;

  return signature.bytes.every((byte, index) => byte === null || buffer[offset + index] === byte);
}

/** Returns the real type of the buffer, or null when it is not one we accept. */
export function detectFileType(buffer: Buffer): DetectedFileType | null {
  for (const signature of SIGNATURES) {
    if (!matches(buffer, signature)) continue;

    // An ISO-BMFF container is only HEIC if its brand says so — the same
    // header prefixes MP4 video, which we do not accept as a document.
    if (signature.mimeType === 'image/heic') {
      const brand = buffer.subarray(8, 12).toString('ascii');
      if (!HEIC_BRANDS.has(brand)) continue;
    }

    return { mimeType: signature.mimeType, extension: signature.extension };
  }

  return null;
}
