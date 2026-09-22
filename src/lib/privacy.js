// Privacy args — ytmusic-player parity (src/privacy.ts).
// Every yt-dlp + mpv invocation runs tracking-free: no user config, no disk
// cache, no cookies. Proxy via YTMUSIC_PROXY (socks5 or http(s)).
export function proxyUrl() {
  return (process.env.YTMUSIC_PROXY || '').trim();
}

export function ytDlpPrivacyArgs() {
  const args = ['--ignore-config', '--no-cache-dir', '--no-cookies', '--no-cookies-from-browser'];
  const proxy = proxyUrl();
  if (proxy) args.push('--proxy', proxy);
  return args;
}

export function mpvPrivacyArgs() {
  const ytdlOptions = ['ignore-config=', 'no-cache-dir=', 'no-cookies=', 'no-cookies-from-browser='];
  const proxy = proxyUrl();
  if (proxy) ytdlOptions.push(`proxy=${proxy}`);
  const args = [
    '--cache-on-disk=no',
    '--resume-playback=no',
    '--cookies=no',
    `--ytdl-raw-options=${ytdlOptions.join(',')}`,
  ];
  if (proxy && /^https?:\/\//i.test(proxy)) args.push(`--http-proxy=${proxy}`);
  return args;
}
