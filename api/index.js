// api/index.js
// Addon Stremio pour Internet Archive — avec filtre anti-fichiers parasites

const manifest = {
  id: 'org.community.archive.streams',
  version: '1.4.0',
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

function humanSize(bytes) { /* ... inchangé ... */ }
function extractQuality(filename = '', format = '') { /* ... inchangé ... */ }
const QUALITY_RANK = { '1080p': 4, '720p': 3, '480p': 2, '360p': 1, unknown: 0 };

// --- Récupère le titre depuis IMDb pour filtrer ---
async function getExpectedTitle(identifier) {
  if (identifier.startsWith('tt')) {
    try {
      const res = await fetch(`https://v3-cinemeta.strem.io/meta/movie/${identifier}.json`);
      const data = await res.json();
      return data?.meta?.name || '';
    } catch (e) { return ''; }
  }
  return '';
}

// --- Conversion IMDb -> Archive (inchangée, mais on log le titre) ---
async function imdbToArchiveIdentifier(imdbId) {
  if (imdbId.startsWith('archive:')) return imdbId.replace('archive:', '');
  if (imdbId.startsWith('tt')) {
    try {
      const metaRes = await fetch(`https://v3-cinemeta.strem.io/meta/movie/${imdbId}.json`);
      if (!metaRes.ok) return null;
      const metaData = await metaRes.json();
      const title = metaData?.meta?.name;
      if (!title) return null;
      const searchTitle = title.replace(/[^\w\s]/g, ' ').trim();
      const q = `title:(${searchTitle}) AND mediatype:movies`;
      const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=downloads&sort[]=downloads+desc&rows=5&output=json`;
      const searchRes = await fetch(searchUrl);
      const searchData = await searchRes.json();
      const docs = searchData?.response?.docs || [];
      if (docs.length > 0) return docs[0].identifier;
      const fbUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(searchTitle)}+AND+mediatype:movies&fl[]=identifier&fl[]=downloads&sort[]=downloads+desc&rows=3&output=json`;
      const fbRes = await fetch(fbUrl);
      const fbData = await fbRes.json();
      if (fbData?.response?.docs?.length > 0) return fbData.response.docs[0].identifier;
    } catch (e) { console.error(e); }
  }
  return null;
}

// --- Recherche catalogue (inchangée) ---
async function searchArchive(query, skip = 0) { /* ... inchangé ... */ }

// --- MODIFICATION CLÉ : getStreams avec filtre ---
async function getStreams(identifier, expectedTitle = '') {
  const cleanId = await imdbToArchiveIdentifier(identifier);
  if (!cleanId) return [];

  const metaUrl = `https://archive.org/metadata/${cleanId}`;
  const res = await fetch(metaUrl);
  if (!res.ok) return [];
  const data = await res.json();
  const files = data?.files || [];

  // --- FILTRE ANTI-PARASITES ---
  const keywords = expectedTitle
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3); // ignore "the", "and", etc.

  const videos = files.filter((f) => {
    const name = (f.name || '').toLowerCase();
    // 1. Uniquement les .mp4 (on ignore les .ogv qui sont des doublons)
    if (!name.endsWith('.mp4')) return false;
    // 2. Le nom doit contenir au moins un mot-clé du titre (si on a un titre)
    if (keywords.length > 0 && !keywords.some(kw => name.includes(kw))) return false;
    // 3. Taille minimale de 100 MB (un film complet fait bien plus)
    if (Number(f.size || 0) < 100 * 1024 * 1024) return false;
    return true;
  });

  // Si le filtre a tout supprimé (ex: le titre ne correspond pas au nom du fichier),
  // on retombe sur les .mp4 de plus de 100 MB sans filtre de mots-clés
  if (videos.length === 0) {
    files.forEach((f) => {
      const name = (f.name || '').toLowerCase();
      if (name.endsWith('.mp4') && Number(f.size || 0) > 100 * 1024 * 1024) {
        videos.push(f);
      }
    });
  }
  // --- FIN FILTRE ---

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

// --- Handlers avec passage du titre ---
async function handleCatalog(type, id, extra, res) { /* ... inchangé ... */ }

async function handleStream(type, id, res) {
  try {
    const expectedTitle = await getExpectedTitle(id);
    const streams = await getStreams(id, expectedTitle);
    console.log(`Streams for "${id}" (title: "${expectedTitle}") -> ${streams.length}`);
    return res.status(200).json({ streams });
  } catch (err) {
    return res.status(200).json({ streams: [], err: String(err) });
  }
}

// --- Routeur (inchangé) ---
export default async function handler(req, res) { /* ... inchangé ... */ }
