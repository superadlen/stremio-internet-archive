// api/index.js
// Addon Stremio pour Internet Archive — déployable sur Vercel

const manifest = {
  id: 'org.community.archive.streams',
  version: '1.1.0',
  name: 'Archive.org Streams',
  description: 'Stream public domain & archived movies from Internet Archive',
  logo: 'https://archive.org/services/img/InternetArchive',
  resources: ['catalog', 'stream'],
  types: ['movie'],
  catalogs: [
    {
      type: 'movie',
      id: 'archive_search',
      name: 'Archive.org Search',
      extra: [
        { name: 'search', isRequired: true },
        { name: 'skip', isRequired: false }
      ]
    }
  ],
  idPrefixes: ['archive:'],
  behaviorHints: {
    adult: false,
    p2p: false
  }
};

// ---------- Utilitaires ----------

function humanSize(bytes) {
  if (!bytes) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = Number(bytes);
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
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

// ---------- Recherche Archive.org ----------

async function searchArchive(query, skip = 0) {
  // On cherche dans les films ; on élargit la requête pour matcher titre + description
  const q = `(title:(${query}) OR description:(${query})) AND mediatype:movies`;
  const url =
    `https://archive.org/advancedsearch.php?` +
    `q=${encodeURIComponent(q)}` +
    `&fl[]=identifier&fl[]=title&fl[]=year&fl[]=description&fl[]=downloads` +
    `&sort[]=downloads+desc` +
    `&rows=30&page=${Math.floor(skip / 30) + 1}` +
    `&output=json`;

  const res = await fetch(url, { headers: { 'User-Agent': 'stremio-archive-addon/1.1' } });
  if (!res.ok) throw new Error(`Archive search failed: ${res.status}`);
  const data = await res.json();
  const docs = data?.response?.docs || [];

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

// ---------- Streams pour un item ----------

async function getStreams(identifier) {
  const cleanId = identifier.replace(/^archive:/, '');
  const metaUrl = `https://archive.org/metadata/${cleanId}`;
  const res = await fetch(metaUrl, { headers: { 'User-Agent': 'stremio-archive-addon/1.1' } });
  if (!res.ok) return [];
  const data = await res.json();
  const files = data?.files || [];

  // On garde uniquement les vidéos MP4 exploitables en streaming direct
  const videos = files.filter((f) => {
    const name = (f.name || '').toLowerCase();
    const fmt = (f.format || '').toLowerCase();
    if (!name.endsWith('.mp4')) return false;
    if (/\.(ia|thumbs|spectrogram|png|jpg|gif)$/i.test(name)) return false;
    if (fmt.includes('thumb') || fmt.includes('image')) return false;
    return true;
  });

  // Tri par qualité décroissante puis taille décroissante
  videos.sort((a, b) => {
    const qa = QUALITY_RANK[extractQuality(a.name, a.format)];
    const qb = QUALITY_RANK[extractQuality(b.name, b.format)];
    if (qb !== qa) return qb - qa;
    return Number(b.size || 0) - Number(a.size || 0);
  });

  const streams = videos.map((file) => {
    const quality = extractQuality(file.name, file.format);
    const size = humanSize(file.size);
    const url = `https://archive.org/download/${cleanId}/${encodeURIComponent(file.name)}`;

    return {
      url,
      name: 'Archive.org',
      title: `▶ ${quality.toUpperCase()} · ${size}\n${file.name}`,
      behaviorHints: {
        notWebReady: false,
        bingeGroup: `archive-${cleanId}`
      }
    };
  });

  return streams;
}

// ---------- Handlers ----------

async function handleCatalog(type, id, extra, res) {
  const search = extra.search || '';
  const skip = parseInt(extra.skip || '0', 10) || 0;

  if (!search) {
    return res.status(200).json({ metas: [] });
  }

  try {
    const metas = await searchArchive(search, skip);
    return res.status(200).json({ metas });
  } catch (err) {
    console.error('Catalog error:', err);
    return res.status(500).json({ metas: [], err: String(err) });
  }
}

async function handleStream(type, id, res) {
  try {
    const streams = await getStreams(id);
    return res.status(200).json({ streams });
  } catch (err) {
    console.error('Stream error:', err);
    return res.status(500).json({ streams: [], err: String(err) });
  }
}

// ---------- Routeur principal ----------

export default async function handler(req, res) {
  // CORS (utile si tu ouvres l'addon dans un navigateur)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = new URL(req.url, `${proto}://${host}`);
  const path = url.pathname;

  // Manifest
  if (path.endsWith('/manifest.json') || path === '/') {
    return res.status(200).json(manifest);
  }

  // Catalog : /catalog/{type}/{id}/{extra}.json
  if (path.includes('/catalog/')) {
    const parts = path.split('/').filter(Boolean); // [catalog, movie, archive_search, extra.json]
    const type = parts[1];
    const id = parts[2];
    const extraPart = parts[3] || '';

    // Extra peut être "search=Twilight.json" ou "search=Twilight&skip=30.json"
    const extraStr = extraPart.replace(/\.json$/, '');
    const extra = {};
    new URLSearchParams(extraStr).forEach((v, k) => (extra[k] = v));

    return handleCatalog(type, id, extra, res);
  }

  // Stream : /stream/{type}/{id}.json
  if (path.includes('/stream/')) {
    const parts = path.split('/').filter(Boolean); // [stream, movie, archive:xxx.json]
    const id = decodeURIComponent((parts[2] || '').replace(/\.json$/, ''));
    return handleStream(parts[1], id, res);
  }

  return res.status(404).json({ err: 'not found', path });
}
