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
    return { version: version || release.tag_name, date: release.published_at, url: asset.browser_download_url, downloads };
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
    if (data && anchor && key !== 'userscript') anchor.href = data.url;
    if (!explicit && !anchor) return;
    const info = explicit || document.createElement('span');
    info.textContent = data ? `${/^\d/.test(data.version) ? 'v' : ''}${data.version} · ${dateText(data.date)}${data.stale ? ' (last known)' : ''}` : 'Release details unavailable';
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
    const data = await Promise.all([...targets.map(t => cached(t.key, () => releasesFor(t))), cached('userscript', userscript)]);
    keys.forEach((key,i) => render(key,data[i]));
    if (heading) {
      const newest = data.filter(Boolean).sort((a,b) => Date.parse(b.date)-Date.parse(a.date))[0];
      const incomplete = data.some(d => !d || d.stale);
      heading.textContent = newest ? `${incomplete ? 'Latest known update' : 'Latest update'} · ${dateText(newest.date)}` : 'Release information unavailable';
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
