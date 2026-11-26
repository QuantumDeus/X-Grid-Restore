/* X Grid Restore website — public release metadata, no credentials. */
(() => {
  'use strict';
  const owner = 'QuantumDeus';
  const targets = [
    { key: 'chrome', repo: 'x-media-grid-restore', ext: /\.zip$/i },
    { key: 'firefox', repo: 'x-media-grid-restore-firefox', ext: /\.xpi$/i }
  ];
  const cacheTTL = 10 * 60 * 1000;
  const fmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' });
  const dateText = value => Number.isFinite(Date.parse(value)) ? fmt.format(new Date(value)) : null;
  const repoUrl = t => `https://github.com/${owner}/${t.repo}`;
  const semver = value => String(value ?? '').match(/(?:^|[^\d])v?(\d+\.\d+(?:\.\d+)+(?:-[\w.]+)?)(?!\d)/i)?.[1] ?? null;
  function assetFor(release, target) {
    return (release.assets || []).filter(a => a.state !== 'new' && target.ext.test(a.name) &&
      typeof a.browser_download_url === 'string' && a.browser_download_url.toLowerCase().startsWith(`${repoUrl(target).toLowerCase()}/releases/download/`))
      .filter(a => !/(?:^|[-_.])(?:debug|source|symbols|test)(?:[-_.]|$)/i.test(a.name))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(target.repo)) - Number(a.name.toLowerCase().startsWith(target.repo)))[0];
  }
  function selectRelease(releases, target) {
    return releases.filter(r => !r.draft && !r.prerelease && dateText(r.published_at) && assetFor(r, target))
      .sort((a,b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { targets, selectRelease, assetFor, semver, dateText }; return;
  }
  async function request(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { data: await response.json(), next: /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') || '')?.[1] };
    } finally { clearTimeout(timer); }
  }
  async function releasesFor(target) {
    const base = `https://api.github.com/repos/${owner}/${target.repo}/releases`;
    let next = `${base}?per_page=100`, releases = [];
    while (next) {
      if (!next.startsWith(`${base}?`)) throw new Error('Unexpected pagination URL');
      const page = await request(next);
      if (!Array.isArray(page.data)) throw new Error('Invalid releases response');
      releases.push(...page.data); next = page.next;
    }
    const release = selectRelease(releases, target);
    if (!release) throw new Error('No published installable release');
    const asset = assetFor(release, target);
    let version = semver(release.tag_name) || semver(asset.name) || semver(release.name);
    if (!version) {
      // Old tags such as V1 need the manifest at the release tag, not main.
      try {
        const { data } = await request(`https://raw.githubusercontent.com/${owner}/${target.repo}/${encodeURIComponent(release.tag_name)}/manifest.json`);
        version = semver(data.version);
      } catch { /* keep the actual release tag, never invent a version */ }
    }
    const downloads = releases.filter(r => !r.draft && !r.prerelease).flatMap(r => r.assets || [])
      .filter(a => target.ext.test(a.name)).reduce((sum,a) => sum + (Number(a.download_count) || 0), 0);
    return { version: version || release.tag_name, date: release.published_at, url: asset.browser_download_url, downloads, tag: release.tag_name };
  }
  // Firefox source version is independent of its release tag (e.g. V1).
  async function firefoxMetadata(target) {
    const base = `https://api.github.com/repos/${owner}/${target.repo}`;
    const raw = `https://raw.githubusercontent.com/${owner}/${target.repo}/main/manifest.json`;
    const [manifest, history, releaseInfo] = await Promise.allSettled([
      request(raw),
      request(`${base}/commits?sha=main&path=manifest.json&per_page=1`),
      (async () => {
        try { return await releasesFor(target); }
        catch (error) {
          // Some clients cannot list releases; try the latest endpoint separately.
          for (const endpoint of ['latest', 'tags/V1']) {
            try {
              const { data: release } = await request(`${base}/releases/${endpoint}`);
              const asset = !release.draft && !release.prerelease && assetFor(release, target);
              if (asset) return { url: asset.browser_download_url, tag: release.tag_name };
            } catch { /* keep the existing download link if both fail */ }
          }
          console.warn('[X Grid website] firefox release:', error.message);
          return null;
        }
      })()
    ]);
    const source = manifest.status === 'fulfilled' ? manifest.value.data : null;
    const version = semver(source?.version);
    if (!version) throw new Error('Firefox manifest version unavailable');
    const commit = history.status === 'fulfilled' ? history.value.data?.[0]?.commit : null;
    const date = commit?.committer?.date || commit?.author?.date || null;
    const release = releaseInfo.status === 'fulfilled' ? releaseInfo.value : null;
    return { version, date: dateText(date) ? date : null, dateKind: 'source',
      url: release?.url || null, tag: release?.tag || null };
  }
  async function userscript() {
    const { data } = await request('https://greasyfork.org/scripts/591463.json');
    const date = data.code_updated_at || data.created_at;
    if (!data.version || !dateText(date)) throw new Error('Invalid userscript metadata');
    return { version: String(data.version), date, url: 'https://greasyfork.org/en/scripts/591463-x-media-grid-restore', downloads: data.total_installs };
  }
  function readCache(key) {
    try { return JSON.parse(localStorage.getItem(`xgrid-release-sync:${key}`)); } catch { return null; }
  }
  async function cached(key, load) {
    const old = readCache(key);
    if (old?.data && Date.now() >= old.at && Date.now() - old.at < cacheTTL) return { ...old.data, cached: true };
    try {
      const data = await load();
      try { localStorage.setItem(`xgrid-release-sync:${key}`, JSON.stringify({ at: Date.now(), data })); } catch { /* storage optional */ }
      return data;
    } catch (err) {
      console.warn(`[X Grid website] ${key}:`, err.message);
      return old?.data ? { ...old.data, stale: true } : null;
    }
  }
  function anchorFor(key) {
    const explicit = document.querySelector(`[data-download="${key}"]`);
    if (explicit) return explicit;
    const target = targets.find(t => t.key === key);
    return Array.from(document.querySelectorAll('a[href]')).find(a => {
      const href = a.href.toLowerCase();
      return target ? href.startsWith(`${repoUrl(target).toLowerCase()}/releases/download/`) || href.startsWith(`${repoUrl(target).toLowerCase()}/releases/latest/download/`) : /greasyfork\.org\/.*scripts\/591463(?:\D|$)/.test(href);
    });
  }
  function render(key, data) {
    const anchor = anchorFor(key);
    const explicit = document.querySelector(`[data-release-info="${key}"]`);
    if (data?.url && anchor && key !== 'userscript') anchor.href = data.url;
    if (key === 'firefox' && data?.tag) {
      const badge = document.querySelector('.firefox .download-count');
      if (badge && /^[A-Za-z0-9._-]+$/.test(data.tag)) {
        badge.src = `https://img.shields.io/github/downloads/${owner}/x-media-grid-restore-firefox/${encodeURIComponent(data.tag)}/total?style=flat-square&label=Downloads&color=FF7139`;
      }
    }
    if (!explicit && !anchor) return;
    const info = explicit || document.createElement('span');
    info.textContent = data ? `${/^\d/.test(data.version) ? 'v' : ''}${data.version}${data.dateKind === 'source' ? ' (source)' : ''}${dateText(data.date) ? ` · ${dateText(data.date)}` : ''}${data.stale ? ' (last known)' : ''}` : 'Release details unavailable';
    if (key === 'firefox' && data?.dateKind === 'source') info.title = 'Version from main/manifest.json; date of the latest manifest commit, if available. The downloadable XPI may be older.';
    if (!explicit) {
      info.className = 'release-sync-info';
      info.style.cssText = 'display:block;font-size:0.8rem;opacity:0.8;margin:0.4rem 0;';
      anchor.insertAdjacentElement('afterend', info);
    }
  }
  async function init() {
    const heading = document.querySelector('[data-release-summary]') || Array.from(document.querySelectorAll('.eyebrow')).find(el => /version.*updated/i.test(el.textContent));
    if (heading) heading.textContent = 'Checking release information…';
    const keys = [...targets.map(t => t.key), 'userscript'];
    const data = await Promise.all([...targets.map(t => cached(t.key === 'firefox' ? 'firefox-manifest-v2' : t.key, () => t.key === 'firefox' ? firefoxMetadata(t) : releasesFor(t))), cached('userscript', userscript)]);
    keys.forEach((key,i) => render(key,data[i]));
    if (heading) {
      const newest = data.filter(d => d && dateText(d.date)).sort((a,b) => Date.parse(b.date)-Date.parse(a.date))[0];
      const incomplete = data.some(d => !d || d.stale || !dateText(d.date));
      heading.textContent = newest ? `${incomplete ? 'Latest known update' : 'Latest update'} · ${dateText(newest.date)}` : 'Release information unavailable';
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
