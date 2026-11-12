function isMatch(candidateText, targetTitle, targetYear) {
    const normCandidate = normalizeText(candidateText);
    const normTitle = normalizeText(targetTitle);
    if (!normTitle || !normCandidate) return false;

    // 1. Le titre cible doit apparaître en tant que MOTS ENTIERS (pas en sous-chaîne)
    //    On accepte le titre exact, ou le titre suivi/précédé d'infos (année, langue, qualité)
    const titlePattern = new RegExp(
        `(^|\\s)${normTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`
    );
    if (!titlePattern.test(normCandidate)) {
        // Tolérance : mots du titre dans l'ordre, mais le titre ne doit pas être
        // qu'un fragment d'un titre plus long (ex: "matrix" dans "matrix reloaded")
        const titleWords = normTitle.split(" ").filter(w => w.length > 1);
        const candWords = normCandidate.split(" ");
        // Vérifie que la séquence de mots du titre existe contiguë dans le candidat
        const joined = " " + normCandidate + " ";
        const seq = " " + titleWords.join(" ") + " ";
        if (!joined.includes(seq)) return false;
    }

    // 2. Anti-séquelles/remakes : si la cible n'est PAS une suite, rejeter les variantes
    const isSequelTarget = /\b(part\s*\d+|chapter\s*\d+|\bii\b|\biii\b|\biv\b|\d{2,})\b/.test(normTitle);
    if (!isSequelTarget) {
        const sequelMarkers = /\b(part\s*[2-9]|part\s*(ii|iii|iv)|chapter\s*[2-9]|\b(ii|iii|iv|v)\b|reloaded|revenge|returns|rises|forever|reborn|resurrection|awakening|legacy|origins|begins|the\s+movie\s+[2-9])\b/;
        // On compare seulement la portion du candidat qui SUIT le titre
        const idx = normCandidate.indexOf(normTitle);
        if (idx >= 0) {
            const after = normCandidate.substring(idx + normTitle.length).trim();
            if (sequelMarkers.test(after)) return false;
        }
    }

    // 3. Vérification de l'année (tolérance ±1 an)
    const yearMatch = normCandidate.match(/\b(19\d{2}|20\d{2})\b/);
    if (targetYear && yearMatch) {
        const found = parseInt(yearMatch[1], 10);
        const expected = parseInt(targetYear, 10);
        if (Math.abs(found - expected) > 1) return false;
    }

    return true;
}
