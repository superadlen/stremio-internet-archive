  if (pathname === "/configure") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(`<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${addonInterface.manifest.name} — Configuration</title>
<style>
  :root { --bg:#0f1117; --card:#171a23; --line:#2a2f3d; --txt:#e6e9f0; --dim:#8b93a7; --acc:#5b8cff; --ok:#3ddc84; --warn:#ffb454; }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body { font-family:system-ui,-apple-system,sans-serif; margin:0; padding:.9rem; background:var(--bg); color:var(--txt); display:flex; flex-direction:column; gap:.7rem; }
  header { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; }
  header h1 { font-size:1.15rem; margin:0; }
  header .ver { color:var(--dim); font-size:.75rem; }
  .grid { display:grid; grid-template-columns:1.25fr 1fr 1fr; gap:.7rem; flex:1; min-height:0; }
  @media (max-width:900px) { .grid { grid-template-columns:1fr 1fr; } .opts { grid-column:span 2; } }
  @media (max-width:620px) { .grid { grid-template-columns:1fr; } .opts { grid-column:auto; } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:.7rem .75rem; display:flex; flex-direction:column; min-height:0; }
  .card h2 { font-size:.85rem; margin:0 0 .5rem; color:var(--acc); display:flex; align-items:center; gap:.35rem; justify-content:space-between; }
  .card h2 .mini { display:flex; gap:.3rem; }
  .card h2 button { font-size:.7rem; padding:.2rem .45rem; border-radius:6px; border:1px solid var(--line); background:transparent; color:var(--dim); cursor:pointer; }
  .card h2 button:hover { color:var(--txt); border-color:var(--acc); }
  .scroll { overflow-y:auto; flex:1; min-height:0; padding-right:.2rem; }
  .scroll::-webkit-scrollbar { width:6px; }
  .scroll::-webkit-scrollbar-thumb { background:var(--line); border-radius:6px; }
  .lang { display:flex; align-items:center; gap:.4rem; padding:.32rem .5rem; border-radius:8px; cursor:pointer; user-select:none; transition:background .1s; }
  .lang:hover { background:#1e2230; }
  .lang.on { background:#1c2a4a; }
  .lang .flag { font-size:1.05rem; }
  .lang .nm { flex:1; font-size:.85rem; }
  .lang .ck { width:16px; height:16px; border-radius:50%; border:2px solid var(--line); flex:none; display:grid; place-items:center; }
  .lang.on .ck { border-color:var(--ok); background:var(--ok); }
  .lang.on .ck::after { content:"✓"; color:#04120a; font-size:.7rem; font-weight:900; }
  .qual { display:flex; align-items:center; gap:.5rem; padding:.5rem .6rem; margin-bottom:.35rem; background:#1e2230; border:1px solid var(--line); border-radius:10px; cursor:grab; user-select:none; }
  .qual .num { background:var(--acc); color:#fff; border-radius:50%; width:20px; height:20px; display:grid; place-items:center; font-size:.7rem; font-weight:700; flex:none; }
  .qual .lbl { flex:1; font-size:.82rem; }
  .qual .h { color:var(--dim); }
  .opts .row { display:flex; align-items:center; justify-content:space-between; gap:.5rem; padding:.5rem 0; border-bottom:1px solid var(--line); }
  .opts .row:last-of-type { border-bottom:none; }
  .opts .row label { font-size:.82rem; flex:1; }
  .opts .row small { display:block; color:var(--dim); font-size:.7rem; margin-top:.1rem; }
  .toggle { display:flex; gap:.25rem; }
  .toggle button { border:1px solid var(--line); background:transparent; color:var(--dim); border-radius:6px; padding:.25rem .5rem; font-size:.75rem; cursor:pointer; }
  .toggle button.on { background:var(--acc); border-color:var(--acc); color:#fff; }
  input[type=range] { width:100%; accent-color:var(--acc); }
  .sizeRow { display:flex; justify-content:space-between; font-size:.75rem; color:var(--dim); margin-top:.2rem; }
  .sizeRow b { color:var(--acc); }
  footer { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }
  .btn { border:none; border-radius:10px; padding:.7rem 1rem; font-size:.9rem; font-weight:700; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; gap:.35rem; }
  .btn.install { background:var(--ok); color:#04120a; flex:1; justify-content:center; }
  .btn.copy { background:var(--acc); color:#fff; }
  .urlbox { flex:1; min-width:200px; font-size:.7rem; color:var(--dim); background:#0b0d12; padding:.55rem .7rem; border-radius:8px; word-break:break-all; border:1px solid var(--line); }
  #toast { position:fixed; left:50%; bottom:1.5rem; transform:translateX(-50%) translateY(20px); background:var(--ok); color:#04120a; padding:.6rem 1.2rem; border-radius:10px; font-weight:700; opacity:0; transition:all .25s; pointer-events:none; z-index:99; }
  #toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
  .badge { font-size:.65rem; padding:.1rem .4rem; border-radius:6px; background:#1c2a4a; color:var(--acc); }
</style></head><body>

<header>
  <h1>🏛 ${addonInterface.manifest.name}</h1>
  <span class="ver">v${addonInterface.manifest.version}</span>
  <span class="badge" id="summary"></span>
</header>

<div class="grid">

  <!-- LANGUES -->
  <div class="card">
    <h2>🗣️ Langues
      <span class="mini"><button id="langAll">Tout</button><button id="langNone">Rien</button></span>
    </h2>
    <div class="scroll" id="langs"></div>
  </div>

  <!-- QUALITÉ -->
  <div class="card">
    <h2>🎞️ Qualité d'image</h2>
    <div class="scroll" id="quals"></div>
  </div>

  <!-- OPTIONS -->
  <div class="card opts">
    <h2>⚙️ Options</h2>
    <div class="row">
      <label>📺 HDR / Dolby Vision<small>HDR10, HDR10+, DV, 10bit</small></label>
      <div class="toggle" data-k="hdr"><button data-v="1">Oui</button><button data-v="0">Non</button></div>
    </div>
    <div class="row" style="flex-direction:column;align-items:stretch;">
      <label>📦 Taille maximale <small>0 = pas de limite</small></label>
      <input type="range" id="size" min="0" max="20" step="0.5" value="0">
      <div class="sizeRow"><span>0 Go</span><b id="sizeVal">Illimitée</b><span>20 Go</span></div>
    </div>
    <div class="row">
      <label>🎯 % de correspondance minimum<small>Filtrer les résultats peu sûrs</small></label>
      <span class="badge" id="minPctVal">50%</span>
    </div>
    <input type="range" id="minPct" min="0" max="100" step="5" value="50">
  </div>

</div>

<footer>
  <div class="urlbox" id="url"></div>
  <button class="btn copy" id="copy">📋 Copier</button>
  <a class="btn install" id="install" href="#">▶ Installer</a>
</footer>

<div id="toast">✅ OK · URL copiée</div>

<script>
// Langues : les plus utilisées d'abord, puis les autres
const LANGS_POP = [
  { code:"en", flag:"🇬🇧", name:"English" },
  { code:"fr", flag:"🇫🇷", name:"Français" },
  { code:"es", flag:"🇪🇸", name:"Español" },
  { code:"de", flag:"🇩🇪", name:"Deutsch" },
  { code:"it", flag:"🇮🇹", name:"Italiano" },
  { code:"pt", flag:"🇵🇹", name:"Português" },
  { code:"ru", flag:"🇷🇺", name:"Русский" },
  { code:"ar", flag:"🇸🇦", name:"العربية" },
  { code:"hi", flag:"🇮🇳", name:"हिन्दी" },
  { code:"ja", flag:"🇯🇵", name:"日本語" },
];
const LANGS_REST = [
  { code:"ko", flag:"🇰🇷", name:"한국어" },
  { code:"zh", flag:"🇨🇳", name:"中文" },
  { code:"nl", flag:"🇳🇱", name:"Nederlands" },
  { code:"sv", flag:"🇸🇪", name:"Svenska" },
  { code:"pl", flag:"🇵🇱", name:"Polski" },
  { code:"tr", flag:"🇹🇷", name:"Türkçe" },
];
const QUALS = [
  { k:"4k",   label:"🔥 4K / 2160p",    rank:5 },
  { k:"1080", label:"⭐ 1080p",          rank:4 },
  { k:"720",  label:"✅ 720p",           rank:3 },
  { k:"480",  label:"📼 480p / 576p",    rank:2 },
  { k:"low",  label:"📺 360p et moins",  rank:1 },
  { k:"unk",  label:"❓ Inconnue",        rank:0 },
];

function load(k, def) { try { const v = JSON.parse(localStorage.getItem("ia_cfg_"+k)); return v ?? def; } catch(e){ return def; } }
function save(k, v) { localStorage.setItem("ia_cfg_"+k, JSON.stringify(v)); }

let langOn  = load("langOn",  Object.fromEntries([...LANGS_POP, ...LANGS_REST].map(l => [l.code, true])));
let qualArr = load("quals",   QUALS.map(q => q.k));
let hdr     = load("hdr",     1);
let maxSize = load("size",    0);
let minPct  = load("minPct",  50);

// ---------- LANGUES ----------
const langsBox = document.getElementById("langs");
function renderLangs() {
  langsBox.innerHTML = "";
  const addGroup = (title, list) => {
    if (!list.length) return;
    const h = document.createElement("div");
    h.style.cssText = "font-size:.68rem;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;margin:.4rem 0 .25rem;";
    h.textContent = title;
    langsBox.appendChild(h);
    list.forEach(l => {
      const el = document.createElement("div");
      el.className = "lang" + (langOn[l.code] ? " on" : "");
      el.innerHTML = '<span class="flag">'+l.flag+'</span><span class="nm">'+l.name+'</span><span class="ck"></span>';
      el.onclick = () => { langOn[l.code] = !langOn[l.code]; save("langOn", langOn); renderLangs(); update(); };
      langsBox.appendChild(el);
    });
  };
  addGroup("⭐ Les plus utilisées", LANGS_POP);
  addGroup("Autres", LANGS_REST);
}

document.getElementById("langAll").onclick  = () => { Object.keys(langOn).forEach(k => langOn[k] = true);  save("langOn", langOn); renderLangs(); update(); };
document.getElementById("langNone").onclick = () => { Object.keys(langOn).forEach(k => langOn[k] = false); save("langOn", langOn); renderLangs(); update(); };

// ---------- QUALITÉS (drag & drop) ----------
const qualsBox = document.getElementById("quals");
function renderQuals() {
  qualsBox.innerHTML = "";
  qualArr.forEach((k, i) => {
    const q = QUALS.find(x => x.k === k);
    if (!q) return;
    const el = document.createElement("div");
    el.className = "qual"; el.draggable = true; el.dataset.i = i;
    el.innerHTML = '<span class="num">'+(i+1)+'</span><span class="lbl">'+q.label+'</span><span class="h">☰</span>';
    el.ondragstart = e => e.dataTransfer.setData("text/plain", i);
    el.ondragover  = e => e.preventDefault();
    el.ondrop = e => {
      e.preventDefault();
      const from = +e.dataTransfer.getData("text/plain"), to = i;
      if (from === to) return;
      const [m] = qualArr.splice(from, 1); qualArr.splice(to, 0, m);
      save("quals", qualArr); renderQuals(); update();
    };
    qualsBox.appendChild(el);
  });
}

// ---------- HDR ----------
function bindToggle(key, val, onSet) {
  document.querySelectorAll('[data-k="'+key+'"] button').forEach(b => {
    if (String(val) === b.dataset.v) b.classList.add("on");
    b.onclick = () => {
      const v = +b.dataset.v; onSet(v);
      document.querySelectorAll('[data-k="'+key+'"] button').forEach(x => x.classList.toggle("on", x === b));
      update();
    };
  });
}
bindToggle("hdr", hdr, v => { hdr = v; save("hdr", hdr); });

// ---------- TAILLE ----------
const sizeEl = document.getElementById("size"), sizeVal = document.getElementById("sizeVal");
sizeEl.value = maxSize;
const sizeText = v => v == 0 ? "Illimitée" : v + " Go max";
sizeVal.textContent = sizeText(maxSize);
sizeEl.oninput = () => { maxSize = +sizeEl.value; sizeVal.textContent = sizeText(maxSize); save("size", maxSize); update(); };

// ---------- MIN % ----------
const pctEl = document.getElementById("minPct"), pctVal = document.getElementById("minPctVal");
pctEl.value = minPct;
pctVal.textContent = minPct + "%";
pctEl.oninput = () => { minPct = +pctEl.value; pctVal.textContent = minPct + "%"; save("minPct", minPct); update(); };

// ---------- URL + COPY + TOAST ----------
function buildCfg() {
  return {
    langs:  Object.entries(langOn).filter(([_,v]) => v).map(([k]) => k),
    quals:  qualArr,
    hdr, size: maxSize, minPct,
  };
}
function update() {
  const cfg = buildCfg();
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(cfg))))
    .replace(/=+$/,"").replace(/\\+/g,"-").replace(/\\//g,"_");
  const url = location.origin + "/" + b64 + "/manifest.json";
  document.getElementById("url").textContent = url;
  document.getElementById("install").href = "stremio://" + url.replace(/^https?:\\/\\//,"");

  // résumé en haut
  const nbL = cfg.langs.length, total = LANGS_POP.length + LANGS_REST.length;
  const sum = document.getElementById("summary");
  sum.textContent = nbL + "/" + total + " langues · " + (hdr ? "HDR" : "SDR") + " · " + (maxSize ? maxSize+"Go" : "∞") + " · " + minPct + "%";
}
let toastTimer;
document.getElementById("copy").onclick = async () => {
  const url = document.getElementById("url").textContent;
  try {
    await navigator.clipboard.writeText(url);
  } catch (e) {
    // fallback
    const ta = document.createElement("textarea");
    ta.value = url; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  const t = document.getElementById("toast");
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1400);
};

// ---------- INIT ----------
renderLangs();
renderQuals();
update();
</script>
</body></html>`);
  }
