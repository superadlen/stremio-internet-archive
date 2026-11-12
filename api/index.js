const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const axios = require("axios");
const path = require("path");

const builder = new addonBuilder({
    id: "org.internetarchive.movies",
    version: "2.1.0", // Passage à la version 2.1.0
    name: "Internet Archive Movies",
    description: "Recherche et diffuse des films depuis Internet Archive.",
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

// Normalisation rigoureuse du texte
function normalizeText(str) {
    if (!str) return "";
    return str
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// Vérification stricte que le texte correspond au film recherché (Titre + Année)
function strictMatch(text, targetTitle, targetYear) {
    const normText = normalizeText(text);
    const normTitle = normalizeText(targetTitle);

    const stopWords = ["the", "a", "an", "of", "and", "to", "in", "saga"];
    const titleWords = normTitle.split(" ").filter(w => w.length > 1 && !stopWords.includes(w));
    
    if (titleWords.length === 0) return false;

    // TOUS les mots clés principaux du titre doivent obligatoirement être présents dans le nom du fichier ou de l'archive
    const allWordsPresent = titleWords.every(word => normText.includes(word));
    if (!allWordsPresent) return false;

    // Si une année est spécifiée, vérifier qu'elle correspond (tolérance de 1 an)
    const yearMatch = normText.match(/\b(19\d{2}|20\d{2})\b/);
    if (targetYear && yearMatch) {
        const foundYear = parseInt(yearMatch[1], 10);
        const expectedYear = parseInt(targetYear, 10);
        if (Math.abs(foundYear - expectedYear) > 1) {
            return false;
        }
    }

    return true;
}

// Fonction pour récupérer et filtrer les flux d'une archive IA
async function getStreamsFromIA(identifier, targetTitle = null, targetYear = null, imdbId = null) {
    try {
        const metadataUrl = `https://archive.org/metadata/${identifier}`;
        const response = await axios.get(metadataUrl, { timeout: 6000 });
        const meta = response.data.metadata || {};
        const files = response.data.files || [];

        const archiveTitle = Array.isArray(meta.title) ? meta.title[0] : (meta.title || identifier);
        const archiveDesc = JSON.stringify(meta).toLowerCase();
        
        const hasImdbMatch = imdbId ? archiveDesc.includes(imdbId.toLowerCase()) : false;

        // Si on cherche un film précis, l'archive globale doit elle aussi correspondre (sauf si match IMDb direct)
        if (targetTitle && !hasImdbMatch) {
            const archiveValid = strictMatch(archiveTitle + " " + identifier, targetTitle, targetYear);
            if (!archiveValid) {
                return []; // On rejette toute l'archive si elle n'a aucun rapport avec le film
            }
        }

        const videoFiles = files.filter(f => {
            if (!f.name) return false;
            const lowerName = f.name.toLowerCase();

            if (lowerName.endsWith(".ia.mp4")) return false;

            const isVideoExt = lowerName.endsWith(".mp4") || lowerName.endsWith(".mkv") || lowerName.endsWith(".avi") || lowerName.endsWith(".ogv");
            if (!isVideoExt) return false;

            const isJunk = /(trailer|sample|teaser|clip|advertisement|commentary|review|bloopers|making of)/i.test(lowerName);
            if (isJunk) return false;

            const fileSize = parseInt(f.size || "0", 10);
            if (fileSize < 100 * 1024 * 1024) return false; // 100 Mo min pour un film

            // CONTRÔLE CRUCIAL : Le nom du fichier individuel DOIT correspondre au film recherché
            if (targetTitle && !hasImdbMatch) {
                const fileMatches = strictMatch(f.name, targetTitle, targetYear);
                if (!fileMatches) {
                    return false; // Élimine les fichiers parasites (ex: Minions dans une archive fourre-tout)
                }
            }

            return true;
        });

        return videoFiles.map(file => {
            const sizeBytes = parseInt(file.size || "0", 10);
            const sizeGB = (sizeBytes / (1024 * 1024 * 1024)).toFixed(1);
            const sizeDisplay = sizeGB >= 1 ? `${sizeGB} GB` : `${Math.round(sizeBytes / (1024 * 1024))} MB`;
            const ext = file.name.split('.').pop().toUpperCase();

            const infoStr = (file.name + " " + archiveTitle).toLowerCase();
            
            let quality = "HD";
            if (infoStr.includes("1080p")) quality = "1080p";
            else if (infoStr.includes("720p")) quality = "720p";
            else if (infoStr.includes("480p")) quality = "480p";

            let source = "";
            if (infoStr.includes("yify") || infoStr.includes("yts")) source = " · YIFY/YTS";
            else if (infoStr.includes("bluray") || infoStr.includes("blu-ray")) source = " · BluRay";
            else if (infoStr.includes("web")) source = " · WEB";

            let language = "English / Multilingual";
            if (infoStr.includes("french") || infoStr.includes("vf")) language = "Français";
            else if (infoStr.includes("hindi")) language = "Hindi Dubbed";

            const cleanFileName = file.name.split('/').pop();
            const displayTitle = cleanFileName.length > 12 ? cleanFileName : archiveTitle;
            const matchBadge = hasImdbMatch ? "◎ 100% match · IMDb ✓" : "◎ Strict match";

            return {
                name: "🏛 Archive\n〈Full Movie〉",
                title: `✎ ${displayTitle}\n◈ ${sizeDisplay} · ${ext}\n◆ ${quality}${source}\n🌍 ${language} · ${matchBadge}`,
                url: `https://archive.org/download/${identifier}/${file.name.split('/').map(encodeURIComponent).join('/')}`,
                _hasImdb: hasImdbMatch,
                _size: sizeBytes
            };
        });
    } catch (error) {
        return [];
    }
}

// Catalogue
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
        let searchQuery = "mediatype:(movies)";
        if (extra && extra.search) {
            searchQuery += ` AND title:(${extra.search})`;
        } else {
            searchQuery += " AND (collection:(feature_films) OR collection:(opensource_movies))";
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
        return { metas: [] };
    }
});

// Streams
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

            const title = movieMeta.name;
            const year = movieMeta.year ? String(movieMeta.year).substring(0, 4) : null;
            
            // Requête ciblée par ID IMDb ou par titre exact
            const searchQuery = `mediatype:(movies) AND (${id} OR title:("${title}"))`;
            const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(searchQuery)}&fl[]=identifier,title,year&sort[]=downloads+desc&rows=10&output=json`;
            
            const searchRes = await axios.get(searchUrl);
            const docs = searchRes.data.response.docs || [];

            const streamPromises = docs.map(doc => getStreamsFromIA(doc.identifier, title, year, id));
            const results = await Promise.all(streamPromises);
            let allStreams = results.flat();

            // Tri par pertinence IMDb puis taille
            allStreams.sort((a, b) => {
                if (a._hasImdb !== b._hasImdb) return b._hasImdb ? 1 : -1;
                return b._size - a._size;
            });

            const uniqueStreams = [];
            const seenUrls = new Set();
            for (const s of allStreams) {
                if (!seenUrls.has(s.url)) {
                    seenUrls.add(s.url);
                    delete s._hasImdb;
                    delete s._size;
                    uniqueStreams.push(s);
                }
            }

            return { streams: uniqueStreams };
        } catch (error) {
            return { streams: [] };
        }
    }

    return { streams: [] };
});

const app = express();
app.use(express.static(path.join(__dirname, "../public")));

const addonInterface = builder.getInterface();
app.use(getRouter(addonInterface));

module.exports = app;
