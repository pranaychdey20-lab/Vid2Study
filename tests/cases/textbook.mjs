import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { readFileSync } from 'node:fs';
import { completeWriterPrefix, emptyTopics, missingScreenTopics, unmatchedCoverage } from './lib/coverage.js';
import { renderMarkdown } from './lib/md.js';
import { libraryIndex, libraryLocation, saveLibraryLecture, lectureId, readLibraryManifest, LECTURE_LINKS } from './lib/textbook-library.js';
import { libraryShell } from './lib/library-page.js';
import { readVisual, transformedPixels, visualRuntime } from './lib/textbook-visuals.js';

globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
globalThis.chrome = { runtime: { getURL: path => path } };
const { placeTopicFigures } = await import('./lib/local-pipeline.js');

const lecture = [
  '### Adaptive Histogram Equalization (AHE) (04:10)',
  'AHE equalizes each tile separately.',
  '[[FRAME:19]]',
  '[[FRAME:20]]',
  '### Contrast-Limited Adaptive Histogram Equalization (CLAHE) (04:32)',
  'Standard',
  '> **Watch Out:** Check the clip limit.',
  '### Histogram Stretching (09:00)',
  'Linear stretching maps the original range to $[0,255]$.',
  '[[FRAME:16]]',
  '[[FRAME:17]]'
].join('\n');
const slideTopics = [{ title: 'Contrast-Limited Adaptive Histogram Equalization (CLAHE)' }];
assert.equal(emptyTopics(lecture).length, 1);
assert.equal(missingScreenTopics(slideTopics, () => lecture).length, 1);
assert.equal(unmatchedCoverage([{ anchors: ['clahe', 'clip limit'] }], () => lecture).length, 1);
const frames = [
  { index: 19, t: 514, tag: 'table', presentation: 'visual', caption: 'Uniform excess redistribution in CLAHE' },
  { index: 20, t: 272, tag: 'diagram', presentation: 'visual', caption: 'The workflow of Contrast-Limited Adaptive Histogram Equalization (CLAHE)' },
  { index: 16, t: 549, tag: 'formula', presentation: 'reproducible', caption: 'Histogram stretching' },
  { index: 17, t: 550, tag: 'formula', presentation: 'visual', caption: 'Histogram stretching annotated with a graph' }
];
const placed = placeTopicFigures(lecture, frames, 600, [], new Set([16, 17, 19]));
assert.match(placed, /### Contrast-Limited[\s\S]*\[\[FRAME:19\]\][\s\S]*### Histogram Stretching/);
assert.match(placed, /### Contrast-Limited[\s\S]*\[\[FRAME:20\]\][\s\S]*### Histogram Stretching/);
assert.doesNotMatch(placed.split('### Contrast-Limited')[0], /FRAME:1[69]|FRAME:20/);
assert.doesNotMatch(placed, /FRAME:16/);
assert.match(placed, /FRAME:17/);
assert.equal(emptyTopics(placed).length, 1, 'moving the figures does not fill in the missing explanation');
const expanded = placed.replace('Standard', 'CLAHE limits how much a tile’s contrast can increase. Clip large bins, redistribute excess counts, then build the intensity map.');
assert.equal(emptyTopics(expanded).length, 0);
assert.equal(missingScreenTopics(slideTopics, () => expanded).length, 0);

const visual = { type: 'brightness_contrast', pixels: [40, 120, 230], beta: 30 };
const json = JSON.stringify(visual);
const fence = '\x60'.repeat(3);
const md = fence + 'visual\n' + json + '\n' + fence;
assert.deepEqual(completeWriterPrefix('Keep this paragraph.\n\n' + fence + 'visual\n{"type"'), { text: 'Keep this paragraph.', incomplete: true });
assert.equal(completeWriterPrefix(md).incomplete, false);
assert.deepEqual(transformedPixels(visual.type, visual.pixels, readVisual(json).params), [70, 150, 255]);
assert.match(renderMarkdown(md), /input type="range"/);
assert.doesNotMatch(renderMarkdown(md, { interactive: false }), /type="range"/);
assert.doesNotMatch(renderMarkdown(fence + 'visual\n{"type":"<script>alert(1)</script>"}\n' + fence), /<script>/);
assert.doesNotMatch(renderMarkdown('![Reference figure](https://example.invalid/image.jpg)', { localImagesOnly: true }), /<img/);

assert.deepEqual(libraryLocation({ source: 'combined', course: 'Robotic Sensing and Vision', title: 'CLAHE',
  summary_markdown: '## Chapter: Image Enhancement using Histograms', library: { module: 'Photometric Transforms' } }),
{ subject: 'Robotic Sensing and Vision', module: 'Photometric Transforms', category: 'Image Enhancement using Histograms', title: 'CLAHE' });
assert.match(libraryIndex([{ subject: '<em>x</em>', module: 'm', category: 'c', title: 'CLAHE', path: ['A B', 'm', 'c', 'note.html'] }]), /href="\.\/A%20B\/m\/c\/note.html"/);
assert.doesNotMatch(libraryIndex([{ subject: '<em>x</em>', module: 'm', category: 'c', title: 'CLAHE', path: ['s', 'm', 'c', 'note.html'] }]), /<em>/);

class Directory {
  constructor(name) { this.name = name; this.files = new Map(); this.children = new Map(); }
  async getDirectoryHandle(name) {
    if (!this.children.has(name)) this.children.set(name, new Directory(name));
    return this.children.get(name);
  }
  async getFileHandle(name, { create } = {}) {
    if (!this.files.has(name)) {
      if (!create) throw new DOMException('Missing', 'NotFoundError');
      this.files.set(name, '');
    }
    return {
      getFile: async () => new Blob([this.files.get(name)]),
      createWritable: async () => ({ write: async data => this.files.set(name, data), close: async () => {} })
    };
  }
}
const dir = new Directory('University');
const record = { key: 'first', title: 'Histogram stretching', course: 'Robot Vision' };
const html = '<!doctype html><title>Notes</title>';
await saveLibraryLecture(dir, record, html);
await saveLibraryLecture(dir, { ...record, key: 'second', title: 'CLAHE' }, html);
await saveLibraryLecture(dir, record, html);
assert.match(dir.files.get('Vid2Study.html'), /CLAHE/);
assert.match(dir.files.get('Vid2Study.html'), /Histogram stretching/);
assert.equal(JSON.parse(dir.files.get('Vid2Study-library.json')).entries.length, 2);

// the shelf script exists ONCE (lib/library-ui.js), shared by the standalone page and the extension page
{
  const shelfScript = readFileSync(new URL('./lib/library-ui.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new Script(shelfScript), 'the shelf script parses');
  const id = 'a'.repeat(32);
  await saveLibraryLecture(dir, { ...record, key: 'third', title: 'Gamma' }, html, '', { shelf: shelfScript, extensionId: id });
  const page = dir.files.get('Vid2Study.html');
  assert.match(page, /<script src="\.vid2study\/library\.js"><\/script>/);
  assert.doesNotMatch(page, /<script>[^<]*function/, 'the page no longer embeds the script');
  assert.equal(dir.children.get('.vid2study').files.get('library.js'), shelfScript);
  assert.ok(page.includes('chrome-extension://' + id + '/library-open.html'), 'the data carries the assistant address (the page copies it: a file page cannot link to an extension)');
  assert.doesNotMatch(page, /<a[^>]+href="chrome-extension/, 'no link that a file page would be blocked from opening');
  assert.doesNotMatch(libraryIndex([{ subject: 's', module: 'm', category: 'c', title: 't', path: ['s', 'm', 'c', 'n.html'] }]), /chrome-extension/, 'no assistant address without an id');
  assert.doesNotMatch(libraryIndex([], { extensionId: '../../x' }), /chrome-extension/, 'a bad id is ignored');
  assert.equal((await lectureId('first')).length, 16);
  assert.equal(await lectureId('first'), JSON.parse(dir.files.get('Vid2Study-library.json')).entries.find(e => e.title === 'Histogram stretching').id);
  assert.equal((await readLibraryManifest(dir)).length, 3);
  assert.deepEqual(await readLibraryManifest(new Directory('empty')), []);
  // a lecture sits three folders below the library root, so its links climb exactly three levels
  assert.deepEqual(LECTURE_LINKS, { back: '../../../Vid2Study.html', shared: '../../../.vid2study/visuals.js' });
  const depth = (await readLibraryManifest(dir))[0].path.length - 1;
  assert.equal(LECTURE_LINKS.back.split('../').length - 1, depth, 'the back link climbs as many levels as the lecture is deep');
  const shell = libraryShell((await readLibraryManifest(dir)));
  assert.ok(shell.css.includes('.shell') && shell.body.includes('id="shell"') && JSON.parse(shell.json).entries.length === 3);
  assert.ok(!shell.body.includes('<script'), 'the shell carries no script of its own');
}
