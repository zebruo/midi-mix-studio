// Mixeur MIDI — sélecteur de son d'une piste : une fenêtre avec recherche dans les sons des deux moteurs
// (GeneralUser via FluidSynth, sfizz : Salamander et VPO). Choisir un son règle aussi le moteur de la piste.
// Recherche sans accents, en français ou en anglais (cello = violoncelle, flute = flûte…).
// (script classique : les variables et fonctions sont partagées entre les fichiers de la page)

const CHOIX_SON = (() => {
  // mots équivalents (sans accents) : les noms GeneralUser sont en français, ceux de VPO en anglais
  const SYNONYMES = [
    ["violoncelle", "cello"], ["violon", "violin", "violins"], ["alto", "viola", "violas"],
    ["contrebasse", "contrabass", "bass sec", "bass solo"], ["contrebasson", "contrabassoon"], ["cordes", "strings"], ["harpe", "harp"],
    ["flute", "flutes"], ["piccolo"], ["hautbois", "oboe", "oboes"], ["clarinette", "clarinet", "clarinets"],
    ["basson", "bassoon", "bassoons"], ["cor anglais", "english horn"], ["bois", "woodwinds"],
    ["cor", "horn", "horns", "french horn"], ["trompette", "trumpet", "trumpets"], ["trombone", "trombones"],
    ["tuba"], ["cuivres", "brass"], ["timbales", "timpani"], ["percussions", "percussion"],
    ["cloches", "bells", "chimes"], ["celesta"], ["glockenspiel"], ["xylophone"], ["marimba"],
    ["orgue", "organ"], ["clavecin", "harpsichord"], ["piano"], ["guitare", "guitar"],
    ["batterie", "drums", "kit"], ["choeur", "choir", "chorus"], ["voix", "voice", "vox"],
    ["saxophone", "sax"], ["trémolo", "tremolo"], ["sourdine", "mute", "muted"],
  ].map(g => g.map(sansAccents));
  function sansAccents(s) { return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
  // un mot tapé trouve les sons dont un mot COMMENCE par lui (« viol » → violon, violoncelle…),
  // ou qui contiennent l'un de ses équivalents en mot ENTIER (« cor » → horn, mais pas « cordes » ni « accordéon ») ;
  // un mot tapé qui est lui-même un mot connu (« cor », « alto ») doit être entier
  function critere(mot) {
    const equiv = new Set();
    let connu = false;
    for (const g of SYNONYMES) {
      if (g.includes(mot)) connu = true;
      if (g.some(x => x === mot || (mot.length >= 4 && x.startsWith(mot)))) g.forEach(x => equiv.add(" " + x + " "));
    }
    const pluriel = [...equiv].map(x => x.replace(/ $/, "s "));         // « piano » trouve aussi « pianos »
    return s => (!connu && s.mots.some(w => w.startsWith(mot))) || [...equiv, ...pluriel].some(x => s.cle.includes(x));
  }

  let fen = null, champ = null, liste = null, cible = null, items = [], actif = -1;

  // tous les sons proposés à une piste : son d'origine, puis GeneralUser, puis sfizz
  function catalogue(piste) {
    const res = [{id: "gu:orig", moteur: "gu", groupe: "FluidSynth · GeneralUser", nom: `Son d'origine — ${piste.nom}`}];
    for (const s of SONS.gu)                       // un son masqué (doublon) n'est proposé qu'à la piste qui l'a déjà
      if (!s.masque || s.id === piste.son) res.push({id: s.id, moteur: "gu", groupe: "FluidSynth · " + s.groupe, nom: s.nom});
    for (const s of SONS.sf) res.push({id: s.id, moteur: "sf", groupe: "sfizz · " + s.groupe, nom: s.nom});
    for (const s of res) { s.mots = sansAccents(s.nom + " " + s.groupe).split(/[^a-z0-9]+/).filter(Boolean); s.cle = " " + s.mots.join(" ") + " "; }
    return res;
  }
  // nom affiché d'un son (sur le bouton de la piste)
  function nomDe(id, piste) {
    if (id === "gu:orig") return `Son d'origine — ${piste.nom}`;
    const s = (id.startsWith("sf:") ? SONS.sf : SONS.gu).find(x => x.id === id);
    return s ? s.nom : id.replace(/^sf:/, "").split("/").pop().replace(/\.sfz$/i, "").replace(/-/g, " ");
  }

  function construit() {
    fen = document.createElement("div");
    fen.className = "choix-son"; fen.hidden = true;
    fen.setAttribute("role", "dialog"); fen.setAttribute("aria-label", "Choisir un son");
    fen.innerHTML = `<input type="search" class="choix-champ" placeholder="Chercher : cello, flûte, piano, cordes…" aria-label="Chercher un son">
      <div class="choix-liste" role="listbox"></div>`;
    document.body.appendChild(fen);
    champ = fen.querySelector(".choix-champ"); liste = fen.querySelector(".choix-liste");
    champ.addEventListener("input", () => remplit());
    champ.addEventListener("keydown", e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); surligne(actif + (e.key === "ArrowDown" ? 1 : -1)); }
      else if (e.key === "Enter") { e.preventDefault(); if (items[actif]) choisit(items[actif]); }
      else if (e.key === "Escape") { e.preventDefault(); ferme(); }
    });
    liste.addEventListener("click", e => { const el = e.target.closest("[data-i]"); if (el) choisit(items[+el.dataset.i]); });
    liste.addEventListener("mousemove", e => { const el = e.target.closest("[data-i]"); if (el && +el.dataset.i !== actif) surligne(+el.dataset.i, true); });
    document.addEventListener("pointerdown", e => { if (!fen.hidden && !fen.contains(e.target) && e.target !== cible?.bouton) ferme(); });
    window.addEventListener("resize", () => { if (!fen.hidden) place(); });
    document.addEventListener("scroll", e => { if (!fen.hidden && !fen.contains(e.target)) place(); }, true);
  }

  function remplit() {
    const criteres = sansAccents(champ.value).split(/[^a-z0-9]+/).filter(Boolean).map(critere);
    items = catalogue(cible.piste).filter(s => criteres.every(c => c(s)));
    let html = "", groupe = null;
    items.forEach((s, i) => {
      if (s.groupe !== groupe) { groupe = s.groupe; html += `<div class="choix-groupe ${s.moteur}">${echappe(groupe)}</div>`; }
      html += `<div class="choix-son-ligne${s.id === cible.piste.son ? " courant" : ""}" role="option" data-i="${i}">${echappe(s.nom)}</div>`;
    });
    liste.innerHTML = html || `<div class="choix-vide">Aucun son ne correspond.</div>`;
    // en haut de la liste ; sans recherche, on montre le son actuel de la piste
    liste.scrollTop = 0;
    const courant = champ.value.trim() ? -1 : items.findIndex(s => s.id === cible.piste.son);
    if (courant > 0) { surligne(courant, true); liste.querySelector(".actif")?.scrollIntoView({block: "center"}); }
    else surligne(0, true);
  }
  function surligne(i, souris) {
    if (!items.length) { actif = -1; return; }
    actif = Math.max(0, Math.min(items.length - 1, i));
    liste.querySelectorAll(".actif").forEach(el => el.classList.remove("actif"));
    const el = liste.querySelector(`[data-i="${actif}"]`);
    if (el) { el.classList.add("actif"); if (!souris) el.scrollIntoView({block: "nearest"}); }
  }
  function place() {
    const r = cible.bouton.getBoundingClientRect(), L = 400, H = 380;
    const bas = window.innerHeight - r.bottom > H + 8 || r.top < H + 8;
    fen.style.left = Math.max(8, Math.min(r.left, window.innerWidth - L - 8)) + "px";
    fen.style.top = (bas ? r.bottom + 4 : r.top - H - 4) + "px";
  }
  function choisit(s) { const c = cible; ferme(); c.quandChoisi(s.id, s.moteur); c.bouton.focus(); }
  function ferme() { if (fen) fen.hidden = true; cible = null; }

  return {
    // bouton : le bouton de la piste ; piste : l'objet de PISTES ; quandChoisi(id, moteur)
    ouvre(bouton, piste, quandChoisi) {
      if (!fen) construit();
      if (cible && cible.bouton === bouton) return ferme();
      cible = {bouton, piste, quandChoisi};
      champ.value = ""; fen.hidden = false; place(); remplit(); champ.focus();
    },
    ferme, nomDe,
  };
})();
