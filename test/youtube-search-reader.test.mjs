import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

test('YouTube reader extracts public video cards, ignores invalid links and checks job identity', () => {
  let listener;
  const card = (href, title) => ({ querySelector(selector) {
    if (selector === 'a#video-title') return { href, textContent: title, getAttribute: () => title };
    return { textContent: selector === 'ytd-channel-name' ? 'Singer' : '3:20' };
  } });
  const document = { body: { innerText: '' }, querySelectorAll: () => [card('https://www.youtube.com/watch?v=k9OCGQl5HMI&list=abc', 'Song'), card('https://www.youtube.com/watch?v=k9OCGQl5HMI', 'Duplicate'), card('https://evil.test/watch?v=zxjFe42SA8I', 'Invalid')] };
  const context = { URL, document, location: { href: 'https://www.youtube.com/results?search_query=song&ktv_search=job' }, chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } } };
  vm.runInNewContext(readFileSync(new URL('../extension/youtube-search-reader.js', import.meta.url), 'utf8'), context);
  let response;
  listener({ type: 'ktv-search-read', id: 'job', query: 'song' }, {}, value => { response = value; });
  assert.equal(response.results.length, 1); assert.equal(response.results[0].url, 'https://www.youtube.com/watch?v=k9OCGQl5HMI');
  assert.equal(response.results[0].author, 'Singer'); assert.equal(response.results[0].duration, '3:20');
  listener({ type: 'ktv-search-read', id: 'old', query: 'song' }, {}, value => { response = value; });
  assert.equal(response.wrongPage, true);
  document.body.innerText = 'Sign in to confirm you’re not a bot';
  assert.equal(context.readHomeKTVYouTubeSearch(document).blocked, true);
});
