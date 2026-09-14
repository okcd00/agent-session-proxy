import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const UPLOAD_DIRNAME = 'uploads';
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_UPLOADS_PER_MESSAGE = 8;

const IMAGE_SIGNATURES = [
  { mime: 'image/png', match: (b) => b.length > 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', match: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', match: (b) => b.length > 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  { mime: 'image/webp', match: (b) => b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 },
  { mime: 'image/bmp', match: (b) => b.length > 2 && b[0] === 0x42 && b[1] === 0x4d },
];

export function uploadsDir(cwd) {
  return path.join(cwd, UPLOAD_DIRNAME);
}

/**
 * The browser supplies this name, so it can carry path separators, `..`, or
 * control characters. Reduce it to a bare filename.
 */
export function sanitizeFilename(name) {
  let base = String(name ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  base = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\.+/, '').trim();
  if (!base) base = 'upload';
  if (base.length > 120) {
    const ext = path.extname(base);
    base = `${base.slice(0, Math.max(1, 120 - ext.length))}${ext}`;
  }
  return base;
}

/** Prefer the real bytes over a client-declared mime type. */
export function detectImageMime(buffer) {
  for (const entry of IMAGE_SIGNATURES) {
    if (entry.match(buffer)) return entry.mime;
  }
  return null;
}

async function uniqueTarget(dir, filename) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  for (let n = 1; n < 1000; n += 1) {
    if (!(await exists(candidate))) return candidate;
    candidate = path.join(dir, `${stem}-${n}${ext}`);
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

function exists(target) {
  return stat(target).then(() => true, () => false);
}

/**
 * Write one uploaded file under `<cwd>/uploads/` and report where it landed.
 * The agent works in `cwd`, so a path there is directly usable by its tools.
 */
export async function storeUpload(cwd, { name, mime, dataBase64 }) {
  if (typeof dataBase64 !== 'string' || !dataBase64) {
    throw Object.assign(new Error('upload is missing base64 data'), { status: 400 });
  }
  // Strip a data: URL prefix if the browser sent one.
  const payload = dataBase64.replace(/^data:[^;]*;base64,/, '');
  const buffer = Buffer.from(payload, 'base64');
  if (!buffer.length) {
    throw Object.assign(new Error('upload decoded to zero bytes'), { status: 400 });
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(
      new Error(`file exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit`),
      { status: 413 },
    );
  }

  const dir = uploadsDir(cwd);
  await mkdir(dir, { recursive: true });

  const filename = sanitizeFilename(name);
  const target = await uniqueTarget(dir, filename);
  // Sanitizing already removed separators; this guards the join itself.
  const resolved = path.resolve(target);
  if (!resolved.startsWith(`${path.resolve(dir)}${path.sep}`)) {
    throw Object.assign(new Error('upload escapes the uploads directory'), { status: 400 });
  }

  await writeFile(resolved, buffer);

  const sniffed = detectImageMime(buffer);
  const declared = typeof mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : '';
  const effectiveMime = sniffed ?? declared ?? 'application/octet-stream';
  return {
    name: path.basename(resolved),
    path: resolved,
    mime: effectiveMime,
    size: buffer.length,
    isImage: Boolean(sniffed) || effectiveMime.startsWith('image/'),
  };
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/**
 * Attachment descriptors come back from the browser, so `path` is
 * client-controlled. Only keep paths inside the session's working directory —
 * otherwise this becomes a way to feed any file on disk to the model.
 */
export function normalizeAttachments(list, cwd) {
  const base = path.resolve(String(cwd));
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || typeof entry.path !== 'string' || !entry.path) continue;
    const resolved = path.resolve(entry.path);
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) continue;
    const mime = typeof entry.mime === 'string' ? entry.mime : '';
    out.push({
      name: path.basename(resolved),
      path: resolved,
      mime,
      isImage: mime.startsWith('image/') || IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase()),
    });
    if (out.length >= MAX_UPLOADS_PER_MESSAGE) break;
  }
  return out;
}
