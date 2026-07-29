/** Shared image helpers (server). */

export const MAX_IMAGES = 4;
// ~5 MB binary ≈ ~7 MB base64 per image
export const MAX_DATAURL_LENGTH = 7_500_000;

/** Validate a client-supplied image data URL. Returns an error string or null. */
export function validateImageDataUrl(url) {
  if (typeof url !== 'string') return 'Image must be a data URL string';
  if (!/^data:image\/(png|jpe?g|gif|webp);base64,/.test(url))
    return 'Only PNG/JPEG/GIF/WebP data URLs are supported';
  if (url.length > MAX_DATAURL_LENGTH) return 'Image is too large (max ~5 MB each)';
  return null;
}

/** "data:image/png;base64,AAAA..." -> { mimeType: "image/png", base64: "AAAA..." } */
export function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('Invalid image data URL');
  return { mimeType: match[1], base64: match[2] };
}
