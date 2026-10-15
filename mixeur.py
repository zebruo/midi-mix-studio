"""Mixeur MIDI — console de mixage locale (V1).

Lance un petit serveur sur http://localhost:8765 (accessible seulement depuis ce PC) et ouvre la console
dans le navigateur. Chaque piste d'un fichier .mid est rendue avec FluidSynth + GeneralUser GS ou avec
sfizz (Salamander, Virtual Playing Orchestra), mise en cache, puis mixée avec ffmpeg.

Lancement : pythonw mixeur.py   (ou le raccourci « Mixeur MIDI » du bureau)
"""
import hashlib
import http.server
import io
import json
import math
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser

import mido

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # lancé avec « python -I » : on ajoute son propre dossier
import montage  # noqa: E402
import midi_texte  # noqa: E402   (.mid ⇄ texte commenté, aussi utilisable seul en ligne de commande)
import travail  # noqa: E402      (documents de travail : versions, enregistrement)
import retouches  # noqa: E402    (retouches d'un morceau fabriqué par un script, reportées dans le script)

ICI = os.path.dirname(os.path.abspath(__file__))
CONFIG = json.load(open(os.path.join(ICI, "config.json"), encoding="utf-8"))


def lit_version():
    """Numéro de version de l'application (fichier VERSION.txt, MAJEUR.MINEUR.CORRECTIF)."""
    try:
        return open(os.path.join(ICI, "VERSION.txt"), encoding="utf-8-sig").read().strip()   # -sig : BOM du Bloc-notes
    except OSError:
        return "?"


VERSION = lit_version()          # lu au lancement : s'il diffère du fichier, le serveur qui tourne est ancien
PAGE = os.path.join(ICI, "page")
CACHE = os.path.join(ICI, "cache")
PISTES = os.path.join(CACHE, "pistes")
ECOUTE = os.path.join(CACHE, "ecoute")
MONTAGES = os.path.join(CACHE, "montages")     # montages assemblés dont des notes ont été retouchées (pour l'écoute)
for d in (PISTES, ECOUTE, MONTAGES):
    os.makedirs(d, exist_ok=True)
TRAVAUX = travail.Travail(os.path.join(CACHE, "travail"))   # documents de travail (jamais vidés par « Vider le cache »)
VERROU = threading.Lock()
QUEUE = 4.0          # secondes rendues après la dernière note (résonance, écho de salle)
RENDU = "tempo-fixe+silences4+repetitions"  # version de la façon de rendre les pistes : la changer invalide les écoutes en cache
SANS_FENETRE = 0x08000000 if os.name == "nt" else 0       # pas de fenêtre noire pour les outils

GM_FR = midi_texte.GM_FR      # noms français des 128 instruments General MIDI
FAMILLES = ["Pianos", "Percussions chromatiques", "Orgues", "Guitares", "Basses", "Cordes", "Ensembles",
            "Cuivres", "Anches", "Flûtes", "Synthé lead", "Synthé nappes", "Synthé effets",
            "Instruments du monde", "Percussions", "Effets sonores"]


# ───────────────────────────── catalogue des sons ─────────────────────────────
def presets_sf2(chemin):
    """Liste (banque, programme, nom) lue dans le fichier .sf2 (bloc phdr)."""
    d = open(chemin, "rb").read()
    i = d.find(b"phdr")
    n = struct.unpack("<I", d[i + 4:i + 8])[0] // 38
    out = []
    for k in range(n - 1):
        r = d[i + 8 + k * 38:i + 8 + (k + 1) * 38]
        nom = r[:20].split(b"\0")[0].decode("latin1").strip()
        prog, banque = struct.unpack("<HH", r[20:24])
        out.append((banque, prog, nom))
    return sorted(out)


def catalogue():
    gu = []
    for banque, prog, nom in presets_sf2(CONFIG["generaluser"]):
        # batteries : le rendu passe tout seul la piste sur le canal 10 (voir piste_seule), donc un kit va sur n'importe
        # quelle piste ; la banque 120 répète les kits de la banque 128 : masquée dans la liste, gardée pour les anciens réglages
        if banque == 128:
            groupe, libelle = "Batteries", f"Batterie {nom}"
        elif banque == 120:
            kit = re.sub(r"(?i)\s*kit$", "", nom)
            gu.append({"id": f"gu:{banque}:{prog}", "groupe": "Batteries", "nom": f"Batterie {kit}", "masque": True})
            continue
        elif banque == 0:
            groupe, libelle = FAMILLES[prog // 8], f"{prog} {GM_FR[prog]}"
        else:                                       # son propre à GeneralUser : son nom, puis sa famille General MIDI
            groupe, libelle = "Variantes", f"{nom} ({FAMILLES[prog // 8].lower()}, banque {banque})"
        gu.append({"id": f"gu:{banque}:{prog}", "groupe": groupe, "nom": libelle})
    ordre = {g: i for i, g in enumerate(FAMILLES + ["Variantes", "Batteries"])}
    gu.sort(key=lambda s: (ordre[s["groupe"]], s["id"].split(":")[1] != "0", int(s["id"].split(":")[2])))
    sf = []
    base = CONFIG["dossier_sfz"]
    for racine, _, fichiers in os.walk(base):
        for f in fichiers:
            if f.lower().endswith(".sfz"):
                rel = os.path.relpath(os.path.join(racine, f), base).replace("\\", "/")
                parties = rel.split("/")
                if parties[0].startswith("Salamander"):
                    groupe = "Piano Salamander"
                elif "Virtual-Playing-Orchestra3" in rel:
                    fam = {"Brass": "Cuivres", "Keys": "Claviers", "Percussion": "Percussions",
                           "Strings": "Cordes", "Vocals": "Voix", "Woodwinds": "Bois"}
                    groupe = "Orchestre VPO — " + fam.get(parties[2], parties[2])
                else:
                    groupe = parties[0]
                nom = f[:-4].replace("-", " ")
                note = " (mode de jeu à commander)" if re.search(r"(?i)KS|mod-wheel", f) else ""
                sf.append({"id": "sf:" + rel, "groupe": groupe, "nom": nom + note})
    sf.sort(key=lambda s: (s["groupe"] != "Piano Salamander", s["groupe"], s["nom"]))
    return {"gu": gu, "sf": sf}


# ───────────────────────────── analyse d'un fichier MIDI ─────────────────────────────
NOMS_SFZ = [("Salamander", "Piano (Salamander)"), ("all-strings", "Cordes"), ("1st-violin", "Violons I"),
            ("2nd-violin", "Violons II"), ("viola", "Altos"), ("cello", "Violoncelle"), ("bass-SEC", "Contrebasses"),
            ("harp", "Harpe"), ("celesta", "Célesta"), ("french-horn", "Cor"), ("trumpet", "Trompette"),
            ("trombone", "Trombone"), ("tuba", "Tuba"), ("flute", "Flûte"), ("oboe", "Hautbois"),
            ("clarinet", "Clarinette"), ("bassoon", "Basson"), ("glockenspiel", "Glockenspiel"),
            ("xylophone", "Xylophone"), ("vibraphone", "Vibraphone"), ("timpani", "Timbales")]


def nom_sfz(rel):
    """Nom français d'une banque sfizz (ex. « Violoncelle (orchestre VPO) »)."""
    f = os.path.basename(rel)
    for cle, nom in NOMS_SFZ:
        if cle.lower() in f.lower():
            return nom if cle == "Salamander" else f"{nom} (orchestre VPO)"
    return f[:-4].replace("-", " ")


def dans_racines(chemin, travail_compris=True):
    """Fichier autorisé : dans un dossier « racines » de config.json, ou un document de travail du mixeur."""
    p = os.path.abspath(chemin)
    dossiers = list(CONFIG["racines"]) + ([TRAVAUX.dossier] if travail_compris else [])

    def dedans(r):
        try:
            return os.path.commonpath([p, os.path.abspath(r)]) == os.path.abspath(r)
        except ValueError:                          # autre lecteur (D: contre C:…) : forcément dehors
            return False
    return any(dedans(r) for r in dossiers)


def verifie_chemin(chemin, travail_compris=True):
    """Refuse un fichier absent ou hors des dossiers autorisés (seul contrôle des chemins reçus de la page)."""
    if not dans_racines(chemin, travail_compris) or not os.path.exists(chemin):
        raise ValueError("Fichier introuvable ou hors des dossiers autorisés.")


def liste_fichiers():
    res = []
    for r in CONFIG["racines"]:
        for racine, dossiers, fichiers in os.walk(r):
            # ni dossiers cachés, ni les sauvegardes faites par « Enregistrer » (travail.DOSSIER_SAUVEGARDES)
            dossiers[:] = [d for d in dossiers if not d.startswith(".") and d.lower() != travail.DOSSIER_SAUVEGARDES]
            for f in fichiers:
                if f.lower().endswith((".mid", ".midi")):
                    p = os.path.join(racine, f)
                    res.append({"chemin": p, "affiche": os.path.relpath(p, r)})
    return sorted(res, key=lambda x: x["affiche"].lower())


def carte_tempos(mid):
    """Segments de tempo / de mesure : [{t (s), mesure (depuis 0, décimale), bpm, num, den}] pour la barre de transport."""
    tpb = mid.ticks_per_beat
    evts = []
    for tr in mid.tracks:
        t = 0
        for m in tr:
            t += m.time
            if m.type in ("set_tempo", "time_signature"):
                evts.append((t, m))
    evts.sort(key=lambda e: e[0])
    tempo, num, den = 500000, 4, 4
    sec, mesures, prec = 0.0, 0.0, 0
    segs = [{"t": 0.0, "mesure": 0.0, "bpm": 120.0, "num": 4, "den": 4, "tick": 0}]
    for tick, m in evts:
        dt = tick - prec
        sec += dt / tpb * tempo / 1e6
        mesures += dt / tpb / (num * 4 / den)
        prec = tick
        if m.type == "set_tempo":
            tempo = m.tempo
        else:
            num, den = m.numerator, m.denominator
        seg = {"t": round(sec, 6), "mesure": round(mesures, 6), "bpm": round(60e6 / tempo, 2), "num": num, "den": den, "tick": tick}
        if segs[-1]["tick"] == tick:
            segs[-1] = seg
        else:
            segs.append(seg)
    return segs


def analyse(chemin, reglages_de=None):
    """Pistes, tempos, structure… du fichier ; réglages lus dans le .mix.json de `reglages_de` (le morceau
    d'origine quand `chemin` est un document de travail), sinon de `chemin`."""
    mid = mido.MidiFile(chemin)
    infos = {}
    for tr in mid.tracks:
        for m in tr:
            if not hasattr(m, "channel"):
                continue
            c = infos.setdefault(m.channel, {"notes": 0, "progs": [], "pan": 64})
            if m.type == "note_on" and m.velocity > 0:
                c["notes"] += 1
            elif m.type == "program_change" and (not c["progs"] or c["progs"][-1] != m.program):
                c["progs"].append(m.program)
            elif m.type == "control_change" and m.control == 10:
                c["pan"] = m.value
    # canaux joués par plusieurs instruments : une ligne par instrument (ex. clarinette puis piano sur le canal 7)
    partages, chg, av = montage.instruments_par_canal(mid), montage.programmes(mid), mid.ticks_per_beat // 8
    par_instrument = {}
    for d, _, on, _ in montage.notes(mid):
        if on.channel in partages:
            cle = (on.channel, montage.programme_a(chg.get(on.channel, []), d, av))
            par_instrument[cle] = par_instrument.get(cle, 0) + 1
    pistes = []
    defaut_sf = CONFIG["canaux_sfz_par_defaut"]
    for ch in sorted(infos):
        c = infos[ch]
        if not c["notes"]:
            continue
        if ch in partages:
            for prog in partages[ch]:
                pistes.append({"canal": ch, "prog": prog, "nom": GM_FR[prog], "notes": par_instrument.get((ch, prog), 0),
                               "son": "gu:orig", "volume": 70, "pan": round((c["pan"] - 64) / 63 * 100),
                               "muet": False, "solo": False})
            continue
        if ch == 9:
            nom = "Percussions"
        elif c["progs"]:
            nom = " / ".join(dict.fromkeys(GM_FR[p] for p in c["progs"]))
        elif str(ch) in defaut_sf:
            nom = nom_sfz(defaut_sf[str(ch)])
        else:
            nom = "Piano acoustique (sans changement d'instrument)"
        if not c["progs"] and str(ch) in defaut_sf and ch != 9:
            son = "sf:" + defaut_sf[str(ch)]
        else:
            son = "gu:orig"
        pistes.append({"canal": ch, "prog": None, "nom": nom, "notes": c["notes"], "son": son,
                       "volume": 70, "pan": round((c["pan"] - 64) / 63 * 100),
                       "muet": False, "solo": False})
    reglages = os.path.splitext(reglages_de or chemin)[0] + ".mix.json"
    sauve = None
    if os.path.exists(reglages):
        try:
            sauve = json.load(open(reglages, encoding="utf-8"))
        except (OSError, ValueError):
            sauve = None
    return {"chemin": chemin, "duree": round(mid.length, 1), "pistes": pistes, "reglages": sauve,
            "tempos": carte_tempos(mid), "montage": montage.structure(mid),
            "reglages_fichier": os.path.basename(reglages)}


# ───────────────────────────── rendu d'une piste ─────────────────────────────
_MIDS = {}


def lis_mid(chemin):
    """Fichier MIDI lu une seule fois tant qu'il ne change pas (le rendu des pistes le relit pour chacune)."""
    st = os.stat(chemin)
    cle = (os.path.abspath(chemin), st.st_mtime_ns, st.st_size)
    if cle not in _MIDS:
        if len(_MIDS) > 20:
            _MIDS.clear()
        _MIDS[cle] = mido.MidiFile(chemin)
    return _MIDS[cle]


def piste_seule(chemin, canal, son, prog=None):
    """Fichier MIDI réduit à un canal (tempos conservés), prêt pour le moteur choisi.
    prog : pour un canal joué par plusieurs instruments, ne garder que les notes de cet instrument."""
    src = lis_mid(chemin)
    evts = []
    for tr in src.tracks:
        t = 0
        for m in tr:
            t += m.time
            if m.is_meta and m.type in ("set_tempo", "time_signature", "key_signature"):
                evts.append((t, 0, m))
            elif hasattr(m, "channel") and m.channel == canal:
                evts.append((t, 1, m))
    cible = canal
    if prog is not None:
        evts.sort(key=lambda e: (e[0], e[1]))
        chg = sorted((t, m.program) for t, k, m in evts if k and m.type == "program_change")
        av, ouvertes, garde = src.ticks_per_beat // 8, {}, []
        for t, k, m in evts:
            if k and m.type == "note_on" and m.velocity > 0:
                ok = montage.programme_a(chg, t, av) == prog
                ouvertes.setdefault(m.note, []).append(ok)
            elif k and m.type in ("note_on", "note_off"):
                pile = ouvertes.get(m.note)
                ok = pile.pop(0) if pile else False
            elif k and m.type == "program_change":
                ok = False                       # l'instrument de la ligne est posé au début
            else:
                ok = True
            if ok:
                garde.append((t, k, m))
        evts = garde + [(0, 1, mido.Message("program_change", channel=canal, program=prog))]
    # le panoramique est réglé par la console : on neutralise celui du fichier (sinon appliqué deux fois)
    evts = [e for e in evts if not (e[1] and e[2].type == "control_change" and e[2].control == 10)]
    evts.append((0, 0, mido.Message("control_change", channel=canal, control=10, value=64)))
    if son.startswith("gu:") and son != "gu:orig":
        _, banque, prog = son.split(":")
        banque, prog = int(banque), int(prog)
        cible = 9 if banque == 128 else (0 if canal == 9 else canal)
        evts = [e for e in evts if not (e[1] and (e[2].type == "program_change"
                or (e[2].type == "control_change" and e[2].control in (0, 32))))]
        if banque not in (0, 128):
            evts.append((0, 0, mido.Message("control_change", channel=cible, control=0, value=banque)))
        evts.append((0, 0, mido.Message("program_change", channel=cible, program=prog)))
    elif son.startswith("sf:"):
        evts = [e for e in evts if not (e[1] and e[2].type == "program_change")]
    evts.sort(key=lambda e: (e[0], e[1]))
    out = mido.MidiFile(ticks_per_beat=src.ticks_per_beat)
    tr = mido.MidiTrack()
    prec = 0
    for t, _, m in evts:
        if m.type == "end_of_track":
            continue
        m = m.copy(time=t - prec)
        if hasattr(m, "channel"):
            m = m.copy(channel=cible)
        tr.append(m)
        prec = t
    # la fin du fichier est repoussée de QUEUE secondes : les dernières notes et l'écho s'éteignent naturellement
    tempo = next((m.tempo for t, _, m in reversed(evts) if m.type == "set_tempo"), 500000)
    fin = max([sum(m.time for m in piste) for piste in src.tracks] + [prec])
    queue = round(QUEUE * 1e6 / tempo * src.ticks_per_beat)
    tr.append(mido.MetaMessage("marker", text="fin + résonance", time=fin + queue - prec))
    tr.append(mido.MetaMessage("end_of_track", time=0))
    out.tracks.append(tr)
    return aplatit_tempo(out)


def aplatit_tempo(mid, tpb=1920, tempo=500000):
    """Même musique, même minutage à la milliseconde près, mais à tempo fixe (120 à la noire, 1920 ticks par temps).
    sfizz_render perd parfois une fin de note quand le tempo change souvent (ex. 71 changements dans le psaume 25 :
    une note restait suspendue jusqu'à la fin du morceau) ; à tempo fixe, le défaut disparaît."""
    src = mid.tracks[0]
    t, prec, sec, tp, ev = 0, 0, 0.0, 500000, []
    for m in src:
        t += m.time
        sec += (t - prec) / mid.ticks_per_beat * tp / 1e6
        prec = t
        if m.type == "set_tempo":
            tp = m.tempo
            continue
        ev.append((sec, m))
    places = [(round(s * 1e6 / tempo * tpb), m) for s, m in ev]
    out = mido.MidiFile(ticks_per_beat=tpb)
    tr = mido.MidiTrack()
    tr.append(mido.MetaMessage("set_tempo", tempo=tempo, time=0))
    p = 0
    for k, m in places:
        tr.append(m.copy(time=k - p))
        p = k
    out.tracks.append(tr)
    return out


def fondus_silences(seule, resonance=2.0, cordes=False):
    """Filtre ffmpeg qui éteint en douceur une piste sfizz dans ses silences.
    sfizz garde parfois à mi-volume la dernière note avant un silence (quand la même note a été rejouée pendant que
    la précédente s'éteignait) : elle traîne alors jusqu'à la note suivante. Dans chaque silence d'au moins 0,6 s,
    on laisse la résonance naturelle (jusqu'à `resonance` s), puis le son s'éteint en 0,3 s jusqu'à la note suivante.
    `seule` est une piste à tempo fixe (aplatit_tempo) : 1 temps = 0,5 s."""
    sec = lambda k: k / seule.ticks_per_beat * 0.5
    t, sonne, evs = 0, {}, []
    for m in seule.tracks[0]:
        t += m.time
        if m.type == "note_on" and m.velocity:
            sonne[m.note] = sonne.get(m.note, 0) + 1
            evs.append(("debut", sec(t)))
        elif m.type in ("note_on", "note_off"):
            sonne[m.note] = max(0, sonne.get(m.note, 0) - 1)
            if not any(sonne.values()):
                evs.append(("silence", sec(t)))
    filtres = []
    for i, (genre, s) in enumerate(evs):
        if genre != "silence":
            continue
        suivant = next((x for g, x in evs[i + 1:] if g == "debut"), None)
        fin = suivant - 0.02 if suivant is not None else s + 30
        if fin - s < 0.6:
            continue
        # résonance laissée : 40 % du silence (au moins 0,5 s, au plus `resonance`) ; 1,5 s en fin de morceau.
        # Cordes « sustain » de VPO (violons, altos… dont les notes graves restent souvent suspendues) : arrêt net,
        # comme un archet qu'on lève — l'écho de salle du mixeur, ajouté après, continue de résonner.
        duree = 0.3                                     # durée du fondu
        if suivant is None:
            a = s + 1.5
        elif cordes:                                    # arrêt d'archet net (demandé) : 0,1 s puis fondu de 0,2 s
            a, duree = s + min(0.1, fin - s - 0.25), 0.2
        else:
            a = s + min(resonance, max(0.5, 0.4 * (fin - s)), fin - s - 0.35)
        filtres.append(f"volume='if(lt(t,{a + duree:.3f}),1-(t-{a:.3f})/{duree},0)':eval=frame:enable='between(t,{a:.3f},{fin:.3f})'")
    return ",".join(filtres)


def separe_repetitions(seule, liberation=2.0, maxi=4):
    """sfizz garde à mi-volume, parfois jusqu'à la fin du morceau, une note rejouée pendant que la précédente
    s'éteint (ex. deux Do4 presque liés au psaume 25, mesure 45 du _v8). On répartit donc les notes entre plusieurs
    rendus de la même piste : une note de même hauteur rejouée moins de `liberation` s après la fin de la précédente
    part dans un autre rendu ; le mixeur additionne ensuite les rendus. → liste de MidiFile (un seul si inutile).
    `seule` est une piste à tempo fixe (aplatit_tempo) : 1 temps = 0,5 s."""
    sec = lambda k: k / seule.ticks_per_beat * 0.5
    ev = list(montage._absolus(seule.tracks[0]))
    fins = [{}]                                    # par rendu : fin (s) de la dernière note de chaque hauteur
    flux = {}
    for d, f, on, off in sorted(montage._notes(ev)[0], key=lambda n: n[0]):
        k = next((i for i, fi in enumerate(fins) if sec(d) - fi.get(on.note, -99) > liberation), None)
        if k is None:
            if len(fins) < maxi:
                fins.append({})
                k = len(fins) - 1
            else:                                  # cas extrême : le rendu où la note est la plus ancienne
                k = min(range(len(fins)), key=lambda i: fins[i].get(on.note, -99))
        flux[id(on)] = flux[id(off)] = k
        fins[k][on.note] = sec(f)
    if len(fins) == 1:
        return [seule]
    rendus = []
    for k in range(len(fins)):                     # chaque rendu garde tout le reste (instrument, volume…)
        tr, prec = mido.MidiTrack(), 0
        for t, m in ev:
            if m.type in ("note_on", "note_off") and flux.get(id(m), 0) != k:
                continue
            tr.append(m.copy(time=t - prec))
            prec = t
        mf = mido.MidiFile(ticks_per_beat=seule.ticks_per_beat)
        mf.tracks.append(tr)
        rendus.append(mf)
    return rendus


def rend_piste(chemin, canal, son, prog=None):
    """Renvoie (fichier audio, recalculé ?) ; utilise le cache si la piste n'a pas changé.
    Une piste est reconnue à son CONTENU (ses notes, son instrument, le son choisi) : une correction qui ne touche
    qu'une piste, ou une nouvelle version du document, ne fait recalculer que les pistes réellement modifiées.
    Les pistes sont gardées en FLAC (sans perte, ~4 fois plus léger que le WAV des moteurs)."""
    return rend_midi(piste_seule(chemin, canal, son, prog), son)


# Limite commune à tous les moteurs (sfizz, FluidSynth) lancés en même temps, quel que soit le calcul qui les
# demande (pistes, rendus séparés des notes répétées, fenêtres du montage) : chaque moteur charge ses échantillons
# en mémoire. « rendus_simultanes » (config.json, 4 par défaut) se baisse sur un PC modeste.
MOTEURS = threading.BoundedSemaphore(max(1, int(CONFIG.get("rendus_simultanes", 4))))


def lance_moteur(commande):
    with MOTEURS:
        subprocess.run(commande, check=True, capture_output=True, timeout=600, creationflags=SANS_FENETRE)


def rend_midi(seule, son):
    """Rendu audio (FLAC du cache) d'une piste déjà réduite à tempo fixe (piste_seule, ou un extrait de piste
    pour l'aperçu du montage) → (fichier, recalculé ?). Le cache la reconnaît à son contenu."""
    tampon = io.BytesIO()
    seule.save(file=tampon)
    cle = hashlib.sha1(tampon.getvalue() + f"|{son}|contenu|{RENDU}".encode()).hexdigest()[:20]
    flac = os.path.join(PISTES, cle + ".flac")
    with _verrou_rendu(cle):       # même rendu demandé deux fois (aperçu et préparation) : un seul calcul
        if deja_calcule(flac):
            return flac, False
        return _rend_moteurs(seule, son, cle, flac)


_VERROUS_RENDU, _VERROU_VERROUS = {}, threading.Lock()


def _verrou_rendu(cle):
    with _VERROU_VERROUS:
        return _VERROUS_RENDU.setdefault(cle, threading.Lock())


def _rend_moteurs(seule, son, cle, flac):
    """Le calcul lui-même : moteur(s), rendus séparés des notes répétées, fondus, FLAC du cache."""
    temporaires = []
    try:
        wavs, commandes = [], []
        rendus = separe_repetitions(seule) if son.startswith("sf:") else [seule]
        for k, mf in enumerate(rendus):
            tmp_mid, wav = os.path.join(PISTES, f"{cle}.{k}.mid"), os.path.join(PISTES, f"{cle}.{k}.tmp.wav")
            temporaires += [tmp_mid, wav]
            mf.save(tmp_mid)
            if son.startswith("sf:"):
                sfz = os.path.join(CONFIG["dossier_sfz"], son[3:])
                commandes.append([CONFIG["sfizz_render"], "--sfz", sfz, "--midi", tmp_mid, "--wav", wav,
                                  "-s", "48000", "-q", "3", "--use-eot"])
            else:
                commandes.append([CONFIG["fluidsynth"], "-ni", "-q", "-g", "0.5", "-r", "48000", "-F", wav,
                                  CONFIG["generaluser"], tmp_mid])
            wavs.append(wav)
        if len(commandes) == 1:
            lance_moteur(commandes[0])
        else:                                      # rendus séparés en parallèle, dans la limite commune MOTEURS
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=len(commandes)) as pool:
                list(pool.map(lance_moteur, commandes))
        cordes = son.startswith("sf:") and "/Strings/" in son and "sustain" in son and "harp" not in son
        filtre = fondus_silences(seule, cordes=cordes) if son.startswith("sf:") else ""
        if len(wavs) > 1:                          # rendus séparés (notes répétées) : additionnés, puis les fondus
            chaine = "".join(f"[{k}:a]" for k in range(len(wavs))) + f"amix=inputs={len(wavs)}:normalize=0:duration=longest"
            filtre = chaine + ("," + filtre if filtre else "")
            options = ["-filter_complex", filtre]
        else:
            options = ["-af", filtre] if filtre else []
        subprocess.run([CONFIG["ffmpeg"], "-hide_banner", "-loglevel", "error", "-y",
                        *[a for w in wavs for a in ("-i", w)], *options, "-c:a", "flac", "-sample_fmt", "s32", flac],
                       check=True, capture_output=True, timeout=600, creationflags=SANS_FENETRE)
    finally:
        for t in temporaires:
            if os.path.exists(t):
                os.remove(t)
    return flac, True


def nettoie_cache():
    """Garde le cache sous la taille maximale, en gardant d'abord ce qui est long à refaire.
    Les écoutes (mixages prêts à jouer, ~40 Mo chacune, refaites en 2 s) ont leur part, « cache_ecoutes_mo »
    (500 Mo par défaut) : au-delà, les plus anciennes partent, sauf les 3 plus récentes (celle qu'on écoute).
    Au-delà du plafond « cache_max_mo » partent ensuite les écoutes, puis les montages assemblés, et seulement
    en dernier les pistes rendues (petites, mais jusqu'à 10-20 s de calcul chacune), les moins récemment utilisées."""
    mo = 1024 * 1024
    limite = CONFIG.get("cache_max_mo", 2000) * mo
    part_ecoutes = min(CONFIG.get("cache_ecoutes_mo", 500) * mo, limite // 2)

    def liste(d):
        fs = [os.path.join(d, f) for f in os.listdir(d)]
        return sorted(((os.path.getmtime(f), os.path.getsize(f), f) for f in fs if os.path.isfile(f)))

    def efface(f):
        try:
            os.remove(f)
        except OSError:                            # en cours d'utilisation ou déjà parti : tant pis
            pass

    ecoutes = liste(ECOUTE)
    gardees, ecoutes = ecoutes[-3:], ecoutes[:-3]
    te = sum(s for _, s, _ in ecoutes + gardees)
    while ecoutes and te > part_ecoutes:
        _, s, f = ecoutes.pop(0)
        efface(f)
        te -= s
    candidats = ecoutes + liste(MONTAGES) + liste(PISTES)   # dans l'ordre où ils partiront
    total = te + sum(s for _, s, _ in liste(MONTAGES) + liste(PISTES))
    while candidats and total > limite:
        _, s, f = candidats.pop(0)
        efface(f)
        total -= s


def taille_cache():
    return sum(os.path.getsize(os.path.join(d, f)) for d in (PISTES, ECOUTE, MONTAGES) for f in os.listdir(d))


# ───────────────────────────── mixage ─────────────────────────────
def gain_db(son, volume):
    if volume <= 0:
        return None
    base = 1.0
    if son.startswith("sf:"):
        base = CONFIG["gain_sfz"].get(son[3:], CONFIG["gain_sfz"]["_defaut"])
    return 20 * math.log10(base) + 40 * math.log10(volume / 70)


MESURES = {}   # loudness du mixage complet, mémorisée (le solo ne change pas la référence)


def graphe(rendues, reverb, sources=None):
    """Entrées + filtres ffmpeg qui mixent les pistes (volume, pan, écho sfizz) jusqu'à [mix].
    sources : étiquettes à utiliser à la place des entrées brutes (ex. pistes recollées par le montage)."""
    entrees, chaines, humides, secs = [], [], [], []
    for i, (p, wav) in enumerate(rendues):
        entrees += ["-i", wav]
        pan = max(-100, min(100, p.get("pan", 0))) / 100
        g, d = min(1, 1 - pan), min(1, 1 + pan)
        src = sources[i] if sources else f"[{i}:a]"
        chaines.append(f"{src}aformat=sample_rates=48000:channel_layouts=stereo,volume={gain_db(p['son'], p['volume']):.2f}dB,"
                       f"pan=stereo|c0={g:.2f}*c0|c1={d:.2f}*c1[a{i}]")
        (humides if p["son"].startswith("sf:") and reverb > 0 else secs).append(f"[a{i}]")
    morceaux = []
    if humides:
        dec = "|".join(f"{min(0.9, x * reverb):.3f}" for x in (0.22, 0.17, 0.12, 0.08))
        chaines.append(f"{''.join(humides)}amix=inputs={len(humides)}:normalize=0:duration=longest,"
                       f"aecho=0.8:0.6:43|71|113|167:{dec}[hum]")
        morceaux.append("[hum]")
    morceaux += secs
    chaines.append(f"{''.join(morceaux)}amix=inputs={len(morceaux)}:normalize=0:duration=longest[mix]")
    return entrees, chaines


def choix_pistes(req):
    """Vérifie la demande ; → (chemin, pistes de référence, pistes à entendre, écho, LUFS, solo ?)."""
    chemin = req["fichier"]
    verifie_chemin(chemin)
    pistes = req["pistes"]
    solo = any(p.get("solo") for p in pistes)
    reference = [p for p in pistes if not p.get("muet") and p.get("volume", 0) > 0]
    actives = [p for p in reference if p.get("solo") or not solo]
    if not actives:
        raise ValueError("Aucune piste à entendre : toutes sont muettes, ou à volume 0.")
    reverb = max(0, min(100, req.get("reverb", 35))) / 35
    lufs = max(-24, min(-10, req.get("lufs", -16)))
    return chemin, reference, actives, reverb, lufs, solo


def ligne(p):
    """Identifiant d'une ligne de la console : (canal, instrument) — l'instrument n'est donné que pour un canal
    joué par plusieurs instruments ; les anciens réglages (sans « prog ») restent valables."""
    return p["canal"], p.get("prog")


def finale(req, fin, queue=QUEUE):
    """Fin du mixage (fin = fin de la dernière note, en s).
    Sans fondu : on garde `queue` secondes de résonance. Avec le « Fondu de fin » (1 à 15 s) : le volume baisse
    régulièrement à l'oreille (linéaire en dB, jusqu'à -60 dB) et atteint le silence 1 s après la dernière note."""
    fondu = max(0.0, min(15.0, float(req.get("fondu", 0) or 0)))
    if not fondu:
        return f",atrim=end={fin + queue:.3f}"
    st = max(0.0, fin + 1.0 - fondu)
    d = fin + 1.0 - st
    return (f",volume='if(gte(t,{st:.3f}),pow(10,-3*min((t-{st:.3f})/{d:.3f},1)),1)':eval=frame"
            f",atrim=end={fin + 1.5:.3f}")


def deja_calcule(fichier):
    """Le fichier du cache existe déjà (piste rendue, écoute) ? Il est alors marqué récent pour nettoie_cache."""
    if os.path.exists(fichier) and os.path.getsize(fichier) > 100:
        os.utime(fichier)
        return True
    return False


CODECS = {".wav": ["-c:a", "pcm_s16le"], ".flac": ["-c:a", "flac", "-compression_level", "0"],
          ".mp3": ["-c:a", "libmp3lame", "-b:a", "192k"]}


def ecrit_mixage(req, entrees, chaines, gain, fin, sortie, queue=QUEUE):
    """Dernière étape commune à l'écoute, à l'export et à l'aperçu du montage : gain de référence, limiteur
    (pas de saturation), fin du morceau (finale), puis ffmpeg écrit `sortie` (format d'après son extension)."""
    chaines = chaines + [f"[mix]volume={gain:.2f}dB,alimiter=limit=0.84:level=false,aresample=44100"
                         f"{finale(req, fin, queue)}[out]"]
    subprocess.run([CONFIG["ffmpeg"], "-hide_banner", "-loglevel", "error", "-y", *entrees,
                    "-filter_complex", ";".join(chaines), "-map", "[out]", *CODECS[os.path.splitext(sortie)[1]], sortie],
                   check=True, capture_output=True, timeout=900, creationflags=SANS_FENETRE)
    nettoie_cache()


def rend_pistes(chemin, pistes):
    """Rend (ou reprend du cache) les pistes demandées, plusieurs à la fois : chaque rendu FluidSynth/sfizz
    n'occupe qu'un cœur du processeur. « rendus_simultanes » (config.json, 4 par défaut) limite la mémoire utilisée."""
    from concurrent.futures import ThreadPoolExecutor
    n = max(1, int(CONFIG.get("rendus_simultanes", 4)))
    with ThreadPoolExecutor(max_workers=n) as pool:
        resultats = list(pool.map(lambda p: rend_piste(chemin, p["canal"], p["son"], p.get("prog")), pistes))
    fichiers = {ligne(p): r[0] for p, r in zip(pistes, resultats)}
    return fichiers, sum(r[1] for r in resultats)


def gain_reference(chemin, reference, fichiers, reverb, lufs):
    """Gain qui amène le mixage COMPLET au volume voulu (mesure mémorisée). La mesure est reconnue au CONTENU des
    pistes rendues (leurs fichiers du cache portent l'empreinte de leur contenu) et aux réglages, pas au nom du
    fichier : une nouvelle version du document aux mêmes pistes, ou préparée d'avance (montage), la réutilise."""
    cle = json.dumps([reverb, [(*ligne(p), p["son"], p["volume"], p.get("pan", 0), os.path.basename(fichiers[ligne(p)]))
                               for p in reference]], sort_keys=True)
    if cle not in MESURES:
        e, ch = graphe([(p, fichiers[ligne(p)]) for p in reference], reverb)
        res = subprocess.run([CONFIG["ffmpeg"], "-hide_banner", "-y", *e, "-filter_complex",
                              ";".join(ch) + ";[mix]ebur128=peak=true[m]", "-map", "[m]", "-f", "null", "-"],
                             capture_output=True, timeout=900, creationflags=SANS_FENETRE, check=True)
        txt = res.stderr.decode("utf-8", "replace")
        i_vals = re.findall(r"I:\s+(-?[\d.]+|-inf) LUFS", txt)
        if len(MESURES) > 200:                     # une session longue ne garde que les mesures récentes
            MESURES.clear()
        MESURES[cle] = float(i_vals[-1]) if i_vals and i_vals[-1] != "-inf" else -70.0
    return max(-30.0, min(40.0, lufs - MESURES[cle]))


def mixe(req):
    """Le volume général est calculé sur le mixage COMPLET (pistes non muettes, solo ignoré) puis
    appliqué tel quel, en gain fixe, à ce qu'on écoute : un curseur de piste agit donc toujours,
    une piste en solo s'entend à son niveau dans le mixage, et rien ne disparaît sous un seuil."""
    chemin, reference, actives, reverb, lufs, solo = choix_pistes(req)
    cible = req.get("cible", "ecoute")
    st = os.stat(chemin)
    if cible == "ecoute":     # écoute en FLAC : bien plus rapide à produire que le MP3 (~2 s au lieu de ~6)
        empreinte = hashlib.sha1(json.dumps([req, st.st_mtime_ns, QUEUE, RENDU], sort_keys=True).encode()).hexdigest()[:16]
        sortie = os.path.join(ECOUTE, empreinte + ".flac")
        if deja_calcule(sortie):                                           # ce mixage a déjà été écouté
            return {"fichier": sortie, "url": "/cache/ecoute/" + os.path.basename(sortie), "pistes": len(actives),
                    "recalculees": 0, "secondes": 0, "solo": solo}
    fichiers, recalc = rend_pistes(chemin, reference)
    debut = time.time()
    gain = gain_reference(chemin, reference, fichiers, reverb, lufs)
    # mixage de ce qu'on écoute, avec le même gain + limiteur (pas de saturation)
    e, ch = graphe([(p, fichiers[ligne(p)]) for p in actives], reverb)
    if cible != "ecoute":
        # un document de travail s'exporte à côté du morceau (ou de sa copie enregistrée), pas dans le cache
        nom = req.get("base") if req.get("base") and dans_racines(req["base"], travail_compris=False) else chemin
        base = os.path.splitext(nom)[0] + "_mix"
        ext = ".mp3" if cible == "mp3" else ".wav"
        sortie, k = base + ext, 2
        while os.path.exists(sortie):
            sortie, k = f"{base}_{k}{ext}", k + 1
    ecrit_mixage(req, e, ch, gain, lis_mid(chemin).length, sortie)
    return {"fichier": sortie, "url": "/cache/ecoute/" + os.path.basename(sortie) if cible == "ecoute" else None,
            "pistes": len(actives), "recalculees": recalc, "secondes": round(time.time() - debut, 1),
            "solo": solo}

# ───────────────────────────── vumètres des pistes ─────────────────────────────
PAS_NIVEAU = 0.05      # un niveau toutes les 50 ms


def niveaux_piste(flac):
    """Niveau crête (dB) de la piste rendue, toutes les 50 ms ; gardé en cache à côté du FLAC."""
    cache = os.path.splitext(flac)[0] + ".niv.json"
    if os.path.exists(cache):
        return json.load(open(cache, encoding="utf-8"))
    import numpy as np
    sr = 16000
    raw = subprocess.run([CONFIG["ffmpeg"], "-v", "error", "-i", flac, "-ac", "2", "-ar", str(sr), "-f", "f32le", "-"],
                         check=True, capture_output=True, timeout=300, creationflags=SANS_FENETRE).stdout
    a = np.abs(np.frombuffer(raw, dtype=np.float32))
    n = int(sr * PAS_NIVEAU) * 2
    k = len(a) // n
    crete = a[:k * n].reshape(k, n).max(axis=1)
    res = np.where(crete > 1e-5, 20 * np.log10(np.maximum(crete, 1e-5)), -100).round().astype(int).tolist()
    with open(cache, "w", encoding="utf-8") as f:
        json.dump(res, f)
    return res


def niveaux(req):
    """Pour les vumètres de la console : niveau de chaque piste rendue (avant volume), gain de base de son son,
    et gain général du mixage ; la page y ajoute le volume de chaque piste et suit la lecture."""
    chemin, reference, actives, reverb, lufs, solo = choix_pistes(req)
    fichiers, _ = rend_pistes(chemin, reference)            # pistes muettes ou à 0 : pas de vumètre
    gain = gain_reference(chemin, reference, fichiers, reverb, lufs)
    res = {}
    for p in reference:
        cle = f"{p['canal']}:{p.get('prog')}" if p.get("prog") is not None else str(p["canal"])
        base = gain_db(p["son"], 70) or 0.0
        res[cle] = {"base": round(base, 2), "niv": niveaux_piste(fichiers[ligne(p)])}
    return {"pas": PAS_NIVEAU, "gain": round(gain, 2), "pistes": res}


# ───────────────────────────── banc de montage ─────────────────────────────
AVANT, APRES = 3.0, 4.0      # s rendus autour des mesures retouchées (notes déjà en cours ; résonance)
FONDU_ENTREE, FONDU_SORTIE = 0.1, 0.3
MARGE_SORTIE = 1.5           # le fondu de sortie se fait 1,5 s avant la fin de la fenêtre (ses bords sonnent moins juste)


def extrait(seule, w0, w1):
    """La piste à tempo fixe (piste_seule : 1 temps = 0,5 s) réduite à [w0, w1] s, recalée à 0 : réglages
    d'avant w0 posés au début, notes coupées aux bords (une note déjà en cours est rejouée à 0, dans la partie
    d'avant qui ne sera pas entendue)."""
    tpb = seule.ticks_per_beat
    k0, k1 = round(w0 * 2 * tpb), round(w1 * 2 * tpb)
    notes, autres = montage._notes(list(montage._absolus(seule.tracks[0])))
    ev = [(max(0, t - k0), 1, m) for t, m in autres if t < k1 and m.type != "marker"]
    for d, f, on, off in notes:
        if f > k0 and d < k1:
            ev += [(max(d, k0) - k0, 2, on), (min(f, k1) - k0, 0, off)]
    ev.sort(key=lambda e: (e[0], e[1]))
    out, tr, prec = mido.MidiFile(ticks_per_beat=tpb), mido.MidiTrack(), 0
    for t, _, m in ev:
        tr.append(m.copy(time=t - prec))
        prec = t
    tr.append(mido.MetaMessage("end_of_track", time=max(0, k1 - k0 - prec)))
    out.tracks.append(tr)
    return out


def zones_retouchees(plages, plages_s):
    """Zones du montage (en s, sur le temps du montage) occupées par des mesures retouchées, celles qui sont
    proches réunies (leurs fenêtres de rendu se chevaucheraient)."""
    zones, pos = [], 0.0
    for (a, b, notes), (s0, s1) in zip(plages, plages_s):
        if notes is not None:
            if zones and pos - AVANT < zones[-1][1] + APRES:
                zones[-1][1] = pos + s1 - s0
            else:
                zones.append([pos, pos + s1 - s0])
        pos += s1 - s0
    return zones


def fichier_montage(mid, segments):
    """Le montage assemblé, enregistré dans cache\\montages sous un nom tiré de son contenu (même montage → même
    fichier, déjà là) ; écrit d'abord sous un nom provisoire unique (plusieurs calculs peuvent tourner à la fois)."""
    tampon = io.BytesIO()
    montage.assemble(mid, segments).save(file=tampon)
    donnees = tampon.getvalue()
    chemin_m = os.path.join(MONTAGES, hashlib.sha1(donnees).hexdigest()[:20] + ".mid")
    if not os.path.exists(chemin_m):
        tmp = f"{chemin_m}.{threading.get_ident()}.tmp"
        with open(tmp, "wb") as f:
            f.write(donnees)
        os.replace(tmp, chemin_m)
    return chemin_m


def prepare_montage(req):
    """Pendant qu'on travaille dans le Montage (la page l'appelle après une pause de retouches), prépare ce que
    l'écoute du document demandera quand le montage lui sera appliqué en revenant au Mixage : le rendu EXACT des
    pistes retouchées (l'aperçu n'en rend que des fenêtres) et la mesure du volume de référence. Le document
    assemblé est le même fichier (même contenu) : les pistes et la mesure, reconnues à leur contenu, sont reprises.
    Ne prend pas le VERROU (les aperçus continuent) ; les moteurs restent dans la limite commune MOTEURS."""
    chemin, reference, actives, reverb, lufs, solo = choix_pistes(req)
    mid = lis_mid(chemin)
    plages = montage.normalise(req["segments"], len(montage.bornes_mesures(mid)) - 1)
    if not montage.canaux_modifies(mid, plages):
        return {"preparees": 0}
    chemin_m = fichier_montage(mid, req["segments"])
    fichiers, recalc = rend_pistes(chemin_m, reference)
    gain_reference(chemin_m, reference, fichiers, reverb, lufs)
    return {"preparees": recalc}


def ecoute_montage(req):
    """Écoute rapide d'un montage : chaque piste rendue de l'original est recollée selon les plages, puis mixée
    (mêmes réglages et même volume de référence que l'original). Pour une piste dont des notes ont été retouchées,
    seules des fenêtres autour des mesures retouchées sont rendues (depuis le montage assemblé) et viennent
    remplacer, par un fondu enchaîné, l'original recollé : quelques secondes de calcul au lieu de toute la piste.
    Si les retouches couvrent une grande partie du morceau, la piste est rendue entière."""
    chemin, reference, actives, reverb, lufs, solo = choix_pistes(req)
    st = os.stat(chemin)
    mid = mido.MidiFile(chemin)
    bornes = montage.bornes_mesures(mid)
    plages = montage.normalise(req["segments"], len(bornes) - 1)
    reponse = {"pistes": len(actives), "solo": solo, "raccords": sum(1 for k in range(1, len(plages))
                                                                     if plages[k - 1][1] + 1 != plages[k][0])}
    empreinte = hashlib.sha1(json.dumps([req, st.st_mtime_ns, "montage4-fenetres", QUEUE, RENDU], sort_keys=True).encode()).hexdigest()[:16]
    sortie = os.path.join(ECOUTE, empreinte + ".flac")
    url = "/cache/ecoute/" + os.path.basename(sortie)
    if deja_calcule(sortie):
        return {**reponse, "fichier": sortie, "url": url, "recalculees": 0, "secondes": 0}
    fichiers, recalc = rend_pistes(chemin, reference)
    debut = time.time()
    gain = gain_reference(chemin, reference, fichiers, reverb, lufs)
    temps = montage.secondes(mid, bornes)
    plages_s = [(temps[a - 1], temps[b]) for a, b, _ in plages]
    # si le montage finit sur la dernière mesure de l'original, sa fin résonne comme celle de l'original
    queue = QUEUE if plages[-1][1] == len(bornes) - 1 else 0.35
    fin = sum(b - a for a, b in plages_s)
    # pistes retouchées : rendues depuis le montage assemblé (fichier MIDI nommé d'après son contenu)
    modifies = montage.canaux_modifies(mid, plages) & {p["canal"] for p in actives}
    rendues, fenetres = {}, {}            # ligne → piste entière ; ligne → [(w0, z0, z1, w1, fichier)]
    if modifies:
        chemin_m = fichier_montage(mid, req["segments"])
        retouchees = [p for p in actives if p["canal"] in modifies]
        zones = zones_retouchees(plages, plages_s)
        if req.get("_piste_entiere") or len(zones) > 8 or sum(z1 - z0 for z0, z1 in zones) > 0.4 * fin:
            rendues, neuf = rend_pistes(chemin_m, retouchees)
            recalc += neuf
        else:
            travaux = []
            for p in retouchees:
                seule = piste_seule(chemin_m, p["canal"], p["son"], p.get("prog"))
                for z0, z1 in zones:
                    w0, w1 = max(0.0, z0 - AVANT), z1 + APRES
                    travaux.append((ligne(p), w0, z0, z1, w1, extrait(seule, w0, w1), p["son"]))
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=max(1, int(CONFIG.get("rendus_simultanes", 4)))) as pool:
                faits = list(pool.map(lambda x: rend_midi(x[5], x[6]), travaux))
            for (c, w0, z0, z1, w1, _, _), (flac, neuf) in zip(travaux, faits):
                fenetres.setdefault(c, []).append((w0, z0, z1, w1, flac))
                recalc += neuf
    prefixe, sources, liste, autres = [], [], [], []
    for i, p in enumerate(actives):
        c = ligne(p)
        if c in rendues:
            liste.append((p, rendues[c])); sources.append(f"[{i}:a]")
            continue
        liste.append((p, fichiers[c]))
        if c not in fenetres:
            prefixe += montage.chaine_collage(f"[{i}:a]", plages_s, f"[r{i}]", f"m{i}", queue=queue)
            sources.append(f"[r{i}]")
            continue
        # l'original recollé, éteint dans chaque fenêtre ; chaque fenêtre rendue, allumée par un fondu enchaîné
        prefixe += montage.chaine_collage(f"[{i}:a]", plages_s, f"[b{i}]", f"m{i}", queue=queue)
        poids = []                                     # poids de la fenêtre j dans le temps (0 → 1 → 0)
        for j, (w0, z0, z1, w1, flac) in enumerate(fenetres[c]):
            a, b = z0 - 0.2 - FONDU_ENTREE, w1 - MARGE_SORTIE - FONDU_SORTIE
            poids.append(f"(clip((t-{a:.3f})/{FONDU_ENTREE},0,1)-clip((t-{b:.3f})/{FONDU_SORTIE},0,1))")
            entree = len(actives) + len(autres)
            autres.append(flac)
            prefixe.append(f"[{entree}:a]adelay={round(w0 * 1000)}:all=1,volume='{poids[-1]}':eval=frame[f{i}_{j}]")
        prefixe.append(f"[b{i}]volume='1-{'-'.join(poids)}':eval=frame[o{i}]")
        n = len(fenetres[c]) + 1
        prefixe.append(f"[o{i}]" + "".join(f"[f{i}_{j}]" for j in range(n - 1))
                       + f"amix=inputs={n}:normalize=0:duration=first[r{i}]")
        sources.append(f"[r{i}]")
    e, ch = graphe(liste, reverb, sources)
    e += [a for f in autres for a in ("-i", f)]       # les fenêtres : entrées supplémentaires, après les pistes
    ecrit_mixage(req, e, prefixe + ch, gain, fin, sortie, queue)
    return {**reponse, "fichier": sortie, "url": url, "recalculees": recalc, "secondes": round(time.time() - debut, 1),
            "retouchees": len(modifies)}


# ───────────────────────────── scripts générateurs (« Mettre à jour le script ») ─────────────────────────────
def script_du_morceau(fichier, mid=None):
    """Le script qui a fabriqué ce morceau : celui dont le nom est inscrit dans le .mid (« mixeur-script=… »), sinon
    un script du même dossier dont la ligne PRODUIT = "…" est le début du nom du morceau (le plus récent). → chemin ou None."""
    dossier, tige = os.path.dirname(fichier), os.path.splitext(os.path.basename(fichier))[0]
    nom = retouches.script_du_mid(mid or lis_mid(fichier))
    if nom and os.path.isfile(os.path.join(dossier, nom)):
        return os.path.join(dossier, nom)
    trouves = []
    for f in os.listdir(dossier):
        if f.lower().endswith(".py"):
            p = os.path.join(dossier, f)
            try:
                m = re.search(r'^PRODUIT\s*=\s*"([^"]+)"', open(p, encoding="utf-8").read(), re.M)
            except (OSError, UnicodeDecodeError):
                continue
            if m and (tige == m.group(1) or tige.startswith(m.group(1) + "_")):
                trouves.append(p)
    return max(trouves, key=os.path.getmtime) if trouves else None


def lance_script(script, sortie, sans_retouches):
    """Exécute un script générateur (convention : --sortie, --sans-retouches) avec python.exe (pas pythonw)."""
    python = os.path.join(os.path.dirname(sys.executable), "python.exe")
    commande = [python if os.path.exists(python) else sys.executable, "-I", script, "--sortie", sortie]
    res = subprocess.run(commande + (["--sans-retouches"] if sans_retouches else []), cwd=os.path.dirname(script),
                         capture_output=True, timeout=300, creationflags=SANS_FENETRE)
    if res.returncode or not os.path.exists(sortie):
        msg = res.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or ["erreur inconnue"]
        raise ValueError(f"Le script « {os.path.basename(script)} » a échoué : {msg[0]}")
    return mido.MidiFile(sortie)


def met_a_jour_script(req):
    """Écrit, à côté du script d'origine, une nouvelle version du script = même recette + bloc RETOUCHES /
    REGLAGES qui reproduit le document en cours (avec ses retouches) ; jamais d'écrasement. Puis vérifie que ce
    nouveau script redonne exactement le morceau."""
    d = TRAVAUX.charge(req.get("doc"))
    ouvert, actuel = d["copie"] or d["original"], TRAVAUX.chemin(d)
    script = script_du_morceau(ouvert, lis_mid(actuel))
    if not script:
        raise ValueError("Ce morceau n'a pas été fabriqué par un script du mixeur (aucun script trouvé à côté de lui).")
    source = open(script, encoding="utf-8").read()
    bloc = re.compile(r"^# ───── RETOUCHES.*?^# ───── fin des retouches ─────$", re.M | re.S)
    if not bloc.search(source):
        raise ValueError(f"« {os.path.basename(script)} » n'a pas de bloc RETOUCHES (convention du mixeur).")
    tmp = os.path.join(MONTAGES, f"script_{threading.get_ident()}")
    os.makedirs(tmp, exist_ok=True)
    try:
        recette = lance_script(script, os.path.join(tmp, "recette.mid"), sans_retouches=True)
        morceau = mido.MidiFile(actuel)
        liste = retouches.compare(recette, morceau)
        tige = os.path.splitext(os.path.basename(ouvert))[0]
        produit = re.search(r'^PRODUIT\s*=\s*"([^"]+)"', source, re.M)
        suffixe = (tige[len(produit.group(1)):].strip("_ ") if produit and tige.startswith(produit.group(1)) else tige) or "retouches"
        base = re.sub(r"\s+v\d+$", "", os.path.splitext(os.path.basename(script))[0])
        cible, k = os.path.join(os.path.dirname(script), f"{base} {suffixe}.py"), 2
        while os.path.exists(cible):
            cible, k = os.path.join(os.path.dirname(script), f"{base} {suffixe} ({k}).py"), k + 1
        import pprint
        nouveau_bloc = ("# ───── RETOUCHES (écrit par le mixeur — garder ces deux lignes de repère) ─────\n"
                        f"# {len(liste)} retouche(s) faite(s) dans le mixeur sur « {os.path.basename(ouvert)} » le "
                        f"{time.strftime('%d/%m/%Y à %H:%M')} ; REGLAGES : réglages de mixage repris du mixeur.\n"
                        + retouches.en_python(liste, recette) + "\n"
                        + "REGLAGES = " + pprint.pformat(req.get("reglages"), width=110, sort_dicts=False) + "\n"
                        + "# ───── fin des retouches ─────")
        with open(cible, "w", encoding="utf-8", newline="\n") as f:
            f.write(bloc.sub(lambda _: nouveau_bloc, source, count=1))
        verif = retouches.compare(lance_script(cible, os.path.join(tmp, "verif.mid"), sans_retouches=False), morceau)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return {"script": os.path.basename(cible), "retouches": len(liste), "ecarts": len(verif)}


# ───────────────────────────── document de travail ─────────────────────────────
def etat_doc(d, avec_morceau=True):
    """Ce que la page doit savoir du document (et, au besoin, l'analyse de sa version courante)."""
    script = script_du_morceau(d["copie"] or d["original"], lis_mid(TRAVAUX.chemin(d)))
    modifie = TRAVAUX.modifie(d)
    try:                                   # mesures qui diffèrent du fichier enregistré (repérées dans le Montage)
        modifiees = montage.mesures_modifiees(lis_mid(TRAVAUX.chemin(d, d["enregistree"])), lis_mid(TRAVAUX.chemin(d))) if modifie else []
    except Exception:
        modifiees = []
    r = {"doc": {"id": d["id"], "original": d["original"], "copie": d["copie"], "versions": d["versions"],
                 "courante": d["courante"], "enregistree": d["enregistree"], "modifie": modifie,
                 "modifiees": modifiees, "script": os.path.basename(script) if script else None}}
    if avec_morceau:
        r["morceau"] = analyse(TRAVAUX.chemin(d), reglages_de=d["copie"] or d["original"])
    return r


def route_doc(url, req):
    """/api/doc/… : ouvrir, reprendre, appliquer un montage ou un texte, changer de version, enregistrer."""
    if url == "/api/doc/ouvrir":
        verifie_chemin(req["fichier"], travail_compris=False)
        return etat_doc(TRAVAUX.ouvre(req["fichier"]))
    d = TRAVAUX.charge(req.get("doc"))
    if url == "/api/doc/reprendre":
        return etat_doc(d)
    if url == "/api/doc/montage":
        mid = montage.assemble(lis_mid(TRAVAUX.chemin(d)), req["segments"])
        return etat_doc(TRAVAUX.nouvelle_version(d, mid))
    if url == "/api/doc/texte":
        mid, err = erreurs_texte(req["texte"])
        return {"erreurs": err} if err else etat_doc(TRAVAUX.nouvelle_version(d, mid))
    if url == "/api/doc/version":
        return etat_doc(TRAVAUX.va(d, int(req["version"])))
    if url == "/api/doc/enregistrer":
        def ecrit_reglages(cible):
            if req.get("reglages"):
                with open(os.path.splitext(cible)[0] + ".mix.json", "w", encoding="utf-8") as f:
                    json.dump(req["reglages"], f, ensure_ascii=False, indent=2)
        fichier, genre = TRAVAUX.enregistre(d, bool(req.get("nouvelle")), ecrit_reglages)
        return {**etat_doc(d, avec_morceau=False), "fichier": fichier, "genre": genre}
    raise ValueError("Demande inconnue.")


# ───────────────────────────── onglet Événements ─────────────────────────────
def erreurs_texte(texte):
    mid, err = midi_texte.analyse_texte(texte)
    return mid, [{"ligne": n, "message": msg, "contenu": c} for n, msg, c in err]


# ───────────────────────────── serveur ─────────────────────────────
class Console(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def refus(self, post):
        """Protection de l'API : seule la console du mixeur, ouverte sur ce PC, peut s'en servir.
        - Host local (localhost, 127.0.0.1, [::1] sur le port du mixeur) : bloque le « DNS rebinding » ;
        - POST : Origin, s'il est présent, égal à celui du mixeur (« null » refusé), et corps en application/json,
          ce qui oblige le navigateur à demander une autorisation (preflight) qu'aucun autre site n'obtient.
        Aucun en-tête CORS n'est jamais envoyé. → message d'erreur, ou None si la requête est acceptée."""
        port = self.server.server_address[1]
        hote = (self.headers.get("Host") or "").strip().lower()
        if hote not in {f"{h}:{port}" for h in ("localhost", "127.0.0.1", "[::1]")}:
            return "hôte non autorisé"
        if post:
            origine = self.headers.get("Origin")
            if origine is not None and origine.lower() != f"http://{hote}":
                return "origine non autorisée"
            if (self.headers.get("Content-Type") or "").split(";")[0].strip().lower() != "application/json":
                return "requête non autorisée (JSON attendu)"
        return None

    def envoie(self, code, corps, type_="application/json; charset=utf-8", entetes=None):
        data = corps if isinstance(corps, bytes) else json.dumps(corps, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", type_)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (entetes or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def fichier(self, chemin, type_):
        taille = os.path.getsize(chemin)
        plage = self.headers.get("Range")
        with open(chemin, "rb") as f:
            if plage and plage.startswith("bytes="):
                a, _, b = plage[6:].partition("-")
                a = int(a or 0)
                b = int(b) if b else taille - 1
                f.seek(a)
                data = f.read(b - a + 1)
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {a}-{b}/{taille}")
            else:
                data = f.read()
                self.send_response(200)
        self.send_header("Content-Type", type_)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if (erreur := self.refus(post=False)):
            return self.envoie(403, {"erreur": erreur})
        url = urllib.parse.urlparse(self.path).path
        if url in ("/", "/index.html"):
            return self.fichier(os.path.join(PAGE, "index.html"), "text/html; charset=utf-8")
        # feuilles de style et scripts de la page : page\css\*.css et page\js\*.js seulement
        m = re.fullmatch(r"/(css/[\w-]+\.css|js/[\w-]+\.js)", url)
        if m and os.path.isfile(os.path.join(PAGE, *m.group(1).split("/"))):
            type_ = "text/css" if url.endswith(".css") else "text/javascript"
            return self.fichier(os.path.join(PAGE, *m.group(1).split("/")), type_ + "; charset=utf-8")
        m = re.fullmatch(r"/icones/([\w-]+\.svg)", url)     # icônes de la page (page\icones\*.svg)
        if m and os.path.isfile(os.path.join(PAGE, "icones", m.group(1))):
            return self.fichier(os.path.join(PAGE, "icones", m.group(1)), "image/svg+xml")
        if url in ("/favicon.ico", "/icone.png"):          # icône de l'application (onglet du navigateur)
            return self.fichier(os.path.join(PAGE, url[1:]), "image/x-icon" if url.endswith(".ico") else "image/png")
        if url == "/api/version":
            return self.envoie(200, {"version": VERSION, "fichier": lit_version()})
        if url == "/api/fichiers":
            return self.envoie(200, liste_fichiers())
        if url == "/api/sons":
            return self.envoie(200, SONS)
        if url == "/api/cache":
            return self.envoie(200, {"mo": round(taille_cache() / 1024 / 1024)})
        m = re.fullmatch(r"/cache/ecoute/([0-9a-f]{16}\.(mp3|flac))", url)
        if m and os.path.exists(os.path.join(ECOUTE, m.group(1))):
            return self.fichier(os.path.join(ECOUTE, m.group(1)), "audio/flac" if m.group(2) == "flac" else "audio/mpeg")
        self.envoie(404, {"erreur": "introuvable"})

    def do_POST(self):
        if (erreur := self.refus(post=True)):
            return self.envoie(403, {"erreur": erreur})
        url = urllib.parse.urlparse(self.path).path
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            if url == "/api/rendu":
                with VERROU:
                    return self.envoie(200, mixe(req))
            if url == "/api/montage/ecoute":
                with VERROU:
                    return self.envoie(200, ecoute_montage(req))
            if url == "/api/montage/preparer":             # en arrière-plan, sans le VERROU (voir prepare_montage)
                return self.envoie(200, prepare_montage(req))
            if url.startswith("/api/doc/"):
                with VERROU:
                    return self.envoie(200, route_doc(url, req))
            if url == "/api/niveaux":
                with VERROU:
                    return self.envoie(200, niveaux(req))
            if url == "/api/texte/lire":
                verifie_chemin(req["fichier"])
                return self.envoie(200, {"texte": midi_texte.texte_de(mido.MidiFile(req["fichier"]), os.path.basename(req["fichier"]))})
            if url == "/api/script/mettre-a-jour":
                with VERROU:
                    return self.envoie(200, met_a_jour_script(req))
            if url == "/api/texte/verifier":
                return self.envoie(200, {"erreurs": erreurs_texte(req["texte"])[1]})
            if url == "/api/vider_cache":
                with VERROU:
                    for d in (PISTES, ECOUTE, MONTAGES):
                        shutil.rmtree(d)
                        os.makedirs(d)
                return self.envoie(200, {"mo": 0})
            if url == "/api/presence":
                PRESENCE.signe(str(req.get("page", "")), bool(req.get("fin")))
                return self.envoie(200, {"ok": True})
            self.envoie(404, {"erreur": "introuvable"})
        except subprocess.CalledProcessError as e:
            msg = (e.stderr or b"").decode("utf-8", "replace").strip().splitlines()[-1:] or ["erreur du moteur"]
            self.envoie(500, {"erreur": f"Le moteur de rendu a échoué : {msg[0]}"})
        except subprocess.TimeoutExpired:
            self.envoie(500, {"erreur": "Le rendu a pris trop de temps et a été arrêté."})
        except Exception as e:  # noqa: BLE001 — message lisible pour la console
            self.envoie(400, {"erreur": str(e)})


class Presence:
    """Arrêt automatique : chaque onglet ouvert sur la console fait signe toutes les 20 s (/api/presence) et dit
    « fin » en se fermant. Sans aucun onglet pendant DELAI secondes (le temps qu'un F5 recharge la page), le
    serveur s'arrête, après le calcul ou l'export en cours. Un onglet muet depuis OUBLI secondes (navigateur
    fermé brutalement) ne compte plus ; c'est large car un onglet en arrière-plan ne fait signe qu'une fois par minute."""
    DELAI, OUBLI, PREMIER = 10, 180, 120

    def __init__(self):
        self.pages, self.verrou, self.depuis = {}, threading.Lock(), time.monotonic()

    def signe(self, page, fin):
        with self.verrou:
            if fin:
                self.pages.pop(page, None)
            elif page:
                self.pages[page] = time.monotonic()
            if not self.pages:
                self.depuis = time.monotonic()

    def surveille(self):
        attente = self.PREMIER                     # au lancement, le navigateur peut mettre un moment à s'ouvrir
        while True:
            time.sleep(2)
            with self.verrou:
                now = time.monotonic()
                for p, t in list(self.pages.items()):
                    if now - t > self.OUBLI:
                        del self.pages[p]
                        if not self.pages:
                            self.depuis = now
                if self.pages:
                    attente = self.DELAI
                    continue
                if now - self.depuis < attente:
                    continue
            with VERROU:                           # attend la fin d'un rendu ou d'un export
                threading.Thread(target=SERVEUR.shutdown, daemon=True).start()
            return


PRESENCE = Presence()


def main():
    global SONS, SERVEUR
    port = CONFIG["port"]
    url = f"http://localhost:{port}/"
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", port)) == 0:        # déjà lancé : on ouvre simplement la console
            webbrowser.open(url)
            return
    SONS = catalogue()
    TRAVAUX.menage()
    SERVEUR = http.server.ThreadingHTTPServer(("127.0.0.1", port), Console)
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()   # la console ouverte fait vivre le serveur (Presence)
    threading.Thread(target=PRESENCE.surveille, daemon=True).start()
    SERVEUR.serve_forever()


if __name__ == "__main__":
    main()
