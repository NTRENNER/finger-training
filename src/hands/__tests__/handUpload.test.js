import {
  BUCKET, checkFile, contentTypeFor, localPathFor, slug, uploadCode, uploadPath, uploadPhotos, userPrefix,
} from '../handUpload.js';

const photo = (name, type = '', size = 3_000_000) => ({ name, type, size });
const now = new Date('2026-10-29T14:00:00Z');

test('HEIC files with no browser type are recognised by extension', () => {
  expect(contentTypeFor(photo('IMG_1114.HEIC'))).toBe('image/heic');
  expect(contentTypeFor(photo('x.jpeg', 'image/jpeg'))).toBe('image/jpeg');
  expect(contentTypeFor(photo('notes.pdf', 'application/pdf'))).toBeNull();
});

test('screenshots and texted copies are refused as too small to be originals', () => {
  expect(checkFile(photo('a.jpg', 'image/jpeg', 120_000), 'together')).toMatch(/too small/);
  expect(checkFile(photo('a.jpg', 'image/jpeg', 40 * 1024 * 1024), 'together')).toMatch(/30 MB/);
  expect(checkFile(undefined, 'together')).toMatch(/Choose/);
  expect(checkFile(photo('IMG_1.HEIC'), 'together')).toBeNull();
});

test('the upload code must be present and plain', () => {
  expect(uploadCode('?c=abc123XYZ9')).toBe('abc123XYZ9');
  expect(uploadCode('?c=short')).toBeNull();
  expect(uploadCode('?c=../etc/passwd')).toBeNull();
  expect(uploadCode('')).toBeNull();
});

test('paths keep the code or user folder first, then date and name', () => {
  expect(slug('Sandy  Müller!')).toBe('sandy-muller');
  const path = uploadPath({ prefix: 'abc123XYZ9', name: 'Sandy Miller', kind: 'together', file: photo('IMG_1114.HEIC'), now });
  expect(path).toMatch(/^abc123XYZ9\/2026-10-29_sandy-miller\/together_[a-z0-9]+\.heic$/);
  expect(uploadPath({ prefix: userPrefix('uid-1'), name: 'Nathan', kind: 'apart', file: photo('a.jpg', 'image/jpeg'), now }))
    .toMatch(/^u\/uid-1\/2026-10-29_nathan\/apart_[a-z0-9]+\.jpg$/);
});

test('uploads both photos without overwriting, with an explicit content type', async () => {
  const upload = jest.fn().mockResolvedValue({ error: null });
  const client = { storage: { from: jest.fn(() => ({ upload })) } };
  const paths = await uploadPhotos(client, {
    prefix: 'abc123XYZ9', name: 'Sandy', now,
    together: photo('IMG_1.HEIC'), apart: photo('IMG_2.HEIC'),
  });
  expect(client.storage.from).toHaveBeenCalledWith(BUCKET);
  expect(paths).toHaveLength(2);
  expect(upload.mock.calls[0][2]).toMatchObject({ contentType: 'image/heic', upsert: false });
});

test('a refused code reads as an expired link, not a technical error', async () => {
  const upload = jest.fn().mockResolvedValue({ error: { message: 'new row violates row-level security policy' } });
  const client = { storage: { from: () => ({ upload }) } };
  await expect(uploadPhotos(client, {
    prefix: 'abc123XYZ9', name: 'Sandy', now,
    together: photo('IMG_1.HEIC'), apart: photo('IMG_2.HEIC'),
  })).rejects.toThrow('no longer valid');
});

test('downloads keep date, name and photo, without the code or account id', () => {
  expect(localPathFor('abc123XYZ9/2026-10-29_sandy-miller/together_mh1.heic')).toBe('2026-10-29_sandy-miller/together_mh1.heic');
  expect(localPathFor('u/uid-1/2026-10-29_nathan/apart_mh1.jpg')).toBe('2026-10-29_nathan/apart_mh1.jpg');
  expect(localPathFor('abc123XYZ9/_selftest/check.jpg')).toBeNull();
  expect(localPathFor('abc123XYZ9/../../etc/passwd')).toBeNull();
});
