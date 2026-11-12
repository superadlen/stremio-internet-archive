// api/index.js
// Déploiement sur Vercel : ce fichier devient une fonction serverless.

// Configuration du manifest de l'addon
const manifest = {
    id: 'org.community.archive.streams',
    version: '1.0.0',
    name: 'Archive.org Streams',
    description: 'Stream public domain movies from Internet Archive',
    resources: ['catalog', 'stream'],
    types: ['movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'archive_search',
            name: 'Archive.org',
            // On active la recherche par nom pour que Stremio puisse chercher
            extra: [{ name: 'search', isRequired: true }],
        },
    ],
    idPrefixes: ['archive:'],
};

// Fonction utilitaire pour rechercher sur Archive.org
async function searchArchive(query) {
    // On cherche des films (mediatype:movies) qui contiennent le mot clé
    const url = `https://archive.org/advancedsearch.php?q=title:(${encodeURIComponent(query)})+AND+mediatype:movies&fl[]=identifier&fl[]=title&rows=20&output=json`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (!data.response || !data.response.docs) return [];
    
    return data.response.docs.map(doc => ({
        id: `archive:${doc.identifier}`,
        type: 'movie',
        name: doc.title || doc.identifier,
        poster: `https://archive.org/services/img/${doc.identifier}`,
        description: `Source: ${doc.identifier}`,
    }));
}

// Fonction pour récupérer les liens de streaming d'un item
async function getStreams(identifier) {
    const cleanId = identifier.replace('archive:', '');
    const metaUrl = `https://archive.org/metadata/${cleanId}`;
    const response = await fetch(metaUrl);
    const data = await response.json();
    
    if (!data.files) return [];
    
    // On filtre les fichiers vidéo (mp4)
    const videoFiles = data.files.filter(file => 
        file.name.endsWith('.mp4') || file.format === 'h.264'
    );
    
    return videoFiles.map(file => ({
        // L'URL de téléchargement direct suit le format /download/{id}/{filename}
        url: `https://archive.org/download/${cleanId}/${encodeURIComponent(file.name)}`,
        title: `${file.name} (${file.format || 'MP4'})`,
        // Indiquer que le fichier n'est pas forcément web-ready (optionnel)
        behaviorHints: {
            notWebReady: false,
        },
    }));
}

// Gestionnaire principal (Web Standard Request -> Response)
export default async function handler(req, res) {
    // Extraire le chemin de la requête (ex: /catalog/movie/archive_search/search=Twilight.json)
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    
    // Route pour le manifest
    if (path.endsWith('/manifest.json')) {
        return res.status(200).json(manifest);
    }
    
    // Route pour le catalogue (recherche)
    if (path.includes('/catalog/')) {
        // Récupérer le paramètre de recherche depuis l'URL
        const searchParams = new URLSearchParams(url.search);
        const searchQuery = searchParams.get('search') || url.pathname.split('/').pop().replace('.json', '');
        
        if (!searchQuery) {
            return res.status(200).json({ metas: [] });
        }
        
        const metas = await searchArchive(searchQuery);
        return res.status(200).json({ metas });
    }
    
    // Route pour les streams
    if (path.includes('/stream/')) {
        // L'ID est le dernier segment (ex: archive:identifier.json)
        const idPart = path.split('/').pop().replace('.json', '');
        const streams = await getStreams(idPart);
        return res.status(200).json({ streams });
    }
    
    // Par défaut, 404
    return res.status(404).json({ error: 'Not found' });
}
