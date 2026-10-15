// Mixeur MIDI — application : réglages généraux, document de travail (ouvrir, appliquer, versions, enregistrer),
// onglets, rendu, exports, cache, démarrage
// (script classique : les variables et fonctions sont partagées entre les fichiers de la page)

const reglages = () => ({version: 1, reverb: +$("#reverb").value, lufs: +$("#lufs").value, fondu: +$("#fondu").value,
  pistes: PISTES.map(p => ({canal: p.canal, prog: p.prog, son: p.son, volume: p.volume, pan: p.pan, muet: p.muet, solo: p.solo}))});
const fmt = {reverb: v => v + " %", lufs: v => v, fondu: v => v + " s"};
for (const id of ["reverb", "lufs", "fondu"]) {
  $("#" + id).addEventListener("input", e => e.target.nextElementSibling.textContent = fmt[id](e.target.value));
  $("#" + id).addEventListener("change", aChange);
}
const bilan = r => `${r.pistes} piste(s) mixée(s) — ` + (r.recalculees ? `${r.recalculees} piste(s) recalculée(s), ` : "")
  + (r.raccords !== undefined ? `montage à ${r.raccords} raccord(s), ` : "")
  + (r.secondes ? `calcul en ${String(r.secondes).replace(".", ",")} s.` : "déjà calculé.");
const nomDe = chemin => String(chemin || "").split(/[\\/]/).pop();

// Ce que joue la barre de transport : le document (mixage), ou l'aperçu du montage en cours (onglet Montage)
const demandeEcoute = () => ONGLET === "montage"
  ? api("/api/montage/ecoute", {fichier: MORCEAU.chemin, segments: MT.segments(), ...reglages()})
  : api("/api/rendu", {fichier: MORCEAU.chemin, cible: "ecoute", ...reglages()});

// Mise à jour automatique : dès qu'on a écouté une fois, chaque réglage (solo, muet, volume, pan, son, écho…)
// ou chaque modification du montage relance le calcul en arrière-plan ; la lecture continue au même endroit.
let minuterie = null, enCours = false, encore = false;
function aChange() {
  REG.note();
  if (ONGLET === "montage") preparePlusTard();
  if (!MORCEAU || !TR.aUnMixage()) return;          // pas encore écouté : ▶ fera le premier calcul
  clearTimeout(minuterie); minuterie = setTimeout(remixe, 250);
}
async function remixe() {
  if (enCours) { encore = true; return; }           // un calcul tourne déjà : on refera avec les derniers réglages
  enCours = true; encore = false;
  const morceau = MORCEAU, mode = ONGLET;
  statut(mode === "montage" ? "Mise à jour du montage…" : "Mise à jour du mixage…");
  try {
    const r = await calcul(demandeEcoute());
    if (!encore && MORCEAU === morceau && ONGLET === mode) { TR.charge(r.url); statut("À jour : " + bilan(r), "ok"); chargeNiveaux(); }
  } catch (e) { statut(e.message, "err"); }
  enCours = false;
  if (encore) remixe(); else cache();
}

// Historique des réglages du mixage (son, volume, pan, muet/solo, écho, volume général, fondu) pour Annuler / Rétablir
// dans l'onglet Mixage. Chaque réglage terminé (curseur relâché, son choisi…) est noté par aChange.
const REG = (() => {
  let hist = [], futur = [], dernier = null;
  const etat = () => JSON.stringify(reglages());
  function va(depuis, vers) {
    if (!depuis.length) return;
    vers.push(dernier); dernier = depuis.pop();
    appliqueReglages(JSON.parse(dernier)); dessine(); aChange();
  }
  return {
    depart() { hist = []; futur = []; dernier = etat(); },   // nouveau morceau
    suit() { dernier = etat(); },                           // nouvelle version du document : les réglages restent
    note() {
      if (dernier === null) return;
      const e = etat(); if (e === dernier) return;
      hist.push(dernier); if (hist.length > 200) hist.shift(); futur = []; dernier = e;
    },
    annuler() { va(hist, futur); }, retablir() { va(futur, hist); },
    peutAnnuler: () => hist.length > 0, peutRetablir: () => futur.length > 0, enAttente: () => false,
  };
})();

// Préparation du retour au Mixage : après une pause de 2,5 s dans les retouches du Montage (aperçu terminé), le
// serveur calcule en arrière-plan le rendu exact des pistes retouchées et la mesure de volume ; appliquer le montage
// en revenant au Mixage les retrouve en cache (≈ 2 s au lieu de 15 s pour une piste longue). Une seule à la fois.
let minuteriePrep = null, prepEnCours = false, prepEncore = false;
function preparePlusTard(delai = 2500) {
  clearTimeout(minuteriePrep);
  minuteriePrep = setTimeout(prepare, delai);
}
async function prepare() {
  if (ONGLET !== "montage" || !MORCEAU || !MT.enAttente()) return;
  if (enCours) return preparePlusTard(1500);               // un aperçu est en cours : il passe d'abord
  if (prepEnCours) { prepEncore = true; return; }
  prepEnCours = true; prepEncore = false;
  try { await api("/api/montage/preparer", {fichier: MORCEAU.chemin, segments: MT.segments(), ...reglages()}); } catch (e) {}
  prepEnCours = false;
  if (prepEncore) preparePlusTard(500);
}

// ───── document de travail
function appliqueReglages(r) {
  // un réglage sans instrument (ancien fichier) vaut pour toutes les lignes de son canal
  for (const s of r.pistes || []) for (const p of PISTES)
    if (p.canal === s.canal && (s.prog == null || s.prog === p.prog)) Object.assign(p, {...s, prog: p.prog});
  if (r.reverb !== undefined) { $("#reverb").value = r.reverb; $("#reverb").nextElementSibling.textContent = r.reverb + " %"; }
  if (r.lufs !== undefined) { $("#lufs").value = r.lufs; $("#lufs").nextElementSibling.textContent = r.lufs; }
  $("#fondu").value = r.fondu || 0; $("#fondu").nextElementSibling.textContent = (r.fondu || 0) + " s";
}
// r = réponse du serveur {doc, morceau}. Ouverture : réglages du .mix.json (ou ceux d'un travail repris).
// Nouvelle version (montage ou texte appliqué, annuler…) : chaque piste garde son son, son volume, son pan…
function appliqueDoc(r, ouverture) {
  const M = r.morceau;
  if (!M.montage || !M.montage.notes)              // page plus récente que le programme qui tourne
    throw new Error(ANCIENNE_VERSION);
  const anciennes = PISTES;
  DOC = r.doc; MORCEAU = M; PISTES = M.pistes;
  let note = "";
  if (ouverture) {
    const reg = ouverture.reglages || M.reglages;
    if (reg) appliqueReglages(reg);
    if (!ouverture.reglages && M.reglages) note = ` · réglages repris de ${M.reglages_fichier}`;
    REGLAGES_ENREGISTRES = ouverture.reference ?? JSON.stringify(reglages());
  } else {
    for (const p of PISTES) {
      const q = anciennes.find(x => x.canal === p.canal && x.prog === p.prog);
      if (q) Object.assign(p, {son: q.son, volume: q.volume, pan: q.pan, muet: q.muet, solo: q.solo});
    }
  }
  ouverture ? REG.depart() : REG.suit();
  const d = Math.round(MORCEAU.duree);
  $("#meta").textContent = `${PISTES.length} pistes · ${fmtDuree(d)}${note}`;
  dessine(); MT.nouveauMorceau(); TX.nouveauMorceau();
  // un autre morceau repart du début ; une nouvelle version du même document garde la position (et la lecture)
  TR[ouverture ? "nouveauMorceau" : "nouveauContenu"](ONGLET === "montage" ? MT.plan() : MORCEAU);
  majDoc();
}
// le montage ou les corrections du texte en cours deviennent une nouvelle version du document
async function appliqueEnAttente() {
  if (!DOC) return true;
  if (ONGLET === "montage" && MT.enAttente()) {
    statut("Application du montage au document…");
    const r = await calcul(api("/api/doc/montage", {doc: DOC.id, segments: MT.segments()}));
    MT.oublie(); appliqueDoc(r);
    statut("Montage appliqué.", "ok");
  } else if (ONGLET === "texte" && TX.enAttente()) {
    statut("Application des corrections au document…");
    const r = await calcul(api("/api/doc/texte", {doc: DOC.id, texte: TX.texte()}));
    if (r.erreurs) {
      TX.montreErreurs(r.erreurs);
      statut(`Le texte a ${r.erreurs.length} erreur(s) : corrigez-les (liste en haut de l'onglet) avant de changer d'onglet ou d'enregistrer.`, "err");
      return false;
    }
    TX.oublie(); appliqueDoc(r);
    statut("Corrections appliquées.", "ok");
  }
  return true;
}
const estModifie = () => !!DOC && (DOC.modifie || JSON.stringify(reglages()) !== REGLAGES_ENREGISTRES || MT.enAttente() || TX.enAttente());
function majDoc() {
  $("#doc").hidden = !DOC;
  if (!DOC) return;
  const m = estModifie(), i = DOC.versions.indexOf(DOC.courante);
  $("#doc-etat").innerHTML = (m ? `<span class="modif">● modifié</span>` : `<span class="ok">✓ enregistré</span>`)
    + ` · ${DOC.copie ? "copie" : "fichier"} <b>${echappe(nomDe(DOC.copie || DOC.original))}</b>`;
  $("#doc-enregistrer").disabled = !m;           // à jour : « Enregistrer » grisé
  $("#doc-script").hidden = !DOC.script;         // morceau fabriqué par un script : « Mettre à jour le script »
  $("#doc-script").title = DOC.script ? `Mettre à jour le script (${DOC.script})` : "";
  const ed = editeur();
  $("#doc-annuler").disabled = !(ed && ed.peutAnnuler()) && i <= 0;
  $("#doc-retablir").disabled = !(ed && ed.peutRetablir()) && (i >= DOC.versions.length - 1 || !!(ed && ed.enAttente()));
  try {
    localStorage.setItem("mixeur.travail", JSON.stringify({doc: DOC.id, original: DOC.original, modifie: m,
      reglages: reglages(), reference: REGLAGES_ENREGISTRES}));
  } catch (e) {}
}
setInterval(majDoc, 300);                        // assez souvent pour que « Enregistrer » s'allume dès un changement
async function versionVoisine(sens) {
  if (!DOC) return;
  const i = DOC.versions.indexOf(DOC.courante) + sens;
  if (i < 0 || i >= DOC.versions.length) return;
  if ((MT.enAttente() || TX.enAttente()) && !confirm("Abandonner le montage ou les corrections pas encore appliqués ?")) return;
  MT.oublie(); TX.oublie();
  try {
    appliqueDoc(await calcul(api("/api/doc/version", {doc: DOC.id, version: DOC.versions[i]})));
    statut(sens < 0 ? "Modification annulée." : "Modification rétablie.", "ok");
  } catch (e) { statut(e.message, "err"); }
}
async function enregistrer(nouvelle) {
  if (!DOC) return statut("Chargez d'abord un morceau.", "err");
  if (!nouvelle && !estModifie()) return statut("Rien à enregistrer : le fichier est à jour.", "ok");   // Ctrl+S
  try {
    if (!(await appliqueEnAttente())) return;
    const r = await api("/api/doc/enregistrer", {doc: DOC.id, reglages: reglages(), nouvelle});
    DOC = r.doc; REGLAGES_ENREGISTRES = JSON.stringify(reglages());
    const nom = nomDe(r.fichier);
    statut(r.genre === "copie"
      ? `Copie enregistrée : ${nom} (notes et réglages). Les « Enregistrer » suivants mettent à jour cette copie.`
      : r.genre === "mid"
      ? `Enregistré : ${nom} (notes et réglages). L'ancienne version est gardée dans le dossier « sauvegardes », à côté du morceau.`
      : `Réglages enregistrés : ${nom.replace(/\.midi?$/i, "")}.mix.json (les notes n'ont pas changé).`, "ok");
    await listeFichiers(); afficheMorceau(); majDoc();
  } catch (e) { statut(e.message, "err"); }
}
// la liste « Morceau » montre le fichier sur lequel on travaille : la copie enregistrée (_v8…) s'il y en a une
function afficheMorceau() {
  if (!DOC) return;
  const f = DOC.copie || DOC.original, sel = $("#fichier");
  if ([...sel.options].some(o => o.value === f)) sel.value = f;
  try { localStorage.setItem("mixeur.fichier", f); } catch (e) {}
}
$("#doc-enregistrer").addEventListener("click", () => enregistrer(false));
$("#doc-version").addEventListener("click", () => enregistrer(true));
// « Mettre à jour le script » : nouvelle version du script générateur (même recette + les retouches du document)
$("#doc-script").addEventListener("click", async () => {
  if (!DOC) return;
  try {
    if (!(await appliqueEnAttente())) return;
    statut("Mise à jour du script…");
    const r = await calcul(api("/api/script/mettre-a-jour", {doc: DOC.id, reglages: reglages()}));
    statut(`Script écrit : ${r.script} (${r.retouches} retouche(s) et les réglages de mixage), à côté de l'original — `
      + (r.ecarts ? `attention : relancé, il diffère encore du morceau en ${r.ecarts} point(s).` : "vérifié : relancé, il redonne exactement ce morceau."),
      r.ecarts ? "err" : "ok");
  } catch (e) { statut(e.message, "err"); }
});
// Annuler / Rétablir, seuls boutons de ce genre de la page : d'abord ce qui se fait dans l'onglet ouvert, un pas
// à la fois (réglages du Mixage, retouches pas encore appliquées du Montage ou des Événements), puis les versions du document.
const editeur = () => ONGLET === "montage" ? MT : ONGLET === "texte" ? TX : REG;
function annulerRetablir(sens) {
  if (!DOC) return;
  const ed = editeur();
  if (ed && (sens < 0 ? ed.peutAnnuler() : ed.peutRetablir())) { sens < 0 ? ed.annuler() : ed.retablir(); return majDoc(); }
  if (sens > 0 && ed && ed.enAttente()) return;     // retouches en cours : les versions suivantes seraient perdues
  versionVoisine(sens);
}
$("#doc-annuler").addEventListener("click", () => annulerRetablir(-1));
$("#doc-retablir").addEventListener("click", () => annulerRetablir(1));
document.addEventListener("keydown", e => {
  const k = e.key.toLowerCase(), c = e.ctrlKey || e.metaKey;
  if (c && k === "s") { e.preventDefault(); enregistrer(false); return; }
  if (saisieEnCours()) return;                    // un champ de saisie garde son propre Ctrl+Z (pas un curseur)
  if (c && k === "z" && !e.shiftKey) { e.preventDefault(); annulerRetablir(-1); }
  else if (c && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); annulerRetablir(1); }
});
window.addEventListener("beforeunload", e => { if (estModifie()) { e.preventDefault(); e.returnValue = ""; } });

// ───── onglets (le montage ou les corrections en cours sont appliqués en quittant l'onglet)
async function onglet(nom) {
  if (ONGLET === nom) return;
  try { if (!(await appliqueEnAttente())) return; } catch (e) { return statut(e.message, "err"); }
  const avant = ONGLET === "montage" || nom === "montage";      // la barre de transport change de contenu
  ONGLET = nom;
  for (const n of ["mixage", "montage", "texte"]) {
    $("#onglet-" + n).setAttribute("aria-selected", n === nom);
    $("#panneau-" + n).hidden = n !== nom;
  }
  document.querySelectorAll(".mixage-seul").forEach(b => b.hidden = nom !== "mixage");
  if (MORCEAU && avant) {
    TR.nouveauContenu(nom === "montage" ? MT.plan() : MORCEAU);
    if (!/appliqu/.test(st.textContent))
      statut(nom === "montage" ? "Montage : la barre de transport joue maintenant le montage (▶ pour l'écouter)."
                               : "La barre de transport joue maintenant le document.");
  }
  if (nom === "montage") MT.dessineTout();
  if (nom === "texte") TX.affiche();
  try { localStorage.setItem("mixeur.onglet", nom); } catch (e) {}
}
$("#onglet-mixage").addEventListener("click", () => onglet("mixage"));
$("#onglet-montage").addEventListener("click", () => onglet("montage"));
$("#onglet-texte").addEventListener("click", () => onglet("texte"));

// choisir un morceau dans la liste l'ouvre aussitôt ; si on renonce (ou en cas d'échec), la liste revient au document en cours
async function charger() {
  const f = $("#fichier").value; if (!f) return;
  if (estModifie() && !confirm("Le document en cours a des modifications non enregistrées. Les abandonner pour charger ce morceau ?"))
    return afficheMorceau();
  occupe(true); statut("Lecture du morceau…");
  try {
    let r;
    try { r = await calcul(api("/api/doc/ouvrir", {fichier: f})); }
    catch (e) { throw e.message === "introuvable" ? new Error(ANCIENNE_VERSION) : e; }
    appliqueDoc(r, {});
    try { localStorage.setItem("mixeur.fichier", f); } catch (e) {}
    statut(ONGLET === "montage" ? "Morceau chargé. Montez ses mesures, puis ▶ pour écouter le montage."
                                : "Morceau chargé. ▶ (ou la barre d'espace) pour écouter ; réglez les pistes pendant l'écoute.", "ok");
  } catch (e) { statut(e.message, "err"); afficheMorceau(); }
  occupe(false);
}
async function rendu(cible) {
  if (!MORCEAU) return statut("Chargez d'abord un morceau.", "err");
  occupe(true);
  statut(cible !== "ecoute" ? "Export en cours…" : ONGLET === "montage"
    ? "Préparation de l'écoute du montage… (le premier rendu d'un morceau prend 10 à 20 secondes)"
    : "Rendu en cours… (le premier rendu d'un morceau prend 10 à 20 secondes)");
  if (cible === "ecoute") TR.calcul(true);                 // la touche ▶ clignote, « calcul… » à l'afficheur
  try {
    if (cible === "ecoute") {
      const r = await calcul(demandeEcoute());
      TR.charge(r.url);
      statut("Prêt : " + bilan(r) + " Les modifications suivantes s'appliquent toutes seules pendant l'écoute.", "ok");
      chargeNiveaux();
    } else {
      // l'export va à côté du morceau (ou de sa copie enregistrée), avec le document tel qu'il est maintenant
      const r = await calcul(api("/api/rendu", {fichier: MORCEAU.chemin, cible, base: DOC && (DOC.copie || DOC.original), ...reglages()}));
      statut(`Exporté : ${r.fichier}`, "ok");
    }
  } catch (e) { statut(e.message, "err"); }
  TR.calcul(false);
  occupe(false); cache();
}
async function cache() { try { const c = await api("/api/cache"); $("#vider").textContent = `Vider le cache (${c.mo} Mo)`; } catch (e) {} }
async function listeFichiers() {
  const fichiers = await api("/api/fichiers"), sel = $("#fichier"), avant = sel.value;
  sel.innerHTML = fichiers.map(f => `<option value="${f.chemin.replace(/"/g, "&quot;")}">${f.affiche}</option>`).join("");
  if (fichiers.some(f => f.chemin === avant)) sel.value = avant;
  return fichiers;
}

$("#fichier").addEventListener("change", charger);
$("#mp3").addEventListener("click", () => rendu("mp3"));
$("#wav").addEventListener("click", () => rendu("wav"));
$("#vider").addEventListener("click", async () => { try { await api("/api/vider_cache", {}); statut("Cache vidé.", "ok"); cache(); } catch (e) { statut(e.message, "err"); } });

// Présence : le mixeur s'arrête tout seul une dizaine de secondes après la fermeture du dernier onglet
// (plus de bouton « Quitter ») ; un rechargement de la page (F5) ne l'arrête pas.
const PAGE_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
// (fetch « keepalive » plutôt que sendBeacon : il part même quand l'onglet se ferme, et peut envoyer du JSON,
// seul format accepté par le serveur)
const presence = (fin = false) => fetch("/api/presence", {method: "POST", keepalive: true,
  headers: {"Content-Type": "application/json"}, body: JSON.stringify({page: PAGE_ID, fin})}).catch(() => {});
presence(); setInterval(presence, 20000);
window.addEventListener("pageshow", e => { if (e.persisted) presence(); });
window.addEventListener("pagehide", () => presence(true));

// numéro de version (fichier VERSION.txt) ; un serveur lancé avant une mise à jour est signalé
async function verifieVersion() {
  try {
    const v = await api("/api/version");
    $("#version").textContent = "v" + v.version;
    return v.version === v.fichier;
  } catch (e) { return false; }                     // serveur trop ancien pour connaître /api/version
}

(async () => {
  try {
    const aJour = await verifieVersion();
    SONS = await api("/api/sons");
    const fichiers = await listeFichiers();
    let dernier = null, mode = null, travail = null;
    try {
      dernier = localStorage.getItem("mixeur.fichier"); mode = localStorage.getItem("mixeur.onglet");
      travail = JSON.parse(localStorage.getItem("mixeur.travail") || "null");
      // brouillons du Montage et des Événements (une clé par version de document) : seuls ceux du travail
      // non enregistré, qui peut être repris, sont gardés ; les autres ne serviront plus
      const garde = travail && travail.modifie ? travail.doc : null;
      for (const k of Object.keys(localStorage))
        if (/^mixeur\.(montage|texte):/.test(k) && !(garde && k.includes(garde))) localStorage.removeItem(k);
    } catch (e) {}
    const q = new URLSearchParams(location.search);
    const demande = q.get("f");                                              // ?f=chemin : ouvre ce morceau
    if (demande && fichiers.some(f => f.chemin === demande)) dernier = demande;
    if (q.get("onglet")) mode = q.get("onglet");                              // ?onglet=montage
    if (mode === "montage" || mode === "texte") await onglet(mode);
    statut(`${fichiers.length} morceaux trouvés · ${SONS.gu.filter(s => !s.masque).length} sons GeneralUser · ${SONS.sf.length} sons sfizz.`);
    if (!aJour) return statut(ANCIENNE_VERSION, "err");
    cache();
    // un travail non enregistré est proposé à la reprise
    if (travail && travail.modifie && !demande) {
      try {
        const r = await api("/api/doc/reprendre", {doc: travail.doc});
        if (confirm(`Reprendre le travail non enregistré sur « ${nomDe(r.doc.copie || r.doc.original)} » ?`)) {
          appliqueDoc(r, {reglages: travail.reglages, reference: travail.reference});
          afficheMorceau();
          return statut("Travail repris là où vous l'aviez laissé (pas encore enregistré).", "ok");
        }
      } catch (e) {}
    }
    if (dernier && fichiers.some(f => f.chemin === dernier)) { $("#fichier").value = dernier; charger(); }   // reprend le dernier morceau
  } catch (e) { statut("Le mixeur ne répond pas : relancez-le depuis le raccourci du bureau. (" + e.message + ")", "err"); }
})();
