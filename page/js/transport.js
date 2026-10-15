// Mixeur MIDI — barre de transport façon Reason : lecture, boucle L-R, afficheurs, VU-mètres, ligne de temps
// (script classique : les variables et fonctions sont partagées entre les fichiers de la page)

// ───────────── barre de transport (façon Reason) ─────────────
const TR = (() => {
  const a = $("#lecteur"), toile = $("#toile"), ligne = $("#ligne");
  let carte = [{t: 0, mesure: 0, bpm: 120, num: 4, den: 4}], duree = 0, L = 0, R = 0, boucle = false, depart = 0;
  let ctx = null, gain = null, an = [], pic = [-90, -90], picT = [0, 0], pret = false, aJouer = false;
  let attente = false, reprise = 0, reprendre = false;  // pendant le chargement d'un nouveau mixage : où reprendre, et rejouer ?
  let relance = false;                  // nouveauContenu : un nouveau calcul suivi de la lecture est déjà prévu
  let enCalcul = false;                 // premier calcul du mixage demandé par ▶ : la touche clignote
  const noiresParMesure = s => s.num * 4 / s.den;
  const seg = t => carte.reduce((s, x) => x.t <= t ? x : s, carte[0]);
  const mesureA = t => { const s = seg(t); return s.mesure + (t - s.t) * s.bpm / 60 / noiresParMesure(s); };
  const tempsA = m => { const s = carte.reduce((p, x) => x.mesure <= m ? x : p, carte[0]); return s.t + (m - s.mesure) * noiresParMesure(s) * 60 / s.bpm; };
  const finMesures = () => mesureA(duree);
  function pos(t) {
    const s = seg(t), mf = mesureA(t) + 1e-7, m = Math.floor(mf), dans = (mf - m) * s.num, tps = Math.floor(dans);
    return {m: m + 1, tps: tps + 1, tick: Math.min(479, Math.floor((dans - tps) * 480)), s};
  }
  const fmtTemps = t => { t = Math.max(0, t); const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(3).padStart(6, "0")}`; };
  const fmtLoc = t => { const p = pos(t); return `${String(p.m).padStart(3, " ")}.${p.tps}`; };
  const ici = () => attente ? reprise : a.src ? a.currentTime : depart;
  function va(t) { t = Math.max(0, Math.min(duree || 0, t)); if (attente) reprise = t; else if (a.src && a.readyState) a.currentTime = t; else depart = t; }
  function audioGraphe() {
    if (ctx) return;
    try {
      ctx = new AudioContext();
      const src = ctx.createMediaElementSource(a), sep = ctx.createChannelSplitter(2);
      a.volume = 1; gain = ctx.createGain(); gain.gain.value = +$("#t-vol").value / 100;
      src.connect(gain); gain.connect(ctx.destination); src.connect(sep);
      an = [0, 1].map(i => { const n = ctx.createAnalyser(); n.fftSize = 1024; sep.connect(n, i); return n; });
    } catch (e) { ctx = null; }
  }
  function etatLecture() {
    const joue = attente ? reprendre : !a.paused;     // pendant un changement de mixage, la touche reste allumée
    $("#t-play").setAttribute("aria-pressed", joue);
    icone($("#ico-play"), joue ? "pause" : "lecture");          // icones/pause.svg, icones/lecture.svg
  }
  async function lecture() {
    if (enCalcul) return;                                                  // déjà en train de calculer
    if (!a.src) { aJouer = true; return rendu("ecoute"); }
    if (attente) { reprendre = !reprendre; etatLecture(); return; }       // nouveau mixage en chargement
    audioGraphe(); if (ctx && ctx.state === "suspended") await ctx.resume();
    if (a.paused) { depart = a.currentTime; a.play().catch(() => {}); } else a.pause();
  }
  function stop() {
    if (attente && reprendre) { reprendre = false; va(depart); etatLecture(); }
    else if (!a.paused) { a.pause(); va(depart); } else va(boucle ? L : 0);
  }
  function mesureSuivante(sens) {
    const m = mesureA(ici()), cible = sens < 0 ? Math.ceil(m - 1e-6) - 1 : Math.floor(m + 1e-6) + 1;
    va(tempsA(Math.max(0, cible)));
  }
  function poseLoc(cote) {
    const t = tempsA(Math.round(mesureA(ici())));          // aligné sur la barre de mesure la plus proche
    if (cote === "L") L = t; else R = t;
    if (R <= L) [L, R] = [Math.min(L, R), Math.max(L, R) + (R === L ? tempsA(mesureA(L) + 1) - L : 0)];
    affLoc();
  }
  function affLoc() { $("#lcd-L").textContent = fmtLoc(L); $("#lcd-R").textContent = fmtLoc(R); }
  // ligne de temps
  function dessineLigne() {
    const dpr = window.devicePixelRatio || 1, W = toile.clientWidth, H = toile.clientHeight;
    if (toile.width !== Math.round(W * dpr)) { toile.width = Math.round(W * dpr); toile.height = Math.round(H * dpr); }
    const g = toile.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    if (!duree) { g.fillStyle = "#6b6f78"; g.font = "12px Consolas"; g.fillText("Chargez un morceau, puis ▶ : le mixage est calculé et joué.", 10, 24); return; }
    const X = t => t / duree * W, t = ici();
    if (R > L) { g.fillStyle = boucle ? "rgba(255,174,60,.22)" : "rgba(255,174,60,.08)"; g.fillRect(X(L), 0, X(R) - X(L), H);
      g.fillStyle = "#ffae3c"; g.fillRect(X(L), 0, 2, H); g.fillRect(X(R) - 2, 0, 2, H);
      g.font = "bold 10px Consolas"; g.fillText("L", X(L) + 4, 11); g.fillText("R", X(R) - 11, 11); }
    g.fillStyle = "rgba(125,255,154,.10)"; g.fillRect(0, 0, X(t), H);
    const nb = Math.ceil(finMesures()), pas = [1, 2, 4, 8, 16, 32].find(p => W / nb * p >= 34) || 64;
    g.font = "10px Consolas"; g.textBaseline = "bottom";
    for (let m = 0; m <= nb; m++) {
      const x = X(tempsA(m)); if (x > W) break;
      const fort = m % pas === 0, section = carte.some(s => Math.abs(s.mesure - m) < 1e-6 && m > 0);
      g.fillStyle = section ? "#ffae3c" : fort ? "#8a8f99" : "#3b3f47";
      g.fillRect(x, section ? 0 : fort ? H - 16 : H - 8, section ? 2 : 1, section ? H : fort ? 16 : 8);
      if (fort) { g.fillStyle = "#b9bdc6"; g.fillText(String(m + 1), x + 3, H - 3); }
    }
    let libre = 0;                                 // pas d'étiquettes de tempo qui se chevauchent
    for (const s of carte.slice(1)) {
      const txt = `${Math.round(s.bpm)} · ${s.num}/${s.den}`, x = X(s.t) + 4;
      if (x >= libre) { g.fillStyle = "#ffae3c"; g.fillText(txt, x, 22); libre = x + g.measureText(txt).width + 6; }
    }
    g.fillStyle = "#fff"; g.fillRect(X(t) - 1, 0, 2, H);
    g.beginPath(); g.moveTo(X(t) - 5, 0); g.lineTo(X(t) + 5, 0); g.lineTo(X(t), 6); g.fill();
  }
  let glisse = null;
  ligne.addEventListener("pointerdown", e => {
    if (!duree) return;
    const r = ligne.getBoundingClientRect(), t = (e.clientX - r.left) / r.width * duree;
    ligne.setPointerCapture(e.pointerId);
    if (e.shiftKey) { glisse = tempsA(Math.round(mesureA(t))); L = R = glisse; } else { glisse = null; va(t); }
  });
  ligne.addEventListener("pointermove", e => {
    if (glisse === null || !(e.buttons & 1)) return;
    const r = ligne.getBoundingClientRect(), t = tempsA(Math.round(mesureA((e.clientX - r.left) / r.width * duree)));
    L = Math.min(glisse, t); R = Math.max(glisse, t); boucle = R > L; $("#t-boucle").setAttribute("aria-pressed", boucle); affLoc();
  });
  ligne.addEventListener("pointerup", () => glisse = null);
  // boucle d'affichage
  function vu() {
    const now = performance.now();
    [0, 1].forEach(i => {
      let db = -90;
      if (an[i] && !a.paused) { const buf = new Float32Array(an[i].fftSize); an[i].getFloatTimeDomainData(buf);
        let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v)); db = p > 0 ? 20 * Math.log10(p) : -90; }
      const w = Math.max(0, Math.min(100, (db + 48) / 48 * 100));
      $(i ? "#vu-d" : "#vu-g").style.width = w + "%";
      if (db > pic[i] || now - picT[i] > 1500) { pic[i] = db; picT[i] = now; }
      $(i ? "#pk-d" : "#pk-g").style.left = `calc(${Math.max(0, Math.min(100, (pic[i] + 48) / 48 * 100))}% - 2px)`;
    });
  }
  function tic() {
    const t = ici();
    if (boucle && R > L && !a.paused && t >= R) a.currentTime = L;
    const p = pos(t);
    $("#lcd-pos").textContent = `${String(p.m).padStart(3, " ")} . ${p.tps} . ${String(p.tick).padStart(3, "0")}`;
    $("#lcd-temps").textContent = enCalcul && !a.src ? "calcul…" : fmtTemps(t);
    $("#lcd-tempo").innerHTML = `${p.s.bpm.toFixed(1)}<small>bpm</small>  ${p.s.num}/${p.s.den}`;
    vu(); dessineLigne();
    requestAnimationFrame(tic);
  }
  a.addEventListener("play", etatLecture); a.addEventListener("pause", etatLecture);
  a.addEventListener("ended", () => { etatLecture(); });
  a.addEventListener("loadedmetadata", async () => {      // un nouveau mixage est arrivé (voir charge)
    if (!attente) return;
    a.currentTime = Math.min(reprise, Math.max(0, a.duration - 0.1)); attente = false; pret = true;
    if (reprendre) { audioGraphe(); if (ctx && ctx.state === "suspended") await ctx.resume(); a.play().catch(() => {}); }
  });
  $("#t-play").addEventListener("click", lecture);
  $("#t-stop").addEventListener("click", stop);
  $("#t-debut").addEventListener("click", () => va(boucle ? L : 0));
  $("#t-recul").addEventListener("click", () => mesureSuivante(-1));
  $("#t-avance").addEventListener("click", () => mesureSuivante(1));
  // boucle : si des mesures sont sélectionnées (onglet Montage), elle se pose sur elles et la lecture s'y place
  let mesuresChoisies = () => null;
  $("#t-boucle").addEventListener("click", e => {
    boucle = !boucle; e.currentTarget.setAttribute("aria-pressed", boucle);
    const s = boucle && duree ? mesuresChoisies() : null;
    if (s) {
      L = tempsA(s.de - 1); R = Math.min(duree, tempsA(s.a)); affLoc();
      const t = ici(); if (t < L || t >= R) va(L);
    }
  });
  $("#t-setL").addEventListener("click", () => poseLoc("L"));
  $("#t-setR").addEventListener("click", () => poseLoc("R"));
  $("#t-vol").addEventListener("input", e => { const v = +e.target.value; $("#t-volv").textContent = v; if (gain) gain.gain.value = v / 100; else a.volume = v / 100; });
  document.addEventListener("keydown", e => {
    if (saisieEnCours()) return;
    if (e.code === "Space") { e.preventDefault(); lecture(); }
    else if (e.key === "b" || e.key === "B") $("#t-boucle").click();
    else if (e.key === "Home") va(boucle ? L : 0);
    else if (e.key === "ArrowLeft" && e.ctrlKey) mesureSuivante(-1);
    else if (e.key === "ArrowRight" && e.ctrlKey) mesureSuivante(1);
  });
  requestAnimationFrame(tic);
  return {
    nouveauMorceau(M) { a.pause(); a.removeAttribute("src"); a.load(); attente = false; carte = M.tempos && M.tempos.length ? M.tempos : carte;
      duree = M.duree; depart = 0; L = 0; R = Math.min(duree, tempsA(4)); affLoc(); etatLecture(); },
    // même morceau, autre contenu (changement d'onglet vers ou depuis le Montage, montage ou texte appliqué, autre version) :
    // on garde la position et la boucle ; si on écoutait, le nouveau contenu est calculé puis rejoué au même endroit
    nouveauContenu(M) {
      const joue = attente ? reprendre : !!a.src && !a.paused, t = ici();
      a.pause(); a.removeAttribute("src"); a.load(); attente = false;
      carte = M.tempos && M.tempos.length ? M.tempos : carte; duree = M.duree;
      depart = Math.min(t, duree); R = Math.min(R, duree); L = Math.min(L, R); affLoc(); etatLecture();
      if (joue && !relance) { relance = true; setTimeout(() => { relance = false; lecture(); }, 0); }   // une fois l'onglet en place
    },
    aUnMixage: () => !!a.src,
    calcul(oui) { enCalcul = oui; $("#t-play").classList.toggle("calcul", oui); if (!oui) aJouer = aJouer && !!a.src; },
    majCarte(M) {   // le montage a changé : nouvelle carte des mesures, sans arrêter la lecture
      carte = M.tempos && M.tempos.length ? M.tempos : carte; duree = M.duree;
      R = Math.min(R, duree); L = Math.min(L, R); affLoc();
    },
    mesure: () => duree ? mesureA(ici()) : -1,          // position en mesures (0 = début de la mesure 1)
    instant: () => ici(),                               // position en secondes (la tête de lecture a-t-elle bougé ?)
    boucleSur(f) { mesuresChoisies = f; },             // f() → {de, a} (mesures sélectionnées, 1 = première) ou null
    vaMesure: m => va(tempsA(m)),
    charge(url) {   // nouveau mixage : on reprend à la même position, et on rejoue si on jouait
      reprendre = (attente ? reprendre : !a.paused) || aJouer || !pret; aJouer = false;
      reprise = ici(); attente = true;
      a.src = url;
    }
  };
})();
