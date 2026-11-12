const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const axios = require("axios");
const path = require("path");

const builder = new addonBuilder({
    id: "org.internetarchive.movies",
    version: "1.6.0", // Passage à la version 1.6.0
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

// Fonction utilitaire pour nettoyer, filtrer et formater les flux vidéo
async function getStreamsFromIA(identifier, itemTitle = "") {
    try {
        const metadataUrl = `https://archive.org/metadata/${identifier}`;
        const response = await axios.get(metadataUrl);
        const files = response.data.files || [];
        const archiveTitle = itemTitle || response.data.metadata?.title || identifier;

        const videoFiles = files.filter(f => {
            if (!f.name) return false;
            const lowerName = f.name.toLowerCase();
            const lowerArchive = archiveTitle.toLowerCase();
            
            const isVideoExt = lowerName.endsWith(".mp4") || lowerName.endsWith(".mkv") || lowerName.endsWith(".ogv") || lowerName.endsWith(".avi");
            
            // Filtre strict anti-bruit / documentaires / reviews / bonus
            const isJunk = lowerName.includes("trailer") || 
                          lowerName.includes("sample") || 
                          lowerName.includes("teaser") || 
                          lowerName.includes("clip") ||
                          lowerName.includes("advertisement") ||
                          lowerName.includes("subtitles") ||
                          lowerName.includes("commentary") ||
                          lowerName.includes("documentary") ||
                          lowerArchive.includes("review") ||
                          lowerArchive.includes("documentary") ||
                          lowerArchive.includes("archive of");

            const fileSize = f.size || 0;
            const isTooSmall = fileSize < 100 * 1024 * 1024; // 100 Mo minimum pour un vrai film

            return isVideoExt && !isJunk && !isTooSmall;
        });

        videoFiles.sort((a, b) => (b.size || 0) - (a.size || 0));

        return videoFiles.map(file => {
            const sizeGB = (file.size / (1024 * 1024 * 1024)).toFixed(1);
            const sizeDisplay = sizeGB >= 1 ? `${sizeGB} GB` : `${Math.round(file.size / (1024 * 1024))} MB`;
            const ext = file.name.split('.').pop().toUpperCase();
            
            let quality = "720p / 1080p";
            const lower = (file.name + " " + archiveTitle).toLowerCase();
            if (lower.includes("1080p") || lower.includes("blu-ray")) quality = "1080p";
            else if (lower.includes("720p")) quality = "720p";
            else if (lower.includes("480p") || lower.includes("dvd")) quality = "480p";

            let displayTitle = file.name;
            if (displayTitle.length < 10 || displayTitle.toLowerCase().includes("movie")) {
                displayTitle = archiveTitle;
            }

            return {
                name: "🏛 Archive\n〈Full Movie〉",
                title: `✎ ${displayTitle}\n◈ ${sizeDisplay} · ${ext}\n◆ ${quality}`,
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
        let searchQuery = "mediatype:(movies) AND collection:(feature_films)";
        
        if (extra && extra.search) {
            searchQuery += ` AND title:(${extra.search})`;
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

            // Requête ultra-ciblée : on force la recherche dans la collection des longs-métrages (feature_films)
            const searchQuery = `mediatype:(movies) AND collection:(feature_films) AND title:("${movieMeta.name}")`;
            const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(searchQuery)}&fl[]=identifier,title&sort[]=downloads+desc&rows=3&output=json`;
            const searchRes = await axios.get(searchUrl);
            const docs = searchRes.data.response.docs || [];

            let allStreams = [];
            for (const doc of docs) {
                const docTitle = Array.isArray(doc.title) ? doc.title[0] : doc.title;
                const streams = await getStreamsFromIA(doc.identifier, docTitle);
                allStreams = allStreams.concat(streams);
            }

            const uniqueStreams = Array.from(new Map(allStreams.map(s => [s.url, s])).values());
            return { streams: uniqueStreams };
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
