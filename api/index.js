// api/index.js
// Addon Stremio pour Internet Archive — avec conversion IMDb -> Archive.org

const manifest = {
  id: 'org.community.archive.streams',
  version: '1.3.0',
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
  // On garde archive: pour le catalogue, et on ajoute tt pour les IDs IMDb
  idPrefixes: ['archive:', 'tt'],
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

// ---------- Conversion IMDb -> Archive.org ----------

async function imdbToArchiveIdentifier(imdbId) {
  // Si c'est déjà un identifiant archive, on le retourne tel quel
  if (imdbId.startsWith('archive:')) {
    return imdbId.replace('archive:', '');
  }

  // Si c'est un ID IMDb (tt...), on cherche le titre via Cinemeta
  if (imdbId.startsWith('tt')) {
    try {
      // 1. Récupérer le titre du film via l'API Cinemeta de Stremio
      const cinemetaUrl = `https://v3-cinemeta.strem.io/meta/movie/${imdbId}.json`;
      const metaRes = await fetch(cinemetaUrl, {
        headers: { 'User-Agent': 'stremio-archive-addon/1.3' }
      });
      if (!metaRes.ok) {
        console.log(`Cinemeta HTTP ${metaRes.status} for ${imdbId}`);
        return null;
      }
      const metaData = await metaRes.json();
      const title = metaData?.meta?.name;
      const year = metaData?.meta?.year;

      if (!title) {
        console.log(`No title found for ${imdbId}`);
        return null;
      }

      console.log(`IMDb ${imdbId} -> Title: "${title}" (${year || '?'})`);

      // 2. Chercher ce titre sur Archive.org (en privilégiant les films)
      // On construit une requête qui cherche le titre exact ou les mots-clés
      const searchTitle = title.replace(/[^\w\s]/g, ' ').trim();
      const q = `title:(${searchTitle}) AND mediatype:movies`;

      const searchUrl = `https://archive.org/advancedsearch.php?` +
        `q=${encodeURIComponent(q)}` +
        `&fl[]=identifier&fl[]=title&fl[]=downloads` +
        `&sort[]=downloads+desc` +
        `&rows=5&output=json`;

      const searchRes = await fetch(searchUrl, {
        headers: { 'User-Agent': 'stremio-archive-addon/1.3' }
      });
      const searchData = await searchRes.json();
      const docs = searchData?.response?.docs || [];

      if (docs.length > 0) {
        // On prend le résultat le plus téléchargé (le plus probable d'être le film)
        const bestMatch = docs[0];
        console.log(`Archive match: ${bestMatch.identifier} ("${bestMatch.title}")`);
        return bestMatch.identifier;
      }

      // Fallback : recherche sans le champ title (plus large)
      const fallbackUrl = `https://archive.org/advancedsearch.php?` +
        `q=${encodeURIComponent(searchTitle)}+AND+mediatype:movies` +
        `&fl[]=identifier&fl[]=downloads&sort[]=downloads+desc&rows=3&output=json`;
      const fbRes = await fetch(fallbackUrl);
      const fbData = await fbRes.json();
      const fbDocs = fbData?.response?.docs || [];
      if (fbDocs.length > 0) {
        console.log(`Archive fallback match: ${fbDocs[0].identifier}`);
        return fbDocs[0].identifier;
      }

    } catch (e) {
      console.error('IMDb conversion error:', e);
    }
  }

  return null;
}

// ---------- Recherche Archive.org (pour le catalogue) ----------

async function fetchSearch(q, page = 1) {
  const url = `https://archive.org/advancedsearch.php?` +
    `q=${encodeURIComponent(q)}` +
    `&fl[]=identifier&fl[]=title&fl[]=year&fl[]=description&fl[]=downloads&fl[]=mediatype` +
    `&sort[]=downloads+desc&rows=30&page=${page}&output=json`;
  const res = await fetch(url, { headers: { 'User-Agent': 'stremio-archive-addon/1.3' } });
  if (!res.ok) throw new Error(`Archive search HTTP ${res.status}`);
  const data = await res.json();
  return data?.response?.docs || [];
}

async function searchArchive(query, skip = 0) {
  const page = Math.floor(skip / 30) + 1;
  const cleanQuery = query.trim();

  let docs = await fetchSearch(`${cleanQuery} AND mediatype:movies`, page);
  if (docs.length === 0) docs = await fetchSearch(cleanQuery, page);
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

// ---------- Streams ----------

async function getStreams(identifier) {
  // Convertir l'ID si nécessaire (IMDb -> Archive.org)
  const cleanId = await imdbToArchiveIdentifier(identifier);
  if (!cleanId) {
    console.log(`No Archive.org match for: ${identifier}`);
    return [];
  }

  const metaUrl = `https://archive.org/metadata/${cleanId}`;
  const res = await fetch(metaUrl, { headers: { 'User-Agent': 'stremio-archive-addon/1.3' } });
  if (!res.ok) return [];
  const data = await res.json();
  const files = data?.files || [];

  // Filtrage : uniquement les vidéos exploitables
  const videos = files.filter((f) => {
    const name = (f.name || '').toLowerCase();
    const fmt = (f.format || '').toLowerCase();
    if (!name.endsWith('.mp4') && !name.endsWith('.mkv') && !name.endsWith('.ogv')) return false;
    if (/\.(ia|thumbs|spectrogram|png|jpg|gif|jpeg)$/i.test(name)) return false;
    if (fmt.includes('thumb') || fmt.includes('image')) return false;
    if (Number(f.size || 0) < 20 * 1024 * 1024) return false; // < 20 MB
    return true;
  });

  // Fallback si trop strict
  if (videos.length === 0) {
    files.forEach((f) => {
      const name = (f.name || '').toLowerCase();
      if (name.endsWith('.mp4') || name.endsWith('.mkv') || name.endsWith('.ogv')) {
        videos.push(f);
      }
    });
  }

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
      behaviorHints: { notWebReady: false, bingeGroup: `archive-${cleanId}` }
    };
  });
}

// ---------- Handlers ----------

async function handleCatalog(type, id, extra, res) {
  const search = extra.search || '';
  const skip = parseInt(extra.skip || '0', 10) || 0;
  if (!search) return res.status(200).json({ metas: [] });
  try {
    const metas = await searchArchive(search, skip);
    console.log(`Catalog search "${search}" -> ${metas.length}`);
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

// ---------- Routeur ----------

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = new URL(req.url, `${proto}://${host}`);
  const path = url.pathname;

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
