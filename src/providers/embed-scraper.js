// Generic embed scraper — works with any streaming site that has a search page.
// No API guessing; pure HTML parsing with multiple fallback strategies.
import { fetchText } from '../net.js';
import { parseLadder } from '../hls.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = 15000;

async function siteFetch(url, opts = {}) {
  return fetchText(url, {
    userAgent: UA,
    timeoutMs: TIMEOUT,
    signal: opts.signal,
    debug: opts.debug,
  });
}

function extractLinks(html, pattern) {
  const links = [];
  const regex = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const href = match[1];
    if (pattern.test(href) && !links.includes(href)) {
      links.push(href);
    }
  }
  return links;
}

function extractIframes(html) {
  const iframes = [];
  const regex = /<iframe[^>]+src=["']([^"']+)["']/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    if (!iframes.includes(match[1])) iframes.push(match[1]);
  }
  return iframes;
}

function extractM3u8(text) {
  const urls = [];
  const regex = /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const url = match[0].replace(/\\u0026/g, '&').replace(/\\/g, '/');
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

function extractVideoSources(html) {
  const sources = [];
  const regex = /<source[^>]+src=["']([^"']+)["']/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    if (!sources.includes(match[1])) sources.push(match[1]);
  }
  return sources;
}

function findBestMatch(html, title, linkPattern) {
  const links = extractLinks(html, linkPattern);
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const link of links) {
    const linkText = link.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (linkText.includes(normalizedTitle) || normalizedTitle.includes(linkText)) {
      return link;
    }
  }
  return links[0] || null;
}

export function createEmbedScraper(config) {
  const { id, name, site, sites, tokens = [], searchUrl, linkPattern, detailLinkPattern } = config;
  return {
    id, name, site, sites, tokens,
    direct: true,
    kinds: ['movie', 'tv'],
    async search(query, opts = {}) {
      try {
        const url = searchUrl.replace('{query}', encodeURIComponent(query));
        const html = await siteFetch(url, opts);
        const links = extractLinks(html, linkPattern);
        return links.slice(0, 10).map((link, i) => ({
          id: `${id}-${i}`,
          title: link.split('/').pop()?.replace(/[-_]/g, ' ').replace(/\.\w+$/, '') || `Result ${i + 1}`,
          url: link,
          kind: 'movie',
        }));
      } catch { return []; }
    },
    async resolve(media, opts = {}) {
      const audio = opts.audio === 'dub' ? 'dub' : 'sub';
      let targetUrl = media.url;
      if (!targetUrl) {
        const searchUrlResolved = searchUrl.replace('{query}', encodeURIComponent(media.title));
        const searchHtml = await siteFetch(searchUrlResolved, opts);
        const bestLink = findBestMatch(searchHtml, media.title, linkPattern);
        if (!bestLink) throw new Error(`${name}: no results found`);
        targetUrl = bestLink;
      }
      const detailHtml = await siteFetch(targetUrl, opts);
      let embedUrl = null;
      const iframes = extractIframes(detailHtml);
      if (iframes.length > 0) embedUrl = iframes[0];
      if (!embedUrl) {
        const embedLinks = extractLinks(detailHtml, detailLinkPattern || /\/(embed|player|watch|stream)\//i);
        if (embedLinks.length > 0) embedUrl = embedLinks[0];
      }
      if (!embedUrl) {
        const m3u8Urls = extractM3u8(detailHtml);
        if (m3u8Urls.length > 0) {
          const streamHtml = await siteFetch(m3u8Urls[0], opts);
          const variants = parseLadder(streamHtml, m3u8Urls[0]);
          const headers = { Referer: sites[0], 'User-Agent': UA };
          const sources = (variants.length ? variants : [{ url: m3u8Urls[0], quality: 'auto', rank: 0 }]).map((v) => ({
            url: v.url, quality: `${v.quality} ${audio}`, type: 'hls', provider: id, direct: true, headers,
          }));
          return { embedUrl: targetUrl, sources };
        }
      }
      if (!embedUrl) throw new Error(`${name}: no embed found`);
      const embedHtml = await siteFetch(embedUrl, opts);
      const m3u8Urls = extractM3u8(embedHtml);
      if (m3u8Urls.length > 0) {
        const streamHtml = await siteFetch(m3u8Urls[0], opts);
        const variants = parseLadder(streamHtml, m3u8Urls[0]);
        const headers = { Referer: sites[0], 'User-Agent': UA };
        const sources = (variants.length ? variants : [{ url: m3u8Urls[0], quality: 'auto', rank: 0 }]).map((v) => ({
          url: v.url, quality: `${v.quality} ${audio}`, type: 'hls', provider: id, direct: true, headers,
        }));
        return { embedUrl, sources };
      }
      const videoSources = extractVideoSources(embedHtml);
      if (videoSources.length > 0) {
        const headers = { Referer: sites[0], 'User-Agent': UA };
        const sources = videoSources.map((url) => ({
          url, quality: `auto ${audio}`, type: 'hls', provider: id, direct: true, headers,
        }));
        return { embedUrl, sources };
      }
      throw new Error(`${name}: no stream found`);
    },
  };
}
