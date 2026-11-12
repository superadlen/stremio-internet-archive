const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const axios = require("axios");

const builder = new addonBuilder({
    id: "org.internetarchive.movies",
    version: "1.1.0",
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
    // Ajout de "tt" pour réagir aussi aux fiches de films classiques (IMDb)
    idPrefixes: ["ia:", "tt"]
});

// Fonction utilitaire pour récupérer les fichiers vidéo d'un identifiant IA
async function getStreamsFromIA(identifier) {
    try {
        const metadataUrl = `https://archive.org/metadata/${identifier}`;
        const response = await axios.get(metadataUrl);
        const files = response.data.files || [];

        const videoFiles = files.filter(f =>
            f.name && (
                f.name.toLowerCase().endsWith(".mp4") ||
                f.name.toLowerCase().endsWith(".mkv") ||
                f.name.toLowerCase().endsWith(".ogv")
            )
        );

        return videoFiles.map(file => ({
            name: "Internet Archive",
            title: `${file.name} (${file.format || "Vidéo"})`,
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

    // Cas 1 : Le film vient directement du catalogue Internet Archive (ia:...)
    if (id.startsWith("ia:")) {
        const identifier = id.replace("ia:", "");
        const streams = await getStreamsFromIA(identifier);
        return { streams };
    }

    // Cas 2 : Le film vient d'une fiche classique Stremio / IMDb (tt...)
    if (id.startsWith("tt")) {
        try {
            // 1. Récupérer le titre du film via Cinemeta (l'API publique de Stremio)
            const cinemetaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${id}.json`);
            const movieMeta = cinemetaRes.data && cinemetaRes.data.meta;

            if (!movieMeta || !movieMeta.name) {
                return { streams: [] };
            }

            // 2. Chercher ce titre exact sur Internet Archive
            const searchQuery = `mediatype:(movies) AND title:("${movieMeta.name}")`;
            const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(searchQuery)}&fl[]=identifier&sort[]=downloads+desc&rows=3&output=json`;
            const searchRes = await axios.get(searchUrl);
            const docs = searchRes.data.response.docs || [];

            // 3. Récupérer les vidéos des 3 meilleurs résultats trouvés
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

// Configuration Express pour Vercel
const app = express();
const addonInterface = builder.getInterface();
app.use(getRouter(addonInterface));

module.exports = app;
