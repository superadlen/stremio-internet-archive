const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const axios = require("axios");
const path = require("path");

const builder = new addonBuilder({
    id: "org.internetarchive.movies",
    version: "1.3.0", // Passage à la version 1.3.0
    name: "Internet Archive Movies",
    description: "Recherche et diffuse des films du domaine public et archives depuis Internet Archive.",
    resources: ["catalog", "stream"],
    types: ["movie"],
    catalogs: [
        {
            type: "movie",
            id: "ia_movies",
            name: "Internet Archive",
            extra: [{ name: "search", isRequired: false }]
        }
    ],
    idPrefixes: ["ia:", "tt"]
});

// Fonction utilitaire pour nettoyer et filtrer les flux vidéo (Évite les bandes-annonces et mini-clips)
async function getStreamsFromIA(identifier) {
    try {
        const metadataUrl = `https://archive.org/metadata/${identifier}`;
        const response = await axios.get(metadataUrl);
        const files = response.data.files || [];

        // Filtrer les fichiers vidéo valides et écarter les trailers/clips/samples
        const videoFiles = files.filter(f => {
            if (!f.name) return false;
            const lowerName = f.name.toLowerCase();
            
            // Extensions acceptées
            const isVideoExt = lowerName.endsWith(".mp4") || lowerName.endsWith(".mkv") || lowerName.endsWith(".ogv");
            
            // Exclure les mots clés indésirables (bandes-annonces, extraits, etc.)
            const isJunk = lowerName.includes("trailer") || 
                          lowerName.includes("sample") || 
                          lowerName.includes("teaser") || 
                          lowerName.includes("clip") ||
                          lowerName.includes("advertisement");

            return isVideoExt && !isJunk;
        });

        // Trier par taille de fichier décroissante (le film complet est généralement le plus gros fichier)
        videoFiles.sort((a, b) => (b.size || 0) - (a.size || 0));

        // Ne garder que les 2 meilleures sources pour ne pas polluer l'interface
        return videoFiles.slice(0, 2).map(file => ({
            name: "Internet Archive",
            title: `${file.name} (${Math.round((file.size || 0) / (1024 * 1024))} Mo)`,
            url: `https://archive.org/download/${identifier}/${encodeURIComponent(file.name)}`
        }));
    } catch (error) {
        return [];
    }
}

// Gestion du catalogue et de la recherche
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
        let searchQuery = "mediatype:(movies)";
        
        if (extra && extra.search) {
            searchQuery += ` AND title:(${extra.search})`;
        } else {
            searchQuery += " AND collection:(feature_films)";
        }

        const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(searchQuery)}&fl[]=identifier,title,description,year&sort[]=downloads+desc&rows=30&output=json`;
        const response = await axios.get(url);
        const docs = response.data.response.docs || [];

        const metas = docs.map(doc => ({
            id: `ia:${doc.identifier}`,
            type: "movie",
            name: Array.isArray(doc.title) ? doc.title[0] : (doc.title || "Titre inconnu"),
            description: Array.isArray(doc.description) ? doc.description[0] : (doc.description || "Aucune description disponible."),
            releaseInfo: doc.year ? String(doc.year) : undefined,
            poster: `https://archive.org/services/img/${doc.identifier}`
        }));

        return { metas };
    } catch (error) {
        console.error("Erreur catalogue:", error.message);
        return { metas: [] };
    }
});

// Gestion des flux vidéo (Stream)
builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== "movie") {
        return { streams: [] };
    }

    if (id.startsWith("ia:")) {
        const identifier = id.replace("ia:", "");
        const streams = await getStreamsFromIA(identifier);
        return { streams };
    }

    if (id.startsWith("tt")) {
        try {
            const cinemetaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${id}.json`);
            const movieMeta = cinemetaRes.data && cinemetaRes.data.meta;

            if (!movieMeta || !movieMeta.name) {
                return { streams: [] };
            }

            const searchQuery = `mediatype:(movies) AND title:("${movieMeta.name}")`;
            const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(searchQuery)}&fl[]=identifier&sort[]=downloads+desc&rows=2&output=json`;
            const searchRes = await axios.get(searchUrl);
            const docs = searchRes.data.response.docs || [];

            let allStreams = [];
            for (const doc of docs) {
                const streams = await getStreamsFromIA(doc.identifier);
                allStreams = allStreams.concat(streams);
            }

            return { streams: allStreams };
        } catch (error) {
            console.error("Erreur recherche IMDb -> IA:", error.message);
            return { streams: [] };
        }
    }

    return { streams: [] };
});

// Configuration Express
const app = express();
app.use(express.static(path.join(__dirname, "../public")));

const addonInterface = builder.getInterface();
app.use(getRouter(addonInterface));

module.exports = app;
