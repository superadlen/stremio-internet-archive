const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const axios = require("axios");

const builder = new addonBuilder({
    id: "org.internetarchive.movies",
    version: "1.0.0",
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
    idPrefixes: ["ia:"]
});

// Gestion du catalogue et de la recherche
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
        let searchQuery = "mediatype:(movies)";
        
        if (extra && extra.search) {
            searchQuery += ` AND title:(${extra.search})`;
        } else {
            // Par défaut, affiche les films les plus téléchargés
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
    if (type !== "movie" || !id.startsWith("ia:")) {
        return { streams: [] };
    }

    const identifier = id.replace("ia:", "");

    try {
        const metadataUrl = `https://archive.org/metadata/${identifier}`;
        const response = await axios.get(metadataUrl);
        const files = response.data.files || [];

        // Filtrer les fichiers vidéo lisibles (MP4, MKV, OGV)
        const videoFiles = files.filter(f => 
            f.name && (
                f.name.toLowerCase().endsWith(".mp4") || 
                f.name.toLowerCase().endsWith(".mkv") || 
                f.name.toLowerCase().endsWith(".ogv")
            )
        );

        const streams = videoFiles.map(file => ({
            name: "Internet Archive",
            title: `${file.name} (${file.format || "Vidéo"})`,
            url: `https://archive.org/download/${identifier}/${encodeURIComponent(file.name)}`
        }));

        return { streams };
    } catch (error) {
        console.error("Erreur stream:", error.message);
        return { streams: [] };
    }
});

// Configuration Express pour Vercel
const app = express();
const addonInterface = builder.getInterface();
app.use(getRouter(addonInterface));

module.exports = app;
