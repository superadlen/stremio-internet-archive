// api/index.js
// Addon Stremio pour Internet Archive — version optimisée (timeouts + recherche large)

const manifest = {
  id: 'org.community.archive.streams',
  version: '1.5.0',
  name: 'Archive.org Streams',
  description: 'Stream public domain & archived movies from Internet Archive',
  logo: 'https://archive.org/services/img/InternetArchive',
  resources: ['catalog', 'stream'],
  types: ['movie'],
  catalogs: [{
    type: 'movie',
    id: 'archive_search',
    name: 'Archive.org Search',
    extra: [{ name: 'search', isRequired: true }, { name: 'skip', isRequired: false }]
  }],
  idPrefixes: ['archive:', 'tt'],
  behaviorHints: { adult: false, p2p: false }
};

// ---------- Utilitaires ----------

function humanSize(bytes) {
  if (!bytes) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = Number(bytes);
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

function extractQuality(filename = '', format = '') {
  const text = `${filename} ${format}`.toLowerCase();
  if (/(1080p|1080|fullhd|full hd)/.test(text)) return '1080p';
  if (/(720p|720|hd)/.test(text)) return '720p';
  if (/(480p|480|sd)/.test(text)) return '480p';
  if (/(360p|360)/.test(text)) return '360p';
  return 'unknown';
}

const QUALITY_RANK = { '1080p': 4, '720p': 3, '480p': 2, '360p': 1, unknown: 0 };

// ---------- Fetch avec timeout (crucial pour Vercel) ----------

async function fetchWithTimeout(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'stremio-archive-addon/1.5' }
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Recherche Archive.org (large, sans title:) ----------

async function fetchSearch(q, page = 1) {
  const url = `https://archive.org/advancedsearch.php?` +
    `q=${encodeURIComponent(q)}` +
    `&fl[]=identifier&fl[]=title&fl[]=year&fl[]=description&fl[]=downloads&fl[]=mediatype` +
    `&sort[]=downloads+desc&rows=20&page=${page}&output=json`;
  const res = await fetchWithTimeout(url, 6000);
  if (!res.ok) throw new Error(`Archive search HTTP ${res.status}`);
  const data = await res.json();
  return data?.response?.docs || [];
}

async function searchArchive(query, skip = 0) {
  const page = Math.floor(skip / 20) + 1;
  const q = query.trim();
  if (!q) return [];

  // Stratégie 1 : requête simple (Archive.org gère bien le texte libre)
  let docs = [];
  try {
    docs = await fetchSearch(`${q} AND mediatype:movies`, page);
  } catch (e) {
    console.log('Search 1 failed:', e.message);
  }

  // Stratégie 2 : sans filtre movies
  if (docs.length === 0) {
    try {
      docs = await fetchSearch(q, page);
    } catch (e) {
      console.log('Search 2 failed:', e.message);
    }
  }

  // Stratégie 3 : mots séparés en OR
  if (docs.length === 0) {
    const words = q.split(/\s+/).filter(w => w.length > 2);
    if (words.length > 1) {
      try {
        const orQuery = words.map(w => `${w}`).join(' OR ');
        docs = await fetchSearch(`(${orQuery}) AND mediatype:movies`, page);
      } catch (e) {
        console.log('Search 3 failed:', e.message);
      }
    }
  }

  return docs.map((doc) => ({
    id: `archive:${doc.identifier}`,
    type: 'movie',
    name: doc.title || doc.identifier,
    poster: `https://archive.org/services/img/${doc.identifier}`,
    description: (doc.description || '').toString().slice(0, 300) || `Archive.org item: ${doc.identifier}`,
    releaseInfo: doc.year ? String(doc.year) : undefined,
    background: `https://archive.org/services/img/${doc.identifier}`
  }));
}

// ---------- Conversion IMDb -> Archive ----------

async function getExpectedTitle(identifier) {
  if (!identifier.startsWith('tt')) return '';
  try {
    const res = await fetchWithTimeout(`https://v3-cinemeta.strem.io/meta/movie/${identifier}.json`, 4000);
    if (!res.ok) return '';
    const data = await res.json();
    return data?.meta?.name || '';
  } catch (e) {
    console.log('Cinemeta failed:', e.message);
    return '';
  }
}

async function imdbToArchiveIdentifier(imdbId) {
  if (imdbId.startsWith('archive:')) return imdbId.replace('archive:', '');
  if (!imdbId.startsWith('tt')) return null;

  const title = await getExpectedTitle(imdbId);
  if (!title) return null;

  const cleanTitle = title.replace(/[^\w\s]/g, ' ').trim();
  console.log(`IMDb ${imdbId} -> "${cleanTitle}"`);

  // Recherche large : le titre + movies
  try {
    const docs = await fetchSearch(`${cleanTitle} AND mediatype:movies`, 1);
    if (docs.length > 0) return docs[0].identifier;
  } catch (e) {
    console.log('Archive search (title) failed:', e.message);
  }

  // Fallback : juste le titre
  try {
    const docs = await fetchSearch(cleanTitle, 1);
    if (docs.length > 0) return docs[0].identifier;
  } catch (e) {
    console.log('Archive search (fallback) failed:', e.message);
  }

  return null;
}

// ---------- Streams ----------

async function getStreams(identifier, expectedTitle = '') {
  const cleanId = await imdbToArchiveIdentifier(identifier);
  if (!cleanId) {
    console.log(`No Archive match for ${identifier}`);
    return [];
  }

  let data;
  try {
    const res = await fetchWithTimeout(`https://archive.org/metadata/${cleanId}`, 6000);
    if (!res.ok) return [];
    data = await res.json();
  } catch (e) {
    console.log('Metadata fetch failed:', e.message);
    return [];
  }

  const files = data?.files || [];
  const keywords = expectedTitle
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);

  // Filtre principal : .mp4 uniquement, mots-clés du titre, taille > 100 MB
  let videos = files.filter((f) => {
    const name = (f.name || '').toLowerCase();
    if (!name.endsWith('.mp4')) return false;
    if (keywords.length > 0 && !keywords.some(kw => name.includes(kw))) return false;
    if (Number(f.size || 0) < 100 * 1024 * 1024) return false;
    return true;
  });

  // Fallback : si le filtre a tout supprimé, on prend tous les .mp4 > 100 MB
  if (videos.length === 0) {
    videos = files.filter((f) => {
      const name = (f.name || '').toLowerCase();
      return name.endsWith('.mp4') && Number(f.size || 0) > 100 * 1024 * 1024;
    });
  }

  // Dernier recours : tous les .mp4, quelle que soit la taille
  if (videos.length === 0) {
    videos = files.filter((f) => (f.name || '').toLowerCase().endsWith('.mp4'));
  }

  videos.sort((a, b) => {
    const qa = QUALITY_RANK[extractQuality(a.name, a.format)];
    const qb = QUALITY_RANK[extractQuality(b.name, b.format)];
    if (qb !== qa) return qb - qa;
    return Number(b.size || 0) - Number(a.size || 0);
  });

  return videos.map((file) => ({
    url: `https://archive.org/download/${cleanId}/${encodeURIComponent(file.name)}`,
    name: 'Archive.org',
    title: `▶ ${extractQuality(file.name, file.format).toUpperCase()} · ${humanSize(file.size)}\n${file.name}`,
    behaviorHints: { notWebReady: false, bingeGroup: `archive-${cleanId}` }
  }));
}

// ---------- Handlers ----------

async function handleCatalog(type, id, extra, res) {
  const search = extra.search || '';
  const skip = parseInt(extra.skip || '0', 10) || 0;
  if (!search) return res.status(200).json({ metas: [] });
  try {
    const metas = await searchArchive(search, skip);
    console.log(`Catalog "${search}" -> ${metas.length}`);
    return res.status(200).json({ metas });
  } catch (err) {
    console.error('Catalog error:', err);
    return res.status(200).json({ metas: [] });
  }
}

async function handleStream(type, id, res) {
  try {
    const expectedTitle = await getExpectedTitle(id);
    const streams = await getStreams(id, expectedTitle);
    console.log(`Streams "${id}" -> ${streams.length}`);
    return res.status(200).json({ streams });
  } catch (err) {
    console.error('Stream error:', err);
    return res.status(200).json({ streams: [] });
  }
}

// ---------- Routeur : manifeste renvoyé IMMÉDIATEMENT ----------

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = new URL(req.url, `${proto}://${host}`);
  const path = url.pathname;

  // ⚠️ Manifeste : réponse immédiate, AUCUN await avant
  if (path.endsWith('/manifest.json') || path === '/') {
    return res.status(200).json(manifest);
  }

  if (path.includes('/catalog/')) {
    const parts = path.split('/').filter(Boolean);
    const extraStr = (parts[3] || '').replace(/\.json$/, '');
    const extra = {};
    new URLSearchParams(extraStr).forEach((v, k) => (extra[k] = v));
    return handleCatalog(parts[1], parts[2], extra, res);
  }

  if (path.includes('/stream/')) {
    const parts = path.split('/').filter(Boolean);
    const id = decodeURIComponent((parts[2] || '').replace(/\.json$/, ''));
    return handleStream(parts[1], id, res);
  }

  return res.status(404).json({ err: 'not found', path });
}
