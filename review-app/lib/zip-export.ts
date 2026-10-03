import { trajectoryIdentity, reviewVersion } from './trajectory-list.ts';
import type { Review } from './review-types.ts';

// A standard uncompressed ZIP, supported in both the Node and Worker runtimes.
// Artifact bundles are text; keeping the writer dependency-free avoids changing
// the app's runtime or package setup for bulk downloads.
export function zipFiles(files: Record<string, string>): ArrayBuffer {
  const encoder = new TextEncoder();
  const entries = Object.entries(files).map(([path, text]) => {
    if (
      path.includes('\\') ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error('Invalid ZIP path.');
    }
    const name = encoder.encode(path);
    const data = encoder.encode(text);
    if (name.length > 65535 || data.length > 0xffffffff)
      throw new Error('ZIP entry is too large.');
    return { name, data };
  });
  const localSize = entries.reduce(
    (size, { name, data }) => size + 30 + name.length + data.length,
    0,
  );
  const centralSize = entries.reduce(
    (size, { name }) => size + 46 + name.length,
    0,
  );
  if (entries.length > 65535 || localSize + centralSize + 22 > 0xffffffff)
    throw new Error('ZIP is too large.');
  const bytes = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(bytes.buffer);
  const crcTable = Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  let local = 0;
  let central = localSize;
  for (const { name, data } of entries) {
    let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    view.setUint32(local, 0x04034b50, true);
    view.setUint16(local + 4, 20, true);
    view.setUint16(local + 6, 0x0800, true);
    view.setUint16(local + 12, 33, true); // January 1, 1980.
    view.setUint32(local + 14, crc, true);
    view.setUint32(local + 18, data.length, true);
    view.setUint32(local + 22, data.length, true);
    view.setUint16(local + 26, name.length, true);
    bytes.set(name, local + 30);
    bytes.set(data, local + 30 + name.length);
    view.setUint32(central, 0x02014b50, true);
    view.setUint16(central + 4, 20, true);
    view.setUint16(central + 6, 20, true);
    view.setUint16(central + 8, 0x0800, true);
    view.setUint16(central + 14, 33, true);
    view.setUint32(central + 16, crc, true);
    view.setUint32(central + 20, data.length, true);
    view.setUint32(central + 24, data.length, true);
    view.setUint16(central + 28, name.length, true);
    view.setUint32(central + 42, local, true);
    bytes.set(name, central + 46);
    local += 30 + name.length + data.length;
    central += 46 + name.length;
  }
  view.setUint32(central, 0x06054b50, true);
  view.setUint16(central + 8, entries.length, true);
  view.setUint16(central + 10, entries.length, true);
  view.setUint32(central + 12, centralSize, true);
  view.setUint32(central + 16, localSize, true);
  return bytes.buffer;
}

type Collection = {
  format: string;
  exportedAt: string;
  reviewCount: number;
  reviews: Array<{
    reviewId: string;
    sourcePath: string;
    privacyStatus: Review['privacyStatus'];
    files: Record<string, string>;
  }>;
};

export function collectionZip(collection: Collection): ArrayBuffer {
  const files: Record<string, string> = {};
  const safe = (value: string) =>
    value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  const manifest = collection.reviews.map(
    ({ files: artifacts, ...review }, index) => {
      const identity = trajectoryIdentity(review.sourcePath, review.reviewId);
      const directory = `${safe(identity.run)}/${identity.number ? `trajectory-${identity.number}` : 'review'}/${reviewVersion(review).toLowerCase()}-${index + 1}-${safe(review.reviewId)}`;
      for (const [name, content] of Object.entries(artifacts))
        files[`${directory}/${name}`] = content;
      return { ...review, directory, files: Object.keys(artifacts) };
    },
  );
  files['manifest.json'] =
    JSON.stringify({ ...collection, reviews: manifest }, null, 2) + '\n';
  return zipFiles(files);
}
