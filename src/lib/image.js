/**
 * Re-encoding an image so its bytes differ while it looks the same.
 *
 * Vinted refuses the photo upload with a bare "error_uploading_photo" even
 * though the request matches the site's own in every respect we can compare.
 * One explanation that fits: it recognises the file as an image it already
 * hosts. Re-encoding rewrites every byte (and drops EXIF), so if that is the
 * reason, the copy goes through — and if it does not, the theory is dead.
 */

/**
 * What to encode to. JPEG is what a phone camera produces and what Vinted's
 * own uploader normally receives; PNG is kept for images that may rely on
 * transparency.
 */
export function chooseOutputType(inputType) {
  const type = String(inputType || '').toLowerCase();
  if (type === 'image/png') return { type: 'image/png', extension: 'png' };
  return { type: 'image/jpeg', extension: 'jpg', quality: 0.92 };
}

/** Swap the extension of a filename to match a re-encoded type. */
export function renameForType(filename, extension) {
  return `${String(filename || 'photo').replace(/\.[^.]*$/, '')}.${extension}`;
}

/**
 * Decode and re-encode, keeping the original pixel dimensions.
 * Browser only — needs createImageBitmap and OffscreenCanvas.
 */
export async function reencodeImage(blob) {
  const output = chooseOutputType(blob?.type);
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Kon geen canvas-context maken om de foto te hercoderen.');
    context.drawImage(bitmap, 0, 0);
    const encoded = await canvas.convertToBlob({ type: output.type, quality: output.quality });
    if (!encoded?.size) throw new Error('Hercoderen leverde een leeg bestand op.');
    return { blob: encoded, extension: output.extension };
  } finally {
    bitmap.close?.();
  }
}
