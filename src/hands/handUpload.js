// Helpers for the public hand-photo upload page (hands/index.html).
// People send the original photos for HO device sizing here instead of by
// text or chat, which shrink them and strip the camera data the measuring
// script needs. Files are stored untouched in a private Storage bucket; the
// public can upload only with a valid code from the link (folder = code);
// signed-in app users upload into u/<their id>/. Nobody can list, read or
// delete anything through the app.

export const BUCKET = 'hand-photos';
export const MAX_BYTES = 30 * 1024 * 1024;

const TYPES = {
  heic: 'image/heic', heif: 'image/heif',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
};
const EXT_FOR = { 'image/heic': 'heic', 'image/heif': 'heif', 'image/jpeg': 'jpg', 'image/png': 'png' };

function extension(name = '') {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

// Browsers often report HEIC files with an empty type, so fall back to the
// file name. Storage rejects anything outside the bucket's allowed types.
export function contentTypeFor(file) {
  if (file?.type && EXT_FOR[file.type]) return file.type;
  return TYPES[extension(file?.name)] || null;
}

export function checkFile(file, label) {
  if (!file) return `Choose the ${label} photo.`;
  if (!contentTypeFor(file)) return `The ${label} photo isn't a photo file (use the original from your camera).`;
  if (file.size > MAX_BYTES) return `The ${label} photo is larger than 30 MB.`;
  if (file.size < 300 * 1024) return `The ${label} photo is too small to be an original. Send the original file, not a screenshot or a texted copy.`;
  return null;
}

export function slug(text = '') {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Folder for a signed-in user: the storage policy only accepts u/<auth uid>.
export const userPrefix = userId => `u/${userId}`;

export function uploadCode(search = '') {
  const code = new URLSearchParams(search).get('c') || '';
  return /^[A-Za-z0-9]{8,40}$/.test(code) ? code : null;
}

export function uploadPath({ prefix, name, kind, file, now }) {
  const day = now.toISOString().slice(0, 10);
  const stamp = now.getTime().toString(36);
  const ext = EXT_FOR[contentTypeFor(file)] || 'jpg';
  return `${prefix}/${day}_${slug(name) || 'unnamed'}/${kind}_${stamp}.${ext}`;
}

// Uploads both photos; never overwrites (upsert false). Resolves the stored
// paths, or rejects with a message fit to show the person.
export async function uploadPhotos(client, { prefix, name, together, apart, now = new Date() }) {
  const paths = [];
  for (const [kind, file] of [['together', together], ['apart', apart]]) {
    const path = uploadPath({ prefix, name, kind, file, now });
    const { error } = await client.storage.from(BUCKET).upload(path, file, {
      contentType: contentTypeFor(file), upsert: false, cacheControl: '3600',
    });
    if (error) {
      const denied = /row-level security|unauthorized|403/i.test(error.message || '');
      throw new Error(denied
        ? 'This upload link is no longer valid. Ask for a new link.'
        : `The ${kind} photo didn't upload (${error.message}). Check your connection and try again.`);
    }
    paths.push(path);
  }
  return paths;
}

// Where a stored photo goes on disk when downloaded: drop the link code or
// u/<user id> prefix and keep "<date>_<name>/<kind>_<stamp>.<ext>". Returns
// null for anything that isn't an upload from the form.
export function localPathFor(objectPath) {
  const parts = objectPath.split('/');
  const rest = parts[0] === 'u' ? parts.slice(2) : parts.slice(1);
  if (rest.length !== 2 || !/^\d{4}-\d{2}-\d{2}_/.test(rest[0]) || !/^(together|apart)_/.test(rest[1])) return null;
  return rest.join('/');
}
