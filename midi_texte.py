"""MIDI ⇄ texte : lire et modifier un fichier .mid dans VS Code, puis refaire un .mid.

    python midi_texte.py morceau.mid        →  morceau.mid.txt     (texte commenté, modifiable)
    python midi_texte.py morceau.mid.txt    →  morceau_texte.mid   (puis _texte_2, _texte_3… : jamais d'écrasement)

Le texte garde tout le fichier (pistes, canaux, notes, instruments, contrôleurs, tempo, chiffrage, tonalité,
textes…) : sans modification, le .mid refait joue exactement comme l'original. Le mode d'emploi du format est
écrit en tête de chaque fichier texte (voir ENTETE ci-dessous).
"""
import json
import os
import re
import sys

import mido

NOMS = ["Do", "Do♯", "Ré", "Ré♯", "Mi", "Fa", "Fa♯", "Sol", "Sol♯", "La", "La♯", "Si"]
GM_FR = """Piano acoustique|Piano brillant|Piano électrique (grand)|Piano honky-tonk|Piano électrique 1|Piano électrique 2|Clavecin|Clavinet|Célesta|Glockenspiel|Boîte à musique|Vibraphone|Marimba|Xylophone|Cloches tubulaires|Dulcimer|Orgue Hammond|Orgue percussif|Orgue rock|Orgue d'église|Harmonium|Accordéon|Harmonica|Bandonéon|Guitare nylon|Guitare folk (acier)|Guitare jazz|Guitare électrique claire|Guitare étouffée|Guitare saturée|Guitare distorsion|Harmoniques de guitare|Contrebasse|Basse (doigts)|Basse (médiator)|Basse fretless|Slap basse 1|Slap basse 2|Basse synthé 1|Basse synthé 2|Violon|Alto|Violoncelle|Contrebasse (archet)|Cordes trémolo|Cordes pizzicato|Harpe|Timbales|Ensemble de cordes 1|Ensemble de cordes 2|Cordes synthé 1|Cordes synthé 2|Chœur « aah »|Voix « ooh »|Voix synthé|Coup d'orchestre|Trompette|Trombone|Tuba|Trompette bouchée|Cor|Section de cuivres|Cuivres synthé 1|Cuivres synthé 2|Saxophone soprano|Saxophone alto|Saxophone ténor|Saxophone baryton|Hautbois|Cor anglais|Basson|Clarinette|Piccolo|Flûte|Flûte à bec|Flûte de Pan|Bouteille soufflée|Shakuhachi|Sifflet|Ocarina|Lead carré|Lead dent de scie|Lead calliope|Lead chiff|Lead charang|Lead voix|Lead quintes|Lead basse + lead|Nappe new age|Nappe chaude|Nappe polysynth|Nappe chœur|Nappe archet|Nappe métallique|Nappe halo|Nappe balayage|Effet pluie|Effet bande-son|Effet cristal|Effet atmosphère|Effet brillance|Effet gobelins|Effet échos|Effet science-fiction|Sitar|Banjo|Shamisen|Koto|Kalimba|Cornemuse|Violon folk|Shanai|Clochette|Agogo|Steel drum|Wood-block|Taiko|Tom mélodique|Tambour synthé|Cymbale inversée|Bruit de frette|Souffle|Vagues|Oiseaux|Téléphone|Hélicoptère|Applaudissements|Coup de feu""".split("|")
CC_NOMS = {0: "banque", 1: "modulation", 7: "volume", 10: "panoramique (64 = centre)", 11: "expression",
           32: "banque (fin)", 64: "pédale (≥ 64 = enfoncée)", 91: "réverbération", 93: "chorus"}
TEXTES = {"track_name": "nom", "text": "texte", "marker": "marqueur", "lyrics": "paroles",
          "instrument_name": "nom-instrument", "copyright": "copyright", "cue_marker": "repère"}
CHAMP_TEXTE = {"track_name": "name", "instrument_name": "name"}   # pour mido, ces deux-là s'appellent « name », pas « text »

ENTETE = """\
# ══════════════════════════════════════════════════════════════════════════════════════════
#  {nom} — version texte, modifiable dans VS Code
# ══════════════════════════════════════════════════════════════════════════════════════════
#  Refaire un .mid après modification (dans le terminal de VS Code) :
#      python "{script}" "{texte}"
#  → crée « {sortie} » à côté (puis _2, _3… : rien n'est jamais écrasé).
#  En cas d'erreur, le numéro de la ligne fautive est indiqué et aucun fichier n'est écrit.
#
#  UNE LIGNE = UN ÉVÉNEMENT :   POSITION   ÉVÉNEMENT   valeurs        # commentaire libre
#    POSITION  mesure.temps.tick   ex. 25.1.000 = mesure 25, 1er temps ; 24.4.474 = 6 ticks avant la mesure 25
#              ({ticks} ticks par noire ; le temps est l'unité du chiffrage : la noire en 4/4 ou 3/4)
#
#    note Fa♯4  dur 1.240  v60    note Fa♯4, durée 1 temps + 240 ticks, vélocité 60 (1 = très doux … 127 = très fort)
#                                 noms : Do Do♯ Ré Ré♯ Mi Fa Fa♯ Sol Sol♯ La La♯ Si + octave ; Do3 = do du milieu
#                                 (MIDI 60) ; on peut écrire # ou ♯, b ou ♭ (Si♭2), ou le numéro MIDI (note 66)
#    instrument 0                 changement d'instrument (numéro General MIDI 0 à 127, nom en commentaire)
#    cc 64 = 127                  contrôleur : 7 volume, 10 panoramique, 11 expression, 64 pédale, 91 réverbération
#    pitch 0                      bend (-8192 à 8191)        pression 40 / pression-note La3 40 : aftertouch
#    tempo 72.85                  battements (noires) par minute      chiffrage 4/4      tonalité Bm
#    nom "…"  texte "…"  marqueur "…"  paroles "…"                     fin : fin de la piste
#    brut …   meta-brut …         autres événements, recopiés tels quels (à laisser)
#
#  « canal 8 » sous l'en-tête d'une piste donne le canal de ses événements (1 à 16, comme dans le mixeur) ;
#  ajouter « canal N » au bout d'une ligne pour un autre canal.
#  L'ordre des lignes est libre (tout est trié par position). Supprimer = effacer la ligne (ou mettre # devant),
#  ajouter = écrire une nouvelle ligne. Les lignes « # ── mesure … ── » ne sont que des repères.
# ══════════════════════════════════════════════════════════════════════════════════════════
"""


# ───────────────────────────── mesures ⇄ ticks ─────────────────────────────
class Mesures:
    """Conversion tick ⇄ mesure.temps.tick d'après les changements de chiffrage [(tick, num, den)]."""

    def __init__(self, tpb, chiffrages=()):
        self.tpb, self.seg = tpb, [(0, 1, 4, 4)]          # (tick, n° de mesure, num, den)
        for t, n, d in sorted(chiffrages):
            self.ajoute(t, n, d)

    def longueur(self, num, den):
        return self.tpb * 4 * num // den

    def ajoute(self, tick, num, den):
        t0, m0, n0, d0 = self.seg[-1]
        if tick <= t0:
            self.seg[-1] = (t0, m0, num, den)
            return
        L = self.longueur(n0, d0)
        self.seg.append((tick, m0 + -(-(tick - t0) // L), num, den))

    def position(self, tick):
        t0, m0, n, d = [s for s in self.seg if s[0] <= tick][-1] if tick >= 0 else self.seg[0]
        L, temps = self.longueur(n, d), self.tpb * 4 // d
        q, r = divmod(tick - t0, L)
        return m0 + q, r // temps + 1, r % temps

    def tick(self, m, t, k):
        t0, m0, n, d = [s for s in self.seg if s[1] <= m][-1] if m >= self.seg[0][1] else self.seg[0]
        return t0 + (m - m0) * self.longueur(n, d) + (t - 1) * (self.tpb * 4 // d) + k

    def temps(self, tick):
        """Durée d'un temps (ticks) à cette position."""
        return self.tpb * 4 // [s for s in self.seg if s[0] <= max(0, tick)][-1][3]

    def texte(self, tick):
        m, t, k = self.position(tick)
        return f"{m:>4}.{t}.{k:03d}"


# ───────────────────────────── notes ─────────────────────────────
def nom_note(n, canal):
    return str(n) if canal == 9 else f"{NOMS[n % 12]}{n // 12 - 2}"


ALTER = {"♯": 1, "#": 1, "♭": -1, "b": -1}
BASES = {"do": 0, "ré": 2, "re": 2, "mi": 4, "fa": 5, "sol": 7, "la": 9, "si": 11}


def lit_note(s):
    if re.fullmatch(r"\d{1,3}", s):
        n = int(s)
    else:
        m = re.fullmatch(r"(?i)(do|ré|re|mi|fa|sol|la|si)([♯#♭b]*)(-?\d+)", s)
        if not m:
            raise ValueError(f"note inconnue « {s} » (ex. Do3, Fa♯4, Si♭2 ou un numéro MIDI)")
        n = BASES[m.group(1).lower()] + sum(ALTER[c] for c in m.group(2)) + (int(m.group(3)) + 2) * 12
    if not 0 <= n <= 127:
        raise ValueError(f"note hors limites « {s} » (MIDI {n})")
    return n


def bpm_texte(tempo):
    bpm = 60e6 / tempo
    for dec in range(2, 8):
        if round(60e6 / round(bpm, dec)) == tempo:
            return f"{round(bpm, dec):.{dec}f}".rstrip("0").rstrip(".")
    return repr(bpm)


# ───────────────────────────── .mid → texte ─────────────────────────────
def vers_texte(chemin_mid):
    """Écrit le texte à côté du .mid (jamais d'écrasement) ; → chemin du texte."""
    texte, k = chemin_mid + ".txt", 2                    # un texte déjà là (peut-être modifié) n'est jamais écrasé
    while os.path.exists(texte):
        texte, k = f"{os.path.splitext(chemin_mid)[0]}_{k}.mid.txt", k + 1
    with open(texte, "w", encoding="utf-8", newline="\n") as f:
        f.write(texte_de(mido.MidiFile(chemin_mid), os.path.basename(chemin_mid), os.path.basename(texte)))
    return texte


def texte_de(mid, base, nom_texte=None):
    """Le texte commenté d'un fichier MIDI (base = nom du .mid, pour l'en-tête)."""
    tpb = mid.ticks_per_beat
    tous = []
    for i, tr in enumerate(mid.tracks):
        t = 0
        for m in tr:
            t += m.time
            tous.append((t, i, m))
    chif = [(t, m.numerator, m.denominator) for t, _, m in tous if m.type == "time_signature"]
    mes = Mesures(tpb, chif)
    tempos = sorted((t, m.tempo) for t, _, m in tous if m.type == "set_tempo")
    sortie = os.path.splitext(base)[0] + "_texte.mid"
    lignes = [ENTETE.format(nom=base, script=os.path.abspath(__file__), texte=nom_texte or base + ".txt",
                            sortie=sortie, ticks=tpb).rstrip("\n"), "",
              f"fichier  format {mid.type}  ticks {tpb}", ""]

    def repere(tick):
        m = mes.position(tick)[0]
        t0 = mes.tick(m, 1, 0)
        tp = [x for x in tempos if x[0] <= t0]
        n, d = [(s[2], s[3]) for s in mes.seg if s[0] <= t0][-1]
        bpm = f"{60e6 / tp[-1][1]:.2f}".rstrip("0").rstrip(".").replace(".", ",") if tp else "120"
        return f"  # ── mesure {m} · {bpm} bpm · {n}/{d} ──"

    for i, tr in enumerate(mid.tracks):
        evs, t = [], 0
        for m in tr:
            t += m.time
            evs.append((t, m))
        canaux = [m.channel for _, m in evs if hasattr(m, "channel")]
        defaut = max(set(canaux), key=canaux.count) if canaux else None
        nom = next((m.name for _, m in evs if m.type == "track_name"), "")
        progs = list(dict.fromkeys(m.program for _, m in evs if m.type == "program_change"))
        nb = sum(1 for _, m in evs if m.type == "note_on" and m.velocity)
        resume = " / ".join(GM_FR[p] for p in progs) if progs else ("percussions" if defaut == 9 else "")
        lignes += ["", f"# {'═' * 100}",
                   f"piste {i + 1}" + (f"  « {nom} »" if nom else "")
                   + f"      # {nb} notes" + (f" · {resume}" if resume else "") + ("" if canaux else " · tempo, chiffrage, textes"),
                   f"# {'═' * 100}"]
        if defaut is not None:
            lignes.append(f"  canal {defaut + 1}")
        # notes : début + fin réunis
        ouvertes, notes, fins = {}, {}, set()
        for k, (t, m) in enumerate(evs):
            if m.type == "note_on" and m.velocity > 0:
                ouvertes.setdefault((m.channel, m.note), []).append(k)
            elif m.type in ("note_on", "note_off"):
                pile = ouvertes.get((m.channel, m.note))
                if pile:
                    d = pile.pop(0)
                    notes[d] = k
                    fins.add(k)
        derniere = None
        for k, (t, m) in enumerate(evs):
            if k in fins:
                continue
            if m.type == "end_of_track":
                lignes.append(f"{mes.texte(t)}  fin")
                continue
            m_num = mes.position(t)[0]
            if m_num != derniere:
                lignes.append(repere(t))
                derniere = m_num
            canal = f"  canal {m.channel + 1}" if hasattr(m, "channel") and m.channel != defaut else ""
            if m.type == "note_on" and k in notes:
                t2, off = evs[notes[k]]
                temps = mes.temps(t)
                dur = t2 - t
                extra = f"  voff{off.velocity}" if off.velocity else ""
                if off.type == "note_on":
                    extra += "  fin=note_on"
                desc = f"note {nom_note(m.note, m.channel):<6} dur {dur // temps}.{dur % temps:03d}  v{m.velocity}{extra}"
                com = f"MIDI {m.note}" if m.channel != 9 else "percussion"
            elif m.type == "program_change":
                desc, com = f"instrument {m.program}", GM_FR[m.program] if m.channel != 9 else "kit de batterie"
            elif m.type == "control_change":
                desc, com = f"cc {m.control} = {m.value}", CC_NOMS.get(m.control, "")
            elif m.type == "pitchwheel":
                desc, com = f"pitch {m.pitch}", ""
            elif m.type == "aftertouch":
                desc, com = f"pression {m.value}", ""
            elif m.type == "polytouch":
                desc, com = f"pression-note {nom_note(m.note, m.channel)} {m.value}", ""
            elif m.type == "set_tempo":
                desc, com = f"tempo {bpm_texte(m.tempo)}", ""
            elif m.type == "time_signature":
                desc = f"chiffrage {m.numerator}/{m.denominator}"
                if (m.clocks_per_click, m.notated_32nd_notes_per_beat) != (24, 8):
                    desc += f"  clics {m.clocks_per_click}  triples {m.notated_32nd_notes_per_beat}"
                com = ""
            elif m.type == "key_signature":
                desc, com = f"tonalité {m.key}", ""
            elif m.type in TEXTES:
                desc, com = f"{TEXTES[m.type]} {json.dumps(getattr(m, CHAMP_TEXTE.get(m.type, 'text')), ensure_ascii=False)}", ""
            elif m.is_meta:
                d = {a: v for a, v in vars(m).items() if a not in ("type", "time")}
                desc, com, canal = f"meta-brut {m.type} {json.dumps(d, ensure_ascii=False)}", "", ""
            else:
                desc, com, canal = f"brut {str(m.copy(time=0))}", "", ""
            # un changement de chiffrage se repère dans les mesures d'avant lui (il peut tomber en cours de mesure)
            ou = Mesures(tpb, [c for c in chif if c[0] < t]).texte(t) if m.type == "time_signature" else mes.texte(t)
            ligne = f"{ou}  {desc}{canal}"
            lignes.append(ligne + (f"{' ' * max(2, 50 - len(ligne))}# {com}" if com else ""))
    return "\n".join(lignes) + "\n"


# ───────────────────────────── texte → .mid ─────────────────────────────
def coupe_commentaire(ligne):
    """Retire le commentaire : « # » en début de ligne ou précédé d'un espace (Fa#4 reste une note)."""
    dans, res = False, []
    for i, c in enumerate(ligne):
        if c == '"':
            dans = not dans
        if c == "#" and not dans and (i == 0 or ligne[i - 1] in " \t"):
            break
        res.append(c)
    return "".join(res).strip()


def vers_mid(chemin_txt):
    """Refait un .mid à côté du texte (jamais d'écrasement) ; s'arrête en listant les erreurs."""
    mid, erreurs = analyse_texte(open(chemin_txt, encoding="utf-8-sig").read())
    if erreurs:
        print("Aucun fichier écrit — à corriger :",
              *[f"ligne {n} : {msg}\n      {contenu}" for n, msg, contenu in erreurs[:20]], sep="\n  ")
        if len(erreurs) > 20:
            print(f"  … et {len(erreurs) - 20} autres erreurs")
        sys.exit(1)
    base = chemin_txt[:-8] if chemin_txt.lower().endswith(".mid.txt") else os.path.splitext(chemin_txt)[0]
    cible, k = base + "_texte.mid", 2
    while os.path.exists(cible):
        cible, k = f"{base}_texte_{k}.mid", k + 1
    mid.save(cible)
    return cible


def analyse_texte(texte):
    """Texte → (MidiFile, []) ou (None, [(n° de ligne, message, contenu de la ligne), …])."""
    brut = texte.lstrip("﻿").splitlines()
    lignes = [(n + 1, coupe_commentaire(l)) for n, l in enumerate(brut)]
    lignes = [(n, l) for n, l in lignes if l]
    erreurs = []
    fmt, tpb = 1, 480
    for n, l in lignes:
        if l.startswith("fichier"):
            m = re.fullmatch(r"fichier\s+format\s+(\d)\s+ticks\s+(\d+)", l)
            if not m:
                return None, [(n, "en-tête attendu « fichier  format 1  ticks 480 »", brut[n - 1].strip())]
            fmt, tpb = int(m.group(1)), int(m.group(2))
    pos_re = re.compile(r"(\d+)\.(\d+)\.(\d+)\s+(.*)")
    # 1. chiffrages d'abord (ils définissent les mesures), dans l'ordre des positions
    mes = Mesures(tpb)
    chif = []
    for n, l in lignes:
        m = pos_re.fullmatch(l)
        if m and m.group(4).startswith("chiffrage"):
            c = re.match(r"chiffrage\s+(\d+)/(\d+)", m.group(4))
            if c:
                chif.append(((int(m.group(1)), int(m.group(2)), int(m.group(3))), int(c.group(1)), int(c.group(2))))
    for (mm, t, k), num, den in sorted(chif):
        mes.ajoute(mes.tick(mm, t, k), num, den)
    # 2. pistes et événements
    pistes, courante, canal = [], None, 0
    for n, l in lignes:
        try:
            if l.startswith("fichier"):
                continue
            if re.match(r"piste\b", l):
                courante = []
                pistes.append(courante)
                canal = 0
                continue
            if re.fullmatch(r"canal\s+\d+", l):
                canal = int(l.split()[1]) - 1
                continue
            m = pos_re.fullmatch(l)
            if not m:
                raise ValueError("ligne incomprise (une ligne d'événement commence par mesure.temps.tick)")
            if courante is None:
                raise ValueError("événement avant la première ligne « piste »")
            tick = mes.tick(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            if tick < 0:
                raise ValueError("position avant le début du morceau")
            reste = m.group(4)
            ch = canal
            c = re.search(r"\s+canal\s+(\d+)$", reste)
            if c and not reste.startswith(("brut", "meta-brut")):
                ch, reste = int(c.group(1)) - 1, reste[:c.start()]
            if not 0 <= ch <= 15:
                raise ValueError("canal hors limites (1 à 16)")
            mots = reste.split()
            genre = mots[0]
            if genre == "note":
                e = re.fullmatch(r"note\s+(\S+)\s+dur\s+(\d+)\.(\d+)\s+v(\d+)((?:\s+voff\d+)?)((?:\s+fin=note_on)?)", reste)
                if not e:
                    raise ValueError("note attendue sous la forme « note Fa♯4  dur 1.240  v60 »")
                note, vel = lit_note(e.group(1)), int(e.group(4))
                if not 1 <= vel <= 127:
                    raise ValueError("vélocité hors limites (1 à 127)")
                dur = int(e.group(2)) * mes.temps(tick) + int(e.group(3))
                if dur <= 0:
                    raise ValueError("durée nulle")
                voff = int(e.group(5).split("voff")[1]) if e.group(5) else 0
                off = (mido.Message("note_on", channel=ch, note=note, velocity=0) if e.group(6)
                       else mido.Message("note_off", channel=ch, note=note, velocity=voff))
                courante.append((tick, 2, n, mido.Message("note_on", channel=ch, note=note, velocity=vel)))
                courante.append((tick + dur, 0, n, off))
            elif genre == "instrument":
                courante.append((tick, 1, n, mido.Message("program_change", channel=ch, program=int(mots[1]))))
            elif genre == "cc":
                e = re.fullmatch(r"cc\s+(\d+)\s*=?\s*(\d+)", reste)
                if not e:
                    raise ValueError("contrôleur attendu sous la forme « cc 64 = 127 »")
                courante.append((tick, 1, n, mido.Message("control_change", channel=ch, control=int(e.group(1)), value=int(e.group(2)))))
            elif genre == "pitch":
                courante.append((tick, 1, n, mido.Message("pitchwheel", channel=ch, pitch=int(mots[1]))))
            elif genre == "pression":
                courante.append((tick, 1, n, mido.Message("aftertouch", channel=ch, value=int(mots[1]))))
            elif genre == "pression-note":
                courante.append((tick, 1, n, mido.Message("polytouch", channel=ch, note=lit_note(mots[1]), value=int(mots[2]))))
            elif genre == "tempo":
                courante.append((tick, 1, n, mido.MetaMessage("set_tempo", tempo=round(60e6 / float(mots[1].replace(",", "."))))))
            elif genre == "chiffrage":
                e = re.fullmatch(r"chiffrage\s+(\d+)/(\d+)(?:\s+clics\s+(\d+)\s+triples\s+(\d+))?", reste)
                if not e:
                    raise ValueError("chiffrage attendu sous la forme « chiffrage 3/4 »")
                courante.append((tick, 1, n, mido.MetaMessage("time_signature", numerator=int(e.group(1)), denominator=int(e.group(2)),
                                                             clocks_per_click=int(e.group(3) or 24),
                                                             notated_32nd_notes_per_beat=int(e.group(4) or 8))))
            elif genre == "tonalité":
                courante.append((tick, 1, n, mido.MetaMessage("key_signature", key=mots[1])))
            elif genre in TEXTES.values():
                typ = next(k for k, v in TEXTES.items() if v == genre)
                courante.append((tick, 1, n, mido.MetaMessage(typ, **{CHAMP_TEXTE.get(typ, "text"): json.loads(reste[len(genre):].strip())})))
            elif genre == "fin":
                courante.append((tick, 9, n, None))
            elif genre == "brut":
                courante.append((tick, 1, n, mido.Message.from_str(reste[4:].strip())))
            elif genre == "meta-brut":
                _, typ, js = reste.split(None, 2)
                courante.append((tick, 1, n, mido.MetaMessage(typ, **json.loads(js))))
            else:
                raise ValueError(f"événement inconnu « {genre} »")
        except (ValueError, KeyError, IndexError, TypeError) as e:
            erreurs.append((n, str(e), brut[n - 1].strip()))
    if not pistes and not erreurs:
        erreurs.append((1, "aucune ligne « piste » : le texte est vide ?", ""))
    if erreurs:
        return None, erreurs
    sortie = mido.MidiFile(type=fmt, ticks_per_beat=tpb)
    for evs in pistes:
        fins = [t for t, o, _, m in evs if m is None]
        evs = sorted((e for e in evs if e[3] is not None), key=lambda e: (e[0], e[1], e[2]))
        tr, prec = mido.MidiTrack(), 0
        for t, _, _, m in evs:
            tr.append(m.copy(time=t - prec))
            prec = t
        fin = max(fins + [prec])
        tr.append(mido.MetaMessage("end_of_track", time=fin - prec))
        sortie.tracks.append(tr)
    return sortie, []


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    chemin = sys.argv[1]
    if chemin.lower().endswith((".mid", ".midi")):
        print("Texte écrit :", vers_texte(chemin))
    elif chemin.lower().endswith(".txt"):
        print("MIDI écrit :", vers_mid(chemin))
    else:
        raise SystemExit("Donnez un fichier .mid (→ texte) ou .txt (→ .mid).")
