import { sanitizeName } from './common.js';

const MANIFEST = 'Vid2Study-library.json';
const INDEX = 'Vid2Study.html';
const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
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

export function libraryIndex(entries) {
  const categories = new Map();
  for (const row of entries) {
    const label = [row.subject, row.module, row.category].join(' › ');
    if (!categories.has(label)) categories.set(label, []);
    categories.get(label).push(row);
  }
  const groups = [...categories.entries()].sort(([a], [b]) => a.localeCompare(b));
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Vid2Study Library</title><style>body{font:1rem/1.6 system-ui;color:#172632;background:#f7fafb;max-width:68rem;margin:3rem auto;padding:0 1.5rem}' +
    '.library{display:grid;grid-template-columns:minmax(12rem,1fr) minmax(0,3fr);gap:1.25rem} nav ul{list-style:none;padding:0}' +
    'section{background:white;border:1px solid #bbc9cf;padding:1rem 1.5rem;margin:0 0 1rem} h2{font-size:1.15rem;margin-top:0}a{color:#064a70}' +
    'input{display:block;box-sizing:border-box;width:100%;max-width:24rem;margin:.3rem 0 1.25rem;padding:.4rem;font:inherit}' +
    '@media(max-width:680px){.library{display:block}nav{margin-bottom:1rem}}</style></head>' +
    '<body><h1>Vid2Study Library</h1><label id="search-label" hidden>Search lectures <input id="search" type="search"></label>' +
    '<div class="library"><nav aria-label="Library topics"><ul>' + groups.map(([name], i) =>
      '<li><a href="#group-' + i + '">' + escape(name) + '</a></li>').join('') + '</ul></nav><main>' +
    groups.map(([name, list], i) => '<section id="group-' + i + '"><h2>' + escape(name) + '</h2><ul>' +
      list.sort((a, b) => a.title.localeCompare(b.title)).map(row =>
        '<li><a href="./' + row.path.map(encodeURIComponent).join('/') + '">' + escape(row.title) + '</a></li>').join('') +
      '</ul></section>').join('') + '<p id="no-matches" role="status" hidden>No matching lectures.</p></main></div>' +
    '<script>document.getElementById("search-label").hidden=false;document.getElementById("search").addEventListener("input",e=>{' +
    'const q=e.target.value.toLowerCase().trim();let matches=0;for(const section of document.querySelectorAll("main section")){' +
    'const title=section.querySelector("h2").textContent;let count=0;for(const row of section.querySelectorAll("li")){' +
    'row.hidden=!(title+" "+row.textContent).toLowerCase().includes(q);if(!row.hidden)count++;}section.hidden=count===0;matches+=count;' +
    'document.querySelector("nav a[href=\\"#"+section.id+"\\"]").parentElement.hidden=section.hidden;}' +
    'document.getElementById("no-matches").hidden=matches>0;});</script></body></html>';
}

export async function saveLibraryLecture(root, result, html) {
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
  const next = [...entries.filter(item => item.id !== id), { ...heading, id, path }];
  await writeFile(root, MANIFEST, JSON.stringify({ version: 1, entries: next }, null, 2));
  await writeFile(root, INDEX, libraryIndex(next));
  return { location: [root.name, ...path].join(' / '), index: INDEX };
}
