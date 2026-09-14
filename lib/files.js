import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Anything served from this origin runs with the app's privileges, so an
 * uploaded .html or .svg opened inline could script the page and lift the
 * passphrase out of localStorage. These are forced to a download-only stream.
 */
const NEVER_INLINE = new Set([
  '.html', '.htm', '.xhtml', '.shtml', '.svg', '.svgz', '.xml', '.xsl', '.xslt', '.mhtml',
]);

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.json': 'application/json', '.csv': 'text/csv',
  '.txt': 'text/plain', '.md': 'text/markdown', '.log': 'text/plain',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Every download is served as an attachment; nothing user-supplied renders in this origin. */
export function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (NEVER_INLINE.has(ext)) return 'application/octet-stream';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/**
 * Directories a visitor may download from: the shared workspace plus every
 * session's working directory. Without this the endpoint would be a
 * read-anything primitive for the whole filesystem.
 */
export function collectAllowedRoots({ workspace, sessions }) {
  const roots = new Set();
  if (workspace?.workspace) roots.add(workspace.workspace);
  for (const session of sessions ?? []) {
    if (session.cwd) roots.add(session.cwd);
    for (const dir of session.opts?.addDirs ?? []) {
      if (typeof dir === 'string' && dir) roots.add(dir);
    }
  }
  return [...roots];
}

const realRootCache = new Map();

async function realRoot(root) {
  if (realRootCache.has(root)) return realRootCache.get(root);
  // macOS hands out /tmp but resolves to /private/tmp; compare resolved forms.
  const resolved = await realpath(root).catch(() => path.resolve(root));
  realRootCache.set(root, resolved);
  return resolved;
}

export async function resolveDownload(target, roots) {
  const requested = String(target ?? '').trim();
  if (!requested || !path.isAbsolute(requested)) {
    throw Object.assign(new Error('path must be absolute'), { status: 400 });
  }

  // realpath first: a symlink living inside the workspace must not be able to
  // point at ~/.ssh and ride out through this endpoint.
  const real = await realpath(requested).catch(() => {
    throw Object.assign(new Error('file not found'), { status: 404 });
  });
  const info = await stat(real).catch(() => {
    throw Object.assign(new Error('file not found'), { status: 404 });
  });
  if (!info.isFile()) {
    throw Object.assign(new Error('not a regular file'), { status: 400 });
  }

  for (const root of roots) {
    const base = await realRoot(root);
    if (real === base || real.startsWith(`${base}${path.sep}`)) {
      return { path: real, name: path.basename(real), size: info.size };
    }
  }
  throw Object.assign(new Error('path is outside the shared workspace and session directories'), { status: 403 });
}
