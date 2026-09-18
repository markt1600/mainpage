const CHANNEL = 'UCVN5bYdZgY1TWEsBi-zHL9Q';
const validId = id => /^[A-Za-z0-9_-]{11}$/.test(id || '');
const decodeXml = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, c) =>
  c[0] === '#' ? String.fromCodePoint(c[1].toLowerCase() === 'x' ? parseInt(c.slice(2), 16) : Number(c.slice(1)))
    : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[c]);

export function parseFeed(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => ({
    id: entry.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1],
    title: decodeXml(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] || 'Video'),
    publishedAt: entry.match(/<published>(.*?)<\/published>/)?.[1] || null,
  })).filter(v => validId(v.id)).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 5);
}

// Public RSS occasionally returns 404. Fall back to the channel's latest
// uploads tab; parse data only, never execute JavaScript from the response.
export function parseChannel(html) {
  let data;
  const escaped = html.match(/(?:var\s+)?ytInitialData\s*=\s*'((?:\\.|[^'\\])*)';/);
  if (escaped) {
    const json = escaped[1].replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\\'"\/nrtbf])/g, (_, c) => {
      if (c[0] === 'x' || c[0] === 'u') return String.fromCharCode(parseInt(c.slice(1), 16));
      return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[c] ?? c;
    });
    data = JSON.parse(json);
  } else {
    const raw = html.match(/(?:var\s+)?ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (!raw) throw new Error('Upload data unavailable');
    data = JSON.parse(raw[1]);
  }
  const videos = [], seen = new Set();
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    const video = value.videoRenderer || value.gridVideoRenderer || value.compactVideoRenderer;
    const lockup = value.lockupViewModel;
    if (lockup?.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && validId(lockup.contentId) && !seen.has(lockup.contentId)) {
      seen.add(lockup.contentId);
      videos.push({ id: lockup.contentId, title: lockup.metadata?.lockupMetadataViewModel?.title?.content || 'Video', publishedAt: null });
    }
    if (video && validId(video.videoId) && !seen.has(video.videoId)) {
      seen.add(video.videoId);
      videos.push({ id: video.videoId, title: video.title?.simpleText || video.title?.runs?.map(x => x.text).join('') || 'Video', publishedAt: null });
    }
    for (const child of Object.values(value)) walk(child);
  }
  // Restrict traversal to the selected uploads tab, excluding recommendations.
  const contents = data.contents;
  const tabs = contents?.twoColumnBrowseResultsRenderer?.tabs || contents?.singleColumnBrowseResultsRenderer?.tabs;
  const selected = tabs?.find(t => t.tabRenderer?.selected)?.tabRenderer?.content;
  if (!selected) throw new Error('Uploads tab unavailable');
  walk(selected);
  return videos.slice(0, 5);
}

export default async function handler(req, res) {
  const get = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) throw new Error(`YouTube ${response.status}`);
    return response.text();
  };
  try {
    let videos;
    try { videos = parseFeed(await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`)); } catch {}
    if (!videos?.length) videos = parseChannel(await get('https://www.youtube.com/@markt1600/videos'));
    if (!videos.length) throw new Error('No uploads available');
    res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=900');
    res.status(200).json({ videos, fetchedAt: new Date().toISOString() });
  } catch {
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).json({ videos: [], error: 'YouTube uploads temporarily unavailable' });
  }
}
