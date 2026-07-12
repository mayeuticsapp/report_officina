# -*- coding: utf-8 -*-
"""Esame AI Report Officina: 30 domande da meccanico, risposte del modello di produzione."""
import asyncio
import json
import sys

sys.path.insert(0, "/opt/reportofficina")
import ai  # il modulo di produzione: stesso modello, stessa configurazione

DOMANDE = [
    "Codice P0300 su benzina: quali sono le prime tre cause da verificare, in ordine?",
    "Codice P0420: cosa indica e cosa verifichi PRIMA di sostituire il catalizzatore?",
    "Differenza tra punterie idrauliche e meccaniche: su quali si registra il gioco valvole?",
    "Sostituzione cinghia distribuzione: cosa va sostituito insieme e perché?",
    "Frizione che slitta: sintomi tipici e una prova rapida per confermare?",
    "DPF intasato su un diesel usato solo in città: quali opzioni di intervento hai?",
    "Valvola EGR sporca: sintomi tipici sul motore?",
    "Volano bimassa: come capisci che è da sostituire?",
    "Spurgo freni su impianto tradizionale: da quale ruota si parte e perché?",
    "DOT4 e DOT5.1 si possono miscelare? E il DOT5?",
    "Batteria 12V: tensione corretta a riposo e con motore acceso?",
    "Alternatore che carica poco: come lo verifichi sul veicolo con il multimetro?",
    "Candelette diesel: sintomi di guasto e come le provi con il multimetro?",
    "Impianto common rail: che pressioni raggiunge e che precauzioni servono per intervenire?",
    "Turbina che manda olio nell'intercooler: cause più probabili?",
    "Olio 5W-30 contro 10W-40: cosa significano esattamente i due numeri?",
    "Specifiche ACEA C2/C3: cosa le distingue e perché contano su motori con DPF?",
    "Coppia di serraggio tipica dei bulloni ruota di un'auto media, e perché non tirare a fondo con l'avvitatore?",
    "Cuscinetto ruota rumoroso: come lo distingui da un rumore di gomme o differenziale?",
    "Ammortizzatori scarichi: segnali alla guida e prova pratica in officina?",
    "Clima che non raffredda: le prime tre verifiche da fare?",
    "Gas R134a e R1234yf: sono intercambiabili tra loro?",
    "Sonda lambda a monte e a valle del catalizzatore: che ruolo diverso hanno?",
    "Misfire solo a motore freddo che sparisce a caldo: quali piste segui?",
    "Auto a GPL: quali manutenzioni specifiche ha e ogni quanto si sostituisce il serbatoio?",
    "Start&stop che non interviene più: cause più comuni?",
    "Volante che vibra solo in frenata: causa tipica e rimedio corretto?",
    "Cambio pastiglie posteriori con freno di stazionamento elettrico: a cosa devi stare attento?",
    "Liquido refrigerante che cala lentamente senza perdite visibili: quali sospetti hai?",
    "Auto ibrida sul ponte: che precauzioni di sicurezza prendi prima di lavorare?",
]

SYSTEM = (
    "Sei un capo officina italiano con 30 anni di esperienza. Rispondi alla domanda del collega "
    "in modo CONCRETO e PRATICO, massimo 60 parole. Se un valore dipende dal modello specifico "
    "di veicolo, dillo chiaramente invece di inventare numeri."
)


async def main():
    out = []
    for i, q in enumerate(DOMANDE, 1):
        r = None
        for attempt in range(4):
            try:
                r = await ai.chat(
                    [{"role": "system", "content": SYSTEM}, {"role": "user", "content": q}],
                    max_tokens=220,
                )
                break
            except Exception as e:
                if "429" in str(e) and attempt < 3:
                    await asyncio.sleep(8 * (attempt + 1))
                else:
                    r = f"[ERRORE: {e}]"
                    break
        out.append({"n": i, "domanda": q, "risposta": (r or "").strip()})
        await asyncio.sleep(2.5)  # rispetta il rate limit
        print(f"{i}/30 ok", file=sys.stderr)
    print(json.dumps(out, ensure_ascii=False))


asyncio.run(main())
