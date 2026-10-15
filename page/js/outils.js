// Mixeur MIDI — outils communs : raccourci $, dialogue avec le serveur, messages, état du morceau
// (script classique : les variables et fonctions sont partagées entre les fichiers de la page)

const $ = s => document.querySelector(s);
const st = $("#status");
let SONS = {gu: [], sf: []}, MORCEAU = null, PISTES = [];
let ONGLET = "mixage";            // « mixage », « montage » ou « texte » : l'onglet ouvert
// Document de travail (copie du morceau, côté serveur) : {id, original, copie, versions, courante, enregistree, modifie}.
// MORCEAU est l'analyse de sa version courante ; les trois onglets travaillent sur ce même document.
let DOC = null, REGLAGES_ENREGISTRES = "";

function statut(txt, genre = "") { st.textContent = txt; st.className = "status " + genre; }
async function api(url, corps) {
  const r = await fetch(url, corps === undefined ? {} : {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(corps)});
  const j = await r.json();
  if (!r.ok) throw new Error(j.erreur || "erreur");
  return j;
}
// Pendant un calcul, les boutons et la liste des morceaux sont grisés et inactifs (sauf les touches de la barre de
// transport) : la classe « occupe » sur la page suffit (voir common.css), l'état propre de chaque bouton (grisé
// faute de sélection, etc.) n'est jamais touché, donc rien à restaurer après.
const calculEnCours = () => document.body.classList.contains("occupe");
const occupe = oui => document.body.classList.toggle("occupe", oui);
const BLOQUE = "button:not(.touche), #fichier";
for (const type of ["click", "mousedown", "keydown"])  // ni clic, ni ouverture de la liste, ni Entrée / Espace
  document.addEventListener(type, e => {
    if (!calculEnCours() || !e.target.closest?.(BLOQUE)) return;
    if (type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault(); e.stopPropagation();
  }, true);
const ANCIENNE_VERSION = "Le mixeur qui tourne est une ancienne version : fermez cet onglet, attendez une quinzaine de secondes, "
  + "puis relancez-le par le raccourci du bureau.";

// Indicateur « Calcul » de la barre de transport, toujours visible : « prêt » ; pendant un calcul du serveur
// (écoute, mise à jour automatique, export, vumètres…) l'anneau tourne avec le temps écoulé ; ensuite une coche et
// « à jour · durée » restent affichées 5 s (un calcul très court laisse ainsi une trace lisible), puis « prêt ».
// Usage : const r = await calcul(api(…));
const calcul = (() => {
  const RETOUR_PRET = 5000;                           // ms : « à jour » / « échec » restent affichés, puis « prêt »
  let n = 0, debut = 0, minuterie = null, echec = false, retour = null;
  const ecrit = (etat, txt) => { $("#t-calcul").className = "bloc calcul-bloc " + etat; $("#t-calcul-s").textContent = txt; };
  const secondes = () => (performance.now() - debut) / 1000;
  return async promesse => {
    if (n++ === 0) {
      clearTimeout(retour);
      debut = performance.now(); echec = false;
      ecrit("actif", "0 s");
      minuterie = setInterval(() => ecrit("actif", Math.floor(secondes()) + " s"), 250);
    }
    try { return await promesse; }
    catch (e) { echec = true; throw e; }            // le message d'erreur reste affiché en bas de la page
    finally {
      if (--n === 0) {
        clearInterval(minuterie);
        const s = secondes();
        if (echec) ecrit("erreur", "échec");
        else ecrit("fait", "à jour " + (s < 10 ? s.toFixed(1).replace(".", ",") : Math.round(s)) + " s");
        retour = setTimeout(() => ecrit("repos", "prêt"), RETOUR_PRET);
      }
    }
  };
})();

// ───── icônes : une seule source par icône, page/icones/<nom>.svg (dessins faits main, 16 × 16, couleur du texte).
// Dans la page : <svg viewBox="0 0 16 16" data-icone="nom"></svg> ; le dessin du fichier y est recopié, ce qui garde
// la couleur du bouton (currentColor), ses états (ambre, grisé…) et les masques internes (disquette « copie »).
const ICONES = {};
function icone(el, nom) {
  if (!el || (el.dataset.icone === nom && el.childNodes.length)) return;
  el.dataset.icone = nom;
  ICONES[nom] ??= fetch(`icones/${nom}.svg`).then(r => r.text())
    .then(t => new DOMParser().parseFromString(t, "image/svg+xml").documentElement);
  ICONES[nom].then(svg => {
    if (el.dataset.icone === nom) el.replaceChildren(...[...svg.childNodes].map(n => document.importNode(n, true)));
  });
}
document.querySelectorAll("svg[data-icone]").forEach(el => icone(el, el.dataset.icone));

// ───── petites fonctions communes aux onglets
// texte inséré dans du HTML (contenu ou valeur d'attribut entre guillemets)
const echappe = s => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
// nom d'une note MIDI en français, Do3 = do du milieu (60) ; la batterie (canal 10) est traitée par chaque onglet
const NOMS_NOTES = ["Do", "Do♯", "Ré", "Ré♯", "Mi", "Fa", "Fa♯", "Sol", "Sol♯", "La", "La♯", "Si"];
const nomNoteMidi = n => NOMS_NOTES[n % 12] + (Math.floor(n / 12) - 2);
// identifiant d'une ligne de la console : « 7 », ou « 7:71 » pour un canal joué par plusieurs instruments
// (mêmes clés que le serveur : montage.cle_ligne)
const cleLigne = p => p.prog == null ? String(p.canal) : `${p.canal}:${p.prog}`;
// durée en « 3 min 49 »
const fmtDuree = s => { s = Math.round(s); return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")}`; };
// Ctrl+Z, Suppr, flèches… ne doivent pas agir pendant une saisie : champ de texte, liste, zone de texte ;
// un curseur (input range) ne compte que si `curseurs` (l'onglet Montage utilise les flèches et Suppr)
const saisieEnCours = (curseurs = false) => {
  const el = document.activeElement;
  return !!el && /INPUT|SELECT|TEXTAREA/.test(el.tagName) && (curseurs || el.type !== "range");
};
