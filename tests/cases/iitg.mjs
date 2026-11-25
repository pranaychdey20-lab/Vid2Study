import assert from 'node:assert/strict';

globalThis.window = { __lhUtil: { sanitize: value => value }, __lhAdapters: [] };
globalThis.location = { pathname: '/sessions/session-id/courses/course-id' };
globalThis.chrome = {};
let requests = 0;
globalThis.fetch = async (url, options) => {
  assert.equal(url, '/api/courses/student/course-id?sessionId=session-id');
  assert.equal(options.credentials, 'include');
  requests++;
  return {
    ok: true,
    json: async () => ({ name: 'Robotics', modules: [{ chapters: [{ lessons: [{ title: 'Lecture 01', file: { key: 'lecture.mp4' } }] }] }] })
  };
};
await import('./adapters/iitg.js');
const [adapter] = window.__lhAdapters;
const course = await adapter.listLectures(false);
assert.equal(course.lectures[0].title, 'Lecture 01');
assert.deepEqual(await adapter.listLectures(true), course);
const ungrouped = window.__iitgParseCourse({ name: 'Direct lessons', modules: [{ lessons: [{ title: 'Lecture 02', file: { key: '02.mp4' } }] }] });
assert.equal(ungrouped.lectures[0].chapter, '');
assert.equal(ungrouped.lectures[0].title, 'Lecture 02');

globalThis.chrome.storage = { session: {
  get: async () => { throw new Error('Access denied'); },
  set: async () => { throw new Error('Access denied'); }
} };
assert.deepEqual(await adapter.listLectures(false), course);

globalThis.chrome.storage.session.get = async key => ({ [key]: course });
assert.equal(await adapter.listLectures(false), course);
assert.equal(requests, 3);
