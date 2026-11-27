import { sanitizeName } from './common.js';
import { libraryPage, SCRIPT_PATH } from './library-page.js';

const MANIFEST = 'Vid2Study-library.json';
const INDEX = 'Vid2Study.html';
const portableText = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
const chapterHeadings = markdown => [...String(markdown || '').matchAll(/^## Chapter:\s+(.+)$/gm)].map(match => match[1].trim());

export function libraryLocation(result) {
  const subject = portableText(result.course) || (result.source === 'youtube' ? 'YouTube lectures' : 'Local lectures');
  const chapters = [...new Set(chapterHeadings(result.summary_markdown))];
  const module = portableText(result.library?.module) || 'General';
  const category = portableText(result.library?.category) || (chapters.length === 1 ? chapters[0] : 'Lectures');
  return { subject, module, category, title: portableText(result.title) || 'Lecture' };
}

function fileLabel(name) {
  const clean = sanitizeName(name, 'Lecture').slice(0, 80).replace(/[ .]+$/, '') || 'Lecture';
  return /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(clean) || clean.startsWith('.') ? 'Notes ' + clean : clean;
}

function openablePath(path) {
  return Array.isArray(path) && path.length === 4 && path.every(item =>
    typeof item === 'string' && item.length && !/[<>:"/\\|?*\u0000-\u001f]/.test(item) && item !== '.' && item !== '..') &&
    path.at(-1).endsWith('.html');
}

async function readFile(dir, name) {
  try { return await (await dir.getFileHandle(name)).getFile(); }
  catch (error) { if (error.name !== 'NotFoundError') throw error; return null; }
}

async function writeFile(dir, name, content) {
  const file = await dir.getFileHandle(name, { create: true });
  const stream = await file.createWritable();
  try { await stream.write(content); await stream.close(); }
  catch (error) { await stream.abort().catch(() => {}); throw error; }
  return file.getFile();
}

/** The master page (see lib/library-page.js). */
export const libraryIndex = libraryPage;

export const RUNTIME_PATH = ['.vid2study', 'visuals.js'];
/** How a saved lecture file links back to the master page and to the shared visual code (every lecture sits 4 folders deep). */
export const LECTURE_LINKS = { back: '../../../../Vid2Study.html', shared: '../../../../.vid2study/visuals.js' };

/** The saved lecture file of a library entry, as text. */
export async function readLibraryLecture(root, entry) {
  let dir = root;
  for (const part of entry.path.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
  return (await (await dir.getFileHandle(entry.path.at(-1))).getFile()).text();
}

/** The id a saved lecture has in a library (and in its manifest). */
export async function lectureId(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(key)));
  return Array.from(new Uint8Array(digest).slice(0, 8), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The entries of a library folder: [] for a folder with no library yet; throws for one that cannot be used. */
export async function readLibraryManifest(root) {
  const file = await readFile(root, MANIFEST);
  if (!file) {
    if (await readFile(root, INDEX)) throw new Error('This folder already contains a file called ' + INDEX + '. Choose another folder.');
    return [];
  }
  const saved = JSON.parse(await file.text());
  if (saved?.version !== 1 || !Array.isArray(saved.entries) || saved.entries.some(entry =>
    !entry || typeof entry.id !== 'string' || !openablePath(entry.path) ||
    ['subject', 'module', 'category', 'title'].some(field => typeof entry[field] !== 'string'))) {
    throw new Error('The selected folder contains an unreadable Vid2Study library.');
  }
  return saved.entries;
}

/** The shelf script, read from lib/library-ui.js (tests pass it in). One copy is written per library. */
export async function libraryScript(source) {
  return source ?? await (await fetch(new URL('./library-ui.js', import.meta.url))).text();
}

/** `shelf` = the shelf script to keep in the folder; `extensionId` adds an "open with the assistant" button to the standalone page. */
export async function saveLibraryLecture(root, result, html, runtime = '', { shelf = '', extensionId = '' } = {}) {
  const entries = await readLibraryManifest(root);
  const id = await lectureId(result.key);
  const heading = libraryLocation(result);
  const previous = entries.find(item => item.id === id);
  const path = previous?.path || [heading.subject, heading.module, heading.category].map(fileLabel)
    .concat(fileLabel(heading.title) + ' · ' + id + '.html');
  let destination = root;
  for (const folder of path.slice(0, -1)) destination = await destination.getDirectoryHandle(folder, { create: true });
  if (!previous && await readFile(destination, path.at(-1))) throw new Error('A file already exists at this lecture’s destination.');
  const lecture = await writeFile(destination, path.at(-1), html);
  if (!lecture.size || !(await lecture.slice(0, 48).text()).startsWith('<!doctype html>')) throw new Error('The saved lecture could not be read.');
  const next = [...entries.filter(item => item.id !== id), { ...heading, id, path, savedAt: Date.now() }];
  const shared = await root.getDirectoryHandle(RUNTIME_PATH[0], { create: true });
  if (runtime) await writeFile(shared, RUNTIME_PATH[1], runtime); // ONE copy of the visual code for every lecture
  if (shelf) await writeFile(shared, SCRIPT_PATH.split('/')[1], shelf); // and ONE copy of the shelf script
  await writeFile(root, MANIFEST, JSON.stringify({ version: 1, entries: next }, null, 2));
  await writeFile(root, INDEX, libraryIndex(next, { extensionId }));
  return { location: [root.name, ...path].join(' / '), index: INDEX };
}
