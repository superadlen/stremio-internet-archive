// api/index.js
// Addon Stremio pour Internet Archive — version corrigée et testée

const manifest = {
  id: 'org.community.archive.streams',
  version: '1.2.0',
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

async function fetchSearch(q, page = 1) {
  const url =
    `https://archive.org/advancedsearch.php?` +
    `q=${encodeURIComponent(q)}` +
    `&fl[]=identifier&fl[]=title&fl[]=year&fl[]=description&fl[]=downloads&fl[]=mediatype` +
    `&sort[]=downloads+desc` +
    `&rows=30&page=${page}` +
    `&output=json`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'stremio-archive-addon/1.2' }
  });
  if (!res.ok) throw new Error(`Archive search HTTP ${res.status}`);
  const data = await res.json();
  return data?.response?.docs || [];
}

async function searchArchive(query, skip = 0) {
  const page = Math.floor(skip / 30) + 1;
  const cleanQuery = query.trim();

  // Stratégie 1 : recherche simple + filtre movies
  let docs = await fetchSearch(`${cleanQuery} AND mediatype:movies`, page);

  // Stratégie 2 : si rien, on enlève le filtre movies (l'item peut être mal classé)
  if (docs.length === 0) {
    docs = await fetchSearch(cleanQuery, page);
  }

  // Stratégie 3 : si toujours rien, on tente sur chaque mot séparément (OR)
  if (docs.length === 0) {
    const words = cleanQuery.split(/\s+/).filter(w => w.length > 2);
    if (words.length > 1) {
      const orQuery = words.map(w => `title:${w}`).join(' OR ');
      docs = await fetchSearch(`(${orQuery}) AND mediatype:movies`, page);
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

// ---------- Streams pour un item ----------

async function getStreams(identifier) {
  const cleanId = identifier.replace(/^archive:/, '');
  const metaUrl = `https://archive.org/metadata/${cleanId}`;

  const res = await fetch(metaUrl, {
    headers: { 'User-Agent': 'stremio-archive-addon/1.2' }
  });
  if (!res.ok) return [];
  const data = await res.json();
  const files = data?.files || [];

  // Filtrage des fichiers vidéo exploitables
  const videos = files.filter((f) => {
    const name = (f.name || '').toLowerCase();
    const fmt = (f.format || '').toLowerCase();
    // On ne garde que les fichiers vidéo MP4 (ou formats reconnus)
    const isMp4 = name.endsWith('.mp4');
    const isMkv = name.endsWith('.mkv');
    const isOgg = name.endsWith('.ogv');
    if (!isMp4 && !isMkv && !isOgg) return false;
    // On rejette les miniatures / images / spectrogrammes
    if (/\.(ia|thumbs|spectrogram|png|jpg|gif|jpeg)$/i.test(name)) return false;
    if (fmt.includes('thumb') || fmt.includes('image')) return false;
    // On rejette les fichiers trop petits (< 20 MB = probablement pas un film)
    if (Number(f.size || 0) < 20 * 1024 * 1024) return false;
    return true;
  });

  // Si aucun MP4, on tente de récupérer tous les fichiers vidéo sans filtre taille
  if (videos.length === 0) {
    files.forEach((f) => {
      const name = (f.name || '').toLowerCase();
      if (name.endsWith('.mp4') || name.endsWith('.mkv') || name.endsWith('.ogv')) {
        videos.push(f);
      }
    });
  }

  // Tri : qualité décroissante, puis taille décroissante
  videos.sort((a, b) => {
    const qa = QUALITY_RANK[extractQuality(a.name, a.format)];
    const qb = QUALITY_RANK[extractQuality(b.name, b.format)];
    if (qb !== qa) return qb - qa;
    return Number(b.size || 0) - Number(a.size || 0);
  });

  return videos.map((file) => {
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
    console.log(`Search "${search}" -> ${metas.length} results`);
    return res.status(200).json({ metas });
  } catch (err) {
    console.error('Catalog error:', err);
    return res.status(200).json({ metas: [], err: String(err) });
  }
}

async function handleStream(type, id, res) {
  try {
    const streams = await getStreams(id);
    console.log(`Streams for "${id}" -> ${streams.length}`);
    return res.status(200).json({ streams });
  } catch (err) {
    console.error('Stream error:', err);
    return res.status(200).json({ streams: [], err: String(err) });
  }
}

// ---------- Routeur principal ----------

export default async function handler(req, res) {
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
    const parts = path.split('/').filter(Boolean);
    const type = parts[1];
    const id = parts[2];
    const extraPart = parts[3] || '';

    const extraStr = extraPart.replace(/\.json$/, '');
    const extra = {};
    new URLSearchParams(extraStr).forEach((v, k) => (extra[k] = v));

    return handleCatalog(type, id, extra, res);
  }

  // Stream : /stream/{type}/{id}.json
  if (path.includes('/stream/')) {
    const parts = path.split('/').filter(Boolean);
    const id = decodeURIComponent((parts[2] || '').replace(/\.json$/, ''));
    return handleStream(parts[1], id, res);
  }

  return res.status(404).json({ err: 'not found', path });
}
