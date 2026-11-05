// Madd'Shiid Records - YouTube sync.
// Runs on GitHub Actions (Node 20+, no dependencies). Reads data/sources.json,
// asks YouTube for the latest uploads / album playlists and writes data/youtube.json,
// which the Listen page (listen.html) loads. Old entries are KEPT, so the library only grows.
//
// Works with NO API key (public RSS feeds: latest ~15 per channel / playlist).
// Optional: add a repo secret called YOUTUBE_API_KEY to also pull the FULL catalogue
// (every upload, every album playlist, exact track order).

import fs from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const readJSON = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(new URL(p, ROOT), 'utf8')); } catch { return fallback; }
};

const SRC = readJSON('data/sources.json', {});
const PREV = readJSON('data/youtube.json', { music: [], albums: [], videos: [], resolved: {} });
const API_KEY = process.env.YOUTUBE_API_KEY || '';
const HEADERS = { 'user-agent': 'Mozilla/5.0 (compatible; MaddShiidSync/1.0)', 'accept-language': 'en-US,en;q=0.9' };

let okCount = 0;
const warn = (...a) => console.warn('  !', ...a);
const log = (...a) => console.log(...a);

async function get(url, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
      return await r.text();
    } catch (e) { err = e; await new Promise(r => setTimeout(r, 800 * (i + 1))); }
  }
  throw err;
}

const decode = s => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&amp;/g, '&').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>')); return m ? decode(m[1]) : ''; };
const clean = a => String(a || '').replace(/\s*-\s*Topic$/i, '').trim();

// ---------- RSS ----------
function parseFeed(xml) {
  const parts = xml.split('<entry>');
  const head = parts.shift();
  const feed = { title: tag(head, 'title'), author: tag(head.split('<author>')[1] || '', 'name') };
  feed.entries = parts.map(e => ({
    id: tag(e, 'yt:videoId'),
    title: tag(e, 'title'),
    artist: tag((e.split('<author>')[1] || ''), 'name') || feed.author,
    published: tag(e, 'published')
  })).filter(e => e.id);
  return feed;
}
const feedUrl = (kind, id) => `https://www.youtube.com/feeds/videos.xml?${kind}=${encodeURIComponent(id)}`;

// ---------- Handle -> channel id ----------
const resolved = { ...(PREV.resolved || {}) };
async function channelIdFor(src) {
  if (src.id) return src.id;
  const handle = String(src.handle || '').replace(/^@/, '');
  if (resolved[handle]) return resolved[handle];
  const html = await get(`https://www.youtube.com/@${handle}`);
  const m = html.match(/"channelId":"(UC[\w-]{22})"/) || html.match(/channel\/(UC[\w-]{22})/) || html.match(/channel_id=(UC[\w-]{22})/);
  if (!m) throw new Error('could not resolve @' + handle);
  resolved[handle] = m[1];
  return m[1];
}

// ---------- Optional Data API ----------
async function api(endpoint, params) {
  const out = []; let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ ...params, key: API_KEY, maxResults: '50', ...(pageToken ? { pageToken } : {}) });
    const j = JSON.parse(await get(`https://www.googleapis.com/youtube/v3/${endpoint}?${qs}`));
    out.push(...(j.items || []));
    pageToken = j.nextPageToken || '';
    if (!pageToken) break;
  }
  return out;
}
const itemToEntry = it => ({
  id: it.snippet?.resourceId?.videoId || '',
  title: it.snippet?.title || '',
  artist: clean(it.snippet?.videoOwnerChannelTitle || it.snippet?.channelTitle || ''),
  published: it.contentDetails?.videoPublishedAt || it.snippet?.publishedAt || ''
});
const playableItem = e => e.id && e.title && !/^(Private|Deleted) video$/i.test(e.title);

// ---------- Merge helpers ----------
function mergeList(prev, fresh) {
  const map = new Map();
  for (const x of prev || []) if (x && x.id) map.set(x.id, { ...x });
  for (const x of fresh) {
    if (!x.id) continue;
    const old = map.get(x.id) || {};
    map.set(x.id, { ...old, ...Object.fromEntries(Object.entries(x).filter(([, v]) => v)) });
  }
  const all = [...map.values()];
  const dated = all.filter(x => x.published).sort((a, b) => (a.published < b.published ? 1 : a.published > b.published ? -1 : 0));
  const undated = all.filter(x => !x.published);
  return [...dated, ...undated];
}

const music = [], videos = [], albumsOut = new Map();
for (const a of PREV.albums || []) if (a && a.id) albumsOut.set(a.id, { id: a.id, title: a.title || '', artist: a.artist || '', tracks: a.tracks || [] });

// ---------- Music channels ----------
log('Music channels');
for (const src of SRC.musicChannels || []) {
  try {
    const id = await channelIdFor(src);
    if (API_KEY) {
      const uploads = await api('playlistItems', { part: 'snippet,contentDetails', playlistId: 'UU' + id.slice(2) });
      music.push(...uploads.map(itemToEntry).filter(playableItem));
      const lists = await api('playlists', { part: 'snippet', channelId: id });
      for (const pl of lists) {
        const items = (await api('playlistItems', { part: 'snippet,contentDetails', playlistId: pl.id })).map(itemToEntry).filter(playableItem);
        if (!items.length) continue;
        const prev = albumsOut.get(pl.id) || {};
        albumsOut.set(pl.id, { id: pl.id, title: clean(pl.snippet.title), artist: clean(pl.snippet.channelTitle), tracks: items.map(i => ({ id: i.id, title: i.title })) });
        music.push(...items.map(i => ({ ...i, albumId: pl.id })));
      }
      log('  ok (API)', id);
    } else {
      const feed = parseFeed(await get(feedUrl('channel_id', id)));
      music.push(...feed.entries.map(e => ({ ...e, artist: clean(e.artist) })));
      log('  ok', id, feed.title, feed.entries.length + ' items');
    }
    okCount++;
  } catch (e) { warn('music channel failed:', e.message); }
}

// ---------- Albums (pinned playlists) ----------
log('Albums');
for (const pid of SRC.albums || []) {
  try {
    const prev = albumsOut.get(pid) || { id: pid, title: '', artist: '', tracks: [] };
    if (API_KEY) {
      const meta = JSON.parse(await get(`https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${pid}&key=${API_KEY}`)).items?.[0];
      const items = (await api('playlistItems', { part: 'snippet,contentDetails', playlistId: pid })).map(itemToEntry).filter(playableItem);
      albumsOut.set(pid, { id: pid, title: clean(meta?.snippet?.title) || prev.title, artist: clean(meta?.snippet?.channelTitle) || prev.artist, tracks: items.map(i => ({ id: i.id, title: i.title })) });
      music.push(...items.map(i => ({ ...i, albumId: pid })));
    } else {
      const feed = parseFeed(await get(feedUrl('playlist_id', pid)));
      const tracks = feed.entries.map(e => ({ id: e.id, title: e.title }));
      albumsOut.set(pid, {
        id: pid,
        title: clean(feed.title) || prev.title,
        artist: clean(feed.author) || prev.artist,
        tracks: tracks.length ? tracks : prev.tracks
      });
      music.push(...feed.entries.map(e => ({ ...e, artist: clean(e.artist), albumId: pid })));
    }
    // fallback for a title if the feed had none
    if (!albumsOut.get(pid).title) {
      try {
        const o = JSON.parse(await get('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/playlist?list=' + pid)));
        albumsOut.get(pid).title = clean(o.title);
        if (!albumsOut.get(pid).artist) albumsOut.get(pid).artist = clean(o.author_name);
      } catch { /* leave blank, page will show "Album N" */ }
    }
    okCount++;
    log('  ok', pid, albumsOut.get(pid).title, '(' + albumsOut.get(pid).tracks.length + ' tracks)');
  } catch (e) { warn('album failed:', pid, e.message); }
}

// ---------- Video channels ----------
log('Video channels');
for (const src of SRC.videoChannels || []) {
  try {
    const id = await channelIdFor(src);
    if (API_KEY) {
      const uploads = await api('playlistItems', { part: 'snippet,contentDetails', playlistId: 'UU' + id.slice(2) });
      videos.push(...uploads.map(itemToEntry).filter(playableItem));
      log('  ok (API)', src.handle || id);
    } else {
      const feed = parseFeed(await get(feedUrl('channel_id', id)));
      videos.push(...feed.entries);
      log('  ok', src.handle || id, feed.entries.length + ' items');
    }
    okCount++;
  } catch (e) { warn('video channel failed:', (src.handle || src.id), e.message); }
}

// ---------- Pinned videos (titles via oEmbed) ----------
log('Pinned videos');
const prevVideos = new Map((PREV.videos || []).map(v => [v.id, v]));
for (const id of SRC.pinnedVideos || []) {
  const have = prevVideos.get(id) || videos.find(v => v.id === id);
  if (have && have.title) { videos.push({ id, title: have.title, artist: have.artist || '' }); continue; }
  try {
    const o = JSON.parse(await get('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id)));
    videos.push({ id, title: decode(o.title), artist: clean(o.author_name) });
  } catch (e) { warn('oembed failed for', id, e.message); videos.push({ id, title: '', artist: '' }); }
}

if (okCount === 0) {
  console.error('Nothing could be fetched - leaving data/youtube.json untouched.');
  process.exit(1);
}

// ---------- Write ----------
const result = {
  updated: new Date().toISOString(),
  music: mergeList(PREV.music, music),
  albums: [...albumsOut.values()],
  videos: mergeList(PREV.videos, videos),
  resolved
};

const strip = o => JSON.stringify({ ...o, updated: null });
if (strip(result) === strip(PREV)) {
  log('No changes.');
} else {
  fs.writeFileSync(new URL('data/youtube.json', ROOT), JSON.stringify(result, null, 2) + '\n');
  log(`Saved: ${result.music.length} tracks, ${result.albums.length} albums, ${result.videos.length} videos.`);
}
