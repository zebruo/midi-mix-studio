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
// pendant un calcul, les boutons sont grisés (sauf « Quitter » et les touches de la barre de transport)
const occupe = oui => document.querySelectorAll("button").forEach(b => { if (b.id !== "quitter" && !b.classList.contains("touche")) b.disabled = oui; });
