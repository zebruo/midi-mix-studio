"""Mixeur MIDI — retouches d'un morceau fabriqué par un script (une « recette »).

Un script générateur (ex. « AF017 ps25 arrangement.py ») fabrique un .mid à partir de règles. Si le .mid est ensuite
retouché dans le mixeur, ces retouches peuvent être reportées dans une nouvelle version du script :
- compare(base, retouche) : liste des différences entre ce que produit la recette seule et le morceau retouché ;
- applique(mid, retouches) : les réapplique sur ce que produit la recette (le script le fait après ses règles) ;
- en_python(retouches, base) : les écrit en Python lisible, une ligne par retouche, avec sa position en mesures.

Une retouche est un dict :
- notes : {"op": "ajoute" | "supprime" | "change", "piste", "canal", "note", "debut", "fin", "velocite"}
  (debut / fin en ticks ; une note est reconnue à sa piste, son canal, sa hauteur et son début) ;
- autres événements (contrôleurs, instruments, tempo, chiffrage…) : {"op": "evenement+" | "evenement-", "piste",
  "tick", "message": {…}} (le message au format de mido : msg.dict() sans « time »).
"""
from collections import Counter

import mido

import midi_texte

ORDRE = lambda m: 0 if (m.type == "note_off" or (m.type == "note_on" and not m.velocity)) else 2 if m.type == "note_on" else 1


def _evenements(piste):
    t, res = 0, []
    for m in piste:
        t += m.time
        res.append([t, m])
    return res


def _notes(evts):
    """Notes appariées [(début, fin, [t, on], [t, off])] (références modifiables) et autres événements."""
    ouvertes, notes, autres = {}, [], []
    for e in evts:
        m = e[1]
        if m.type == "note_on" and m.velocity:
            ouvertes.setdefault((m.channel, m.note), []).append(e)
        elif m.type in ("note_on", "note_off") and ouvertes.get((m.channel, m.note)):
            on = ouvertes[(m.channel, m.note)].pop(0)
            notes.append((on[0], e[0], on, e))
        elif m.type not in ("note_on", "note_off", "end_of_track") and not est_signature(m):
            autres.append(e)
    return notes, autres


def est_signature(m):
    """La ligne « mixeur-script=… » que le script inscrit dans son .mid (pas une retouche)."""
    return m.type == "text" and m.text.startswith("mixeur-script=")


def script_du_mid(mid):
    """Nom du script qui a fabriqué ce .mid (ligne « mixeur-script=… »), ou None."""
    for p in mid.tracks:
        for m in p:
            if est_signature(m):
                return m.text.split("=", 1)[1]
    return None


def _cle(m):
    return repr(m.copy(time=0))


def _message(d):
    d = dict(d)
    genre = d.pop("type")
    return mido.Message(genre, **d) if genre in mido.messages.specs.SPEC_BY_TYPE else mido.MetaMessage(genre, **d)


def _dict(m):
    d = m.dict()
    d.pop("time", None)
    return d


def compare(base, retouche):
    """Différences entre `base` (la recette seule) et `retouche` (le morceau retouché) → liste de retouches."""
    if base.ticks_per_beat != retouche.ticks_per_beat or len(base.tracks) != len(retouche.tracks):
        raise ValueError("Le morceau n'a plus la même structure que ce que produit le script "
                         "(nombre de pistes ou résolution différents) : ses retouches ne peuvent pas y être reportées.")
    res = []
    for i, (pa, pb) in enumerate(zip(base.tracks, retouche.tracks)):
        na, aa = _notes(_evenements(pa))
        nb, ab = _notes(_evenements(pb))
        restantes = {}
        for d, f, on, off in nb:
            restantes.setdefault((on[1].channel, on[1].note, d), []).append((d, f, on[1].velocity))
        for d, f, on, off in sorted(na, key=lambda n: n[0]):
            c, n, v = on[1].channel, on[1].note, on[1].velocity
            cand = restantes.get((c, n, d))
            if not cand:
                res.append({"op": "supprime", "piste": i, "canal": c, "note": n, "debut": d, "fin": f, "velocite": v})
                continue
            _, f2, v2 = cand.pop(0)
            if f2 != f or v2 != v:
                res.append({"op": "change", "piste": i, "canal": c, "note": n, "debut": d, "fin": f2, "velocite": v2,
                            "avant": {"fin": f, "velocite": v}})
        for (c, n, d), reste in restantes.items():
            for _, f, v in reste:
                res.append({"op": "ajoute", "piste": i, "canal": c, "note": n, "debut": d, "fin": f, "velocite": v})
        ca, cb = Counter((t, _cle(m)) for t, m in aa), Counter((t, _cle(m)) for t, m in ab)
        par_cle = {(t, _cle(m)): m for t, m in aa + ab}
        for (t, k), nb_ in (ca - cb).items():
            res += [{"op": "evenement-", "piste": i, "tick": t, "message": _dict(par_cle[(t, k)])}] * nb_
        for (t, k), nb_ in (cb - ca).items():
            res += [{"op": "evenement+", "piste": i, "tick": t, "message": _dict(par_cle[(t, k)])}] * nb_
    return sorted(res, key=lambda r: (r.get("debut", r.get("tick", 0)), r["piste"]))


def applique(mid, retouches):
    """Le morceau `mid` (ce que produit la recette) avec les retouches → nouveau MidiFile. Une retouche qui ne
    trouve plus sa note (la recette a changé à cet endroit) est ignorée et renvoyée dans `introuvables`."""
    pistes = [_evenements(p) for p in mid.tracks]
    fins = [max([t for t, _ in ev] or [0]) for ev in pistes]
    introuvables = []
    for r in retouches:
        ev = pistes[r["piste"]]
        if r["op"] in ("supprime", "change"):
            notes, _ = _notes(ev)
            trouve = next((x for x in notes if x[2][1].channel == r["canal"] and x[2][1].note == r["note"] and x[0] == r["debut"]), None)
            if not trouve:
                introuvables.append(r)
                continue
            _, _, on, off = trouve
            if r["op"] == "supprime":
                ev.remove(on)
                ev.remove(off)
            else:
                off[0] = r["fin"]
                on[1] = on[1].copy(velocity=r["velocite"])
        elif r["op"] == "ajoute":
            ev.append([r["debut"], mido.Message("note_on", channel=r["canal"], note=r["note"], velocity=r["velocite"])])
            ev.append([r["fin"], mido.Message("note_off", channel=r["canal"], note=r["note"], velocity=0)])
        elif r["op"] == "evenement-":
            k = (r["tick"], _cle(_message(r["message"])))
            e = next((e for e in ev if (e[0], _cle(e[1])) == k), None)
            if e is None:
                introuvables.append(r)
            else:
                ev.remove(e)
        elif r["op"] == "evenement+":
            ev.append([r["tick"], _message(r["message"])])
    sortie = mido.MidiFile(type=mid.type, ticks_per_beat=mid.ticks_per_beat)
    for ev, fin in zip(pistes, fins):
        ev = sorted((e for e in ev if e[1].type != "end_of_track"), key=lambda e: (e[0], ORDRE(e[1])))
        tr, prec = mido.MidiTrack(), 0
        for t, m in ev:
            tr.append(m.copy(time=t - prec))
            prec = t
        tr.append(mido.MetaMessage("end_of_track", time=max(0, fin - prec)))
        sortie.tracks.append(tr)
    sortie.introuvables = introuvables
    return sortie


def en_python(retouches, base):
    """Les retouches écrites en Python (une par ligne), avec en commentaire la position en mesures, la piste et ce
    qui change, pour qu'on puisse les relire et les modifier à la main."""
    tpb = base.ticks_per_beat
    chif = [(t, m.numerator, m.denominator) for p in base.tracks for t, m in _evenements(p) if m.type == "time_signature"]
    mes = midi_texte.Mesures(tpb, chif)
    noms = [next((m.name for m in p if m.type == "track_name"), f"piste {i}") for i, p in enumerate(base.tracks)]
    temps = lambda d: f"{d / tpb:.2f}".replace(".", ",")
    lignes = []
    for r in retouches:
        t = r.get("debut", r.get("tick", 0))
        m, b, k = mes.position(t + mes.temps(t) // 2)        # au temps le plus proche (attaques humanisées)
        ou = f"m{m}.{b} {noms[r['piste']]}"
        if r["op"] in ("ajoute", "supprime", "change"):
            n = midi_texte.nom_note(r["note"], r["canal"])
            if r["op"] == "change":
                a = r["avant"]
                quoi = " · ".join(([f"durée {temps(a['fin'] - t)} → {temps(r['fin'] - t)} temps"] if a["fin"] != r["fin"] else [])
                                  + ([f"vélocité {a['velocite']} → {r['velocite']}"] if a["velocite"] != r["velocite"] else []))
                note = f"{n} : {quoi}"
            else:
                note = f"{n} {'ajoutée' if r['op'] == 'ajoute' else 'supprimée'} (durée {temps(r['fin'] - t)} temps, vélocité {r['velocite']})"
            d = {k: v for k, v in r.items() if k != "avant"}
        else:
            note = f"{'ajout' if r['op'] == 'evenement+' else 'retrait'} : {r['message'].get('type')}"
            d = r
        lignes.append(f"    {d!r},  # {ou} {note}")
    return "RETOUCHES = [\n" + "\n".join(lignes) + ("\n" if lignes else "") + "]"
