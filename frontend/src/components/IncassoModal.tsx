import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View, Text, StyleSheet, Modal, ScrollView, TextInput, TouchableOpacity, ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  WorkOrder, registraIncasso, annullaIncasso, preventivoCommessa,
} from "@/src/api/client";
import { confirmDialog, showAlert } from "@/src/utils/dialog";
import { colors, spacing } from "@/src/theme";

/** I modi in cui si incassa da Valente. Lato server è testo libero: questi sono i rapidi. */
const MEZZI = ["contanti", "bancomat", "carta", "scalapay", "bonifico", "assegno"];

function euro(n: number | null | undefined): string {
  return n == null ? "—" : `${n.toFixed(2)} €`;
}

/** «20/08/26 22:16» — data e ora dell'incasso, come si legge su una ricevuta. */
function quando(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const due = (n: number) => String(n).padStart(2, "0");
  return `${due(d.getDate())}/${due(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)} ` +
         `${due(d.getHours())}:${due(d.getMinutes())}`;
}

type Props = {
  commessa: WorkOrder | null;
  onChiudi: () => void;
  /** chiamata dopo ogni movimento andato a buon fine, con la commessa aggiornata */
  onFatto: (aggiornata: WorkOrder) => void;
};

/**
 * Registra i soldi entrati su una commessa.
 *
 * Due cose che sembrano dettagli e non lo sono:
 *
 * 1. È un ACCONTO, non un interruttore. Da Valente si lavora così — «rimane 150»,
 *    «deve dare ancora 10» — quindi il totale si scrive una volta e si incassa a rate
 *    finché il residuo non è zero. Solo allora la commessa risulta saldata.
 *
 * 2. Un incasso può essere DIVISO fra più mezzi: metà contanti e metà carta è normale.
 *    Le righe partono insieme e restano un pagamento solo, quindi si annullano insieme.
 *
 * Lo possono usare tutti i titolari, non solo chi ha aperto la commessa.
 */
export function IncassoModal({ commessa, onChiudi, onFatto }: Props) {
  const [totale, setTotale] = useState("");
  /** importo scritto per ogni mezzo scelto. Vuoto = nessun mezzo scelto, riga unica. */
  const [righe, setRighe] = useState<Record<string, string>>({});
  /** l'importo quando non si specifica il mezzo */
  const [semplice, setSemplice] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [caricando, setCaricando] = useState(false);

  const pagamenti = commessa?.pagamenti || [];
  const incassato = commessa?.incassato || 0;

  const num = (s: string) => {
    const n = parseFloat((s || "").replace(",", ".").trim());
    return Number.isFinite(n) ? n : NaN;
  };

  // All'apertura si propone il totale che già conosciamo. Se non c'è, si va a prendere
  // quello del preventivo: è il numero che il titolare ha davanti agli occhi su Telegram.
  useEffect(() => {
    if (!commessa) return;
    setRighe({});
    if (commessa.totale_dovuto != null) {
      const t = commessa.totale_dovuto;
      setTotale(t.toFixed(2));
      setSemplice(Math.max(0, t - incassato).toFixed(2));
      return;
    }
    setTotale("");
    setSemplice("");
    setCaricando(true);
    preventivoCommessa(commessa.id)
      .then((p) => {
        if (p?.totale) {
          setTotale(p.totale.toFixed(2));
          setSemplice(p.totale.toFixed(2));
        }
      })
      .catch(() => { /* nessun preventivo: si scrive a mano, non è un errore */ })
      .finally(() => setCaricando(false));
  }, [commessa, incassato]);

  const scelti = useMemo(() => Object.keys(righe), [righe]);

  /** Toccando un mezzo si apre la sua riga. Il primo eredita quello già scritto,
   *  così chi paga tutto in contanti tocca CONTANTI e ha già l'importo giusto. */
  const scegliMezzo = useCallback((m: string) => {
    setRighe((r) => {
      if (m in r) {
        const { [m]: _tolto, ...resto } = r;
        return resto;
      }
      return { ...r, [m]: Object.keys(r).length === 0 ? semplice : "" };
    });
  }, [semplice]);

  const daRegistrare = useMemo(() => {
    if (scelti.length === 0) {
      const n = num(semplice);
      return Number.isFinite(n) && n > 0 ? [{ importo: n, mezzo: undefined }] : [];
    }
    return scelti
      .map((m) => ({ importo: num(righe[m]), mezzo: m }))
      .filter((v) => Number.isFinite(v.importo) && v.importo > 0);
  }, [scelti, righe, semplice]);

  const somma = useMemo(
    () => Math.round(daRegistrare.reduce((t, v) => t + v.importo, 0) * 100) / 100,
    [daRegistrare],
  );

  const totaleNum = num(totale);
  const residuoDopo = Number.isFinite(totaleNum)
    ? Math.round((totaleNum - incassato - somma) * 100) / 100
    : null;

  const salva = useCallback(async () => {
    if (!commessa) return;
    if (daRegistrare.length === 0) {
      showAlert("Importo mancante", "Scrivi quanto hai incassato.");
      return;
    }
    if (Number.isFinite(totaleNum) && somma > totaleNum - incassato + 0.005) {
      const ok = await confirmDialog(
        "Più del dovuto",
        `Stai registrando ${euro(somma)} ma ne mancavano ${euro(totaleNum - incassato)}. Procedo lo stesso?`,
      );
      if (!ok) return;
    }
    setSalvando(true);
    try {
      const agg = await registraIncasso(
        commessa.id, daRegistrare, Number.isFinite(totaleNum) ? totaleNum : undefined,
      );
      onFatto(agg);
      onChiudi();
    } catch (e: any) {
      showAlert("Non registrato", e?.message || "Riprova");
    } finally { setSalvando(false); }
  }, [commessa, daRegistrare, somma, totaleNum, incassato, onFatto, onChiudi]);

  const annulla = useCallback(async () => {
    if (!commessa || pagamenti.length === 0) return;
    const ultimoIstante = pagamenti[pagamenti.length - 1].il;
    const insieme = pagamenti.filter((p) => p.il === ultimoIstante);
    const quanto = insieme.reduce((t, p) => t + (p.importo || 0), 0);
    const ok = await confirmDialog(
      "Annullo l'ultimo incasso?",
      `Verranno tolti ${euro(quanto)}${insieme.length > 1 ? ` (${insieme.length} righe dello stesso pagamento)` : ""}. ` +
      "Gli acconti precedenti restano.",
    );
    if (!ok) return;
    try {
      onFatto(await annullaIncasso(commessa.id));
    } catch (e: any) {
      showAlert("Non annullato", e?.message || "Riprova");
    }
  }, [commessa, pagamenti, onFatto]);

  return (
    <Modal visible={!!commessa} transparent animationType="slide" onRequestClose={onChiudi}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <View style={s.header}>
            <Text style={s.titolo}>REGISTRA INCASSO</Text>
            <TouchableOpacity testID="incasso-chiudi" onPress={onChiudi}>
              <Ionicons name="close" size={26} color={colors.text} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ padding: spacing.lg }} keyboardShouldPersistTaps="handled">
            <Text style={s.sub}>
              {commessa?.plate?.toUpperCase()}
              {commessa?.customer ? ` · ${commessa.customer}` : ""}
            </Text>

            {incassato > 0 ? (
              <View style={s.giaBox}>
                <Text style={s.giaTitolo}>GIÀ INCASSATO {euro(incassato)}</Text>
                {pagamenti.map((p, i) => (
                  <View key={i} style={s.giaRiga}>
                    <Text style={s.giaImporto}>{euro(p.importo)}</Text>
                    <Text style={s.giaMezzo}>{p.mezzo || "—"}</Text>
                    <Text style={s.giaQuando}>{quando(p.il)}</Text>
                  </View>
                ))}
                {pagamenti[0]?.da_nome ? (
                  <Text style={s.giaChi}>registrato da {pagamenti[pagamenti.length - 1].da_nome}</Text>
                ) : null}
                <TouchableOpacity testID="incasso-annulla-ultimo" onPress={annulla}>
                  <Text style={s.annullaLink}>Annulla l&apos;ultimo</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            <Text style={s.label}>TOTALE DEL LAVORO</Text>
            <TextInput
              testID="incasso-totale"
              style={s.input}
              value={totale}
              onChangeText={setTotale}
              keyboardType="decimal-pad"
              placeholder={caricando ? "..." : "0,00"}
              placeholderTextColor={colors.textSecondary}
            />
            <Text style={s.aiuto}>
              Proposto dal preventivo. Correggilo se il prezzo concordato è diverso.
            </Text>

            <Text style={[s.label, { marginTop: spacing.lg }]}>COME PAGA</Text>
            <Text style={s.aiuto}>
              Tocca uno o più mezzi. Se paga metà in un modo e metà in un altro, toccali
              entrambi e scrivi quanto per ciascuno.
            </Text>
            <View style={s.mezzi}>
              {MEZZI.map((m) => (
                <TouchableOpacity
                  key={m}
                  testID={`incasso-mezzo-${m}`}
                  style={[s.mezzo, m in righe && s.mezzoOn]}
                  onPress={() => scegliMezzo(m)}
                >
                  <Text style={[s.mezzoTxt, m in righe && s.mezzoTxtOn]}>{m.toUpperCase()}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {scelti.length === 0 ? (
              <>
                <Text style={[s.label, { marginTop: spacing.lg }]}>QUANTO INCASSI ADESSO</Text>
                <TextInput
                  testID="incasso-importo"
                  style={[s.input, s.inputGrande]}
                  value={semplice}
                  onChangeText={setSemplice}
                  keyboardType="decimal-pad"
                  placeholder="0,00"
                  placeholderTextColor={colors.textSecondary}
                />
              </>
            ) : (
              <View style={{ marginTop: spacing.md }}>
                {scelti.map((m) => (
                  <View key={m} style={s.rigaMezzo}>
                    <Text style={s.rigaMezzoNome}>{m.toUpperCase()}</Text>
                    <TextInput
                      testID={`incasso-importo-${m}`}
                      style={[s.input, s.inputRiga]}
                      value={righe[m]}
                      onChangeText={(v) => setRighe((r) => ({ ...r, [m]: v }))}
                      keyboardType="decimal-pad"
                      placeholder="0,00"
                      placeholderTextColor={colors.textSecondary}
                    />
                  </View>
                ))}
                <View style={s.sommaRiga}>
                  <Text style={s.sommaLabel}>INCASSI ADESSO</Text>
                  <Text style={s.sommaVal}>{euro(somma)}</Text>
                </View>
              </View>
            )}

            {residuoDopo != null && somma > 0 ? (
              <Text style={[s.esito, residuoDopo <= 0.004 ? s.esitoOk : s.esitoResta]}>
                {residuoDopo <= 0.004
                  ? "Con questo la commessa risulta SALDATA."
                  : `Dopo questo incasso resteranno ${euro(residuoDopo)} da avere.`}
              </Text>
            ) : null}

            <TouchableOpacity
              testID="incasso-conferma"
              style={[s.btn, salvando && { opacity: 0.5 }]}
              onPress={salva}
              disabled={salvando}
            >
              {salvando ? (
                <ActivityIndicator color={colors.textInverse} />
              ) : (
                <>
                  <Ionicons name="cash-outline" size={18} color={colors.textInverse} />
                  <Text style={s.btnTxt}>REGISTRA</Text>
                </>
              )}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.bg, borderTopWidth: 2, borderTopColor: colors.borderStrong, maxHeight: "92%" },
  header: {
    padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border,
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
  },
  titolo: { fontSize: 15, fontWeight: "900", letterSpacing: 1.5, color: colors.text },
  sub: { fontSize: 15, fontWeight: "800", color: colors.text, marginBottom: spacing.md },
  label: { fontSize: 11, letterSpacing: 2, color: colors.textSecondary, fontWeight: "700" },
  aiuto: { fontSize: 11, color: colors.textSecondary, marginTop: 4 },
  input: {
    borderWidth: 2, borderColor: colors.borderStrong, paddingHorizontal: 12, paddingVertical: 12,
    fontSize: 22, fontWeight: "900", color: colors.text, marginTop: 6, minHeight: 54,
  },
  inputGrande: { fontSize: 30 },
  inputRiga: { flex: 1, marginTop: 0, fontSize: 20, minHeight: 48 },
  rigaMezzo: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginBottom: spacing.sm },
  rigaMezzoNome: {
    width: 96, fontSize: 11, fontWeight: "800", letterSpacing: 1, color: colors.text,
  },
  sommaRiga: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    borderTopWidth: 2, borderTopColor: colors.borderStrong, paddingTop: spacing.sm, marginTop: 4,
  },
  sommaLabel: { fontSize: 11, letterSpacing: 2, fontWeight: "800", color: colors.textSecondary },
  sommaVal: { fontSize: 22, fontWeight: "900", color: colors.text },
  giaBox: {
    borderLeftWidth: 3, borderLeftColor: colors.active, paddingLeft: spacing.md,
    marginBottom: spacing.lg,
  },
  giaTitolo: { fontSize: 11, letterSpacing: 1.5, fontWeight: "800", color: colors.active },
  giaRiga: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: 4 },
  giaImporto: { fontSize: 13, fontWeight: "800", color: colors.text, minWidth: 66 },
  giaMezzo: { fontSize: 12, color: colors.textSecondary, flex: 1 },
  giaQuando: { fontSize: 11, color: colors.textSecondary },
  giaChi: { fontSize: 11, color: colors.textSecondary, marginTop: 4, fontStyle: "italic" },
  annullaLink: {
    fontSize: 12, color: colors.stopped, fontWeight: "700", marginTop: 6,
    textDecorationLine: "underline",
  },
  mezzi: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: spacing.sm },
  mezzo: { borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 8 },
  mezzoOn: { backgroundColor: colors.bgInverse, borderColor: colors.borderStrong },
  mezzoTxt: { fontSize: 11, fontWeight: "800", letterSpacing: 1, color: colors.textSecondary },
  mezzoTxtOn: { color: colors.textInverse },
  esito: { fontSize: 13, fontWeight: "700", marginTop: spacing.lg },
  esitoOk: { color: colors.active },
  esitoResta: { color: colors.idle },
  btn: {
    flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center",
    backgroundColor: colors.bgInverse, paddingVertical: 16, marginTop: spacing.lg,
  },
  btnTxt: { color: colors.textInverse, fontWeight: "900", letterSpacing: 1.5, fontSize: 14 },
});
