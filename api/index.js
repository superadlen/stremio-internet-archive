const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const axios = require("axios");
const path = require("path");

const builder = new addonBuilder({
    id: "org.internetarchive.movies",
    version: "1.4.0", // Passage à la version 1.4.0
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

// Fonction utilitaire pour nettoyer, filtrer et formater les flux vidéo comme l'exemple
async function getStreamsFromIA(identifier) {
    try {
        const metadataUrl = `https://archive.org/metadata/${identifier}`;
        const response = await axios.get(metadataUrl);
        const files = response.data.files || [];

        // Filtrer les fichiers vidéo valides
        const videoFiles = files.filter(f => {
            if (!f.name) return false;
            const lowerName = f.name.toLowerCase();
            
            // Extensions acceptées
            const isVideoExt = lowerName.endsWith(".mp4") || lowerName.endsWith(".mkv") || lowerName.endsWith(".ogv") || lowerName.endsWith(".avi");
            
            // Exclure les mots clés indésirables (bandes-annonces, extraits, etc.)
            const isJunk = lowerName.includes("trailer") || 
                          lowerName.includes("sample") || 
                          lowerName.includes("teaser") || 
                          lowerName.includes("clip") ||
                          lowerName.includes("advertisement") ||
                          lowerName.includes("subtitles");

            // Règle cruciale : Exclure tout fichier de moins de 50 Mo (élimine les 2 Mo et les mini-clips)
            const fileSize = f.size || 0;
            const isTooSmall = fileSize < 50 * 1024 * 1024; // 50 Mo minimum

            return isVideoExt && !isJunk && !isTooSmall;
        });

        // Trier par taille de fichier décroissante (le film complet le plus lourd en premier)
        videoFiles.sort((a, b) => (b.size || 0) - (a.size || 0));

        // Formater les flux pour imiter le style professionnel des meilleurs add-ons
        return videoFiles.map(file => {
            const sizeGB = (file.size / (1024 * 1024 * 1024)).toFixed(1);
            const sizeDisplay = sizeGB >= 1 ? `${sizeGB} GB` : `${Math.round(file.size / (1024 * 1024))} MB`;
            const ext = file.name.split('.').pop().toUpperCase();
            
            // Détection basique de la qualité dans le nom
            let quality = "720p / 1080p";
            const lower = file.name.toLowerCase();
            if (lower.includes("1080p")) quality = "1080p";
            else if (lower.includes("720p")) quality = "720p";
            else if (lower.includes("480p") || lower.includes("dvd")) quality = "480p";

            return {
                name: "🏛 Archive\n〈Full Movie〉",
                title: `✎ ${file.name}\n◈ ${sizeDisplay} · ${ext}\n◆ ${quality}`,
                url: `https://archive.org/download/${identifier}/${encodeURIComponent(file.name)}`
            };
        });
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
