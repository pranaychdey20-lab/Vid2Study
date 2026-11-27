import { sanitizeName } from './common.js';
import { libraryPage } from './library-page.js';

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

export async function saveLibraryLecture(root, result, html, runtime = '') {
  const file = await readFile(root, MANIFEST);
  let entries = [];
  if (file) {
    const saved = JSON.parse(await file.text());
    if (saved?.version !== 1 || !Array.isArray(saved.entries) || saved.entries.some(entry =>
      !entry || typeof entry.id !== 'string' || !openablePath(entry.path) ||
      ['subject', 'module', 'category', 'title'].some(field => typeof entry[field] !== 'string'))) {
      throw new Error('The selected folder contains an unreadable Vid2Study library.');
    }
    entries = saved.entries;
  } else if (await readFile(root, INDEX)) {
    throw new Error('This folder already contains a file called ' + INDEX + '. Choose another folder.');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(result.key)));
  const id = Array.from(new Uint8Array(digest).slice(0, 8), byte => byte.toString(16).padStart(2, '0')).join('');
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
  if (runtime) await writeFile(await root.getDirectoryHandle(RUNTIME_PATH[0], { create: true }), RUNTIME_PATH[1], runtime); // ONE copy for every lecture
  await writeFile(root, MANIFEST, JSON.stringify({ version: 1, entries: next }, null, 2));
  await writeFile(root, INDEX, libraryIndex(next));
  return { location: [root.name, ...path].join(' / '), index: INDEX };
}
