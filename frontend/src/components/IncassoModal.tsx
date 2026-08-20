import { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, Modal, ScrollView, TextInput, TouchableOpacity, ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  WorkOrder, registraIncasso, annullaIncasso, preventivoCommessa,
} from "@/src/api/client";
import { confirmDialog, showAlert } from "@/src/utils/dialog";
import { colors, spacing } from "@/src/theme";

/** I modi in cui si incassa in officina. Testo libero lato server: questi sono solo i rapidi. */
const MEZZI = ["contanti", "bancomat", "bonifico", "assegno"];

function euro(n: number | null | undefined): string {
  return n == null ? "—" : `${n.toFixed(2)} €`;
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
 * È un ACCONTO, non un interruttore: da Valente si lavora così — «rimane 150»,
 * «deve dare ancora 10» — quindi il totale si scrive una volta e poi si incassa
 * a rate finché il residuo non è zero. Solo allora la commessa risulta saldata.
 *
 * Lo possono usare tutti i titolari, non solo chi ha aperto la commessa.
 */
export function IncassoModal({ commessa, onChiudi, onFatto }: Props) {
  const [totale, setTotale] = useState("");
  const [importo, setImporto] = useState("");
  const [mezzo, setMezzo] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [caricando, setCaricando] = useState(false);

  const pagamenti = commessa?.pagamenti || [];
  const incassato = commessa?.incassato || 0;

  // All'apertura si propone il totale che già conosciamo. Se non c'è, si va a prendere
  // quello del preventivo: è il numero che il titolare ha davanti agli occhi su Telegram.
  useEffect(() => {
    if (!commessa) return;
    setMezzo(null);
    if (commessa.totale_dovuto != null) {
      const t = commessa.totale_dovuto;
      setTotale(t.toFixed(2));
      setImporto(Math.max(0, t - incassato).toFixed(2));
      return;
    }
    setTotale("");
    setImporto("");
    setCaricando(true);
    preventivoCommessa(commessa.id)
      .then((p) => {
        if (p?.totale) {
          setTotale(p.totale.toFixed(2));
          setImporto(p.totale.toFixed(2));
        }
      })
      .catch(() => { /* nessun preventivo: si scrive a mano, non è un errore */ })
      .finally(() => setCaricando(false));
  }, [commessa, incassato]);

  const num = (s: string) => {
    const n = parseFloat((s || "").replace(",", ".").trim());
    return Number.isFinite(n) ? n : NaN;
  };

  const totaleNum = num(totale);
  const importoNum = num(importo);
  const residuoDopo = Number.isFinite(totaleNum) && Number.isFinite(importoNum)
    ? Math.round((totaleNum - incassato - importoNum) * 100) / 100
    : null;

  const salva = useCallback(async () => {
    if (!commessa) return;
    if (!Number.isFinite(importoNum) || importoNum <= 0) {
      showAlert("Importo mancante", "Scrivi quanto hai incassato.");
      return;
    }
    if (Number.isFinite(totaleNum) && importoNum > totaleNum - incassato + 0.005) {
      const ok = await confirmDialog(
        "Più del dovuto",
        `Stai registrando ${euro(importoNum)} ma ne mancavano ${euro(totaleNum - incassato)}. Procedo lo stesso?`,
      );
      if (!ok) return;
    }
    setSalvando(true);
    try {
      const agg = await registraIncasso(
        commessa.id, importoNum,
        Number.isFinite(totaleNum) ? totaleNum : undefined,
        mezzo || undefined,
      );
      onFatto(agg);
      onChiudi();
    } catch (e: any) {
      showAlert("Non registrato", e?.message || "Riprova");
    } finally { setSalvando(false); }
  }, [commessa, importoNum, totaleNum, incassato, mezzo, onFatto, onChiudi]);

  const annulla = useCallback(async () => {
    if (!commessa || pagamenti.length === 0) return;
    const ultimo = pagamenti[pagamenti.length - 1];
    const ok = await confirmDialog(
      "Annullo l'ultimo incasso?",
      `Verranno tolti ${euro(ultimo.importo)}. Gli acconti precedenti restano.`,
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
                  <Text key={i} style={s.giaRiga}>
                    {euro(p.importo)}{p.mezzo ? ` · ${p.mezzo}` : ""}
                    {p.da_nome ? ` · ${p.da_nome}` : ""}
                  </Text>
                ))}
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

            <Text style={[s.label, { marginTop: spacing.lg }]}>QUANTO INCASSI ADESSO</Text>
            <TextInput
              testID="incasso-importo"
              style={[s.input, s.inputGrande]}
              value={importo}
              onChangeText={setImporto}
              keyboardType="decimal-pad"
              placeholder="0,00"
              placeholderTextColor={colors.textSecondary}
            />

            <View style={s.mezzi}>
              {MEZZI.map((m) => (
                <TouchableOpacity
                  key={m}
                  testID={`incasso-mezzo-${m}`}
                  style={[s.mezzo, mezzo === m && s.mezzoOn]}
                  onPress={() => setMezzo(mezzo === m ? null : m)}
                >
                  <Text style={[s.mezzoTxt, mezzo === m && s.mezzoTxtOn]}>{m.toUpperCase()}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {residuoDopo != null ? (
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
  sheet: { backgroundColor: colors.bg, borderTopWidth: 2, borderTopColor: colors.borderStrong, maxHeight: "90%" },
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
  giaBox: {
    borderLeftWidth: 3, borderLeftColor: colors.active, paddingLeft: spacing.md,
    marginBottom: spacing.lg,
  },
  giaTitolo: { fontSize: 11, letterSpacing: 1.5, fontWeight: "800", color: colors.active },
  giaRiga: { fontSize: 12, color: colors.textSecondary, marginTop: 3 },
  annullaLink: {
    fontSize: 12, color: colors.stopped, fontWeight: "700", marginTop: 6,
    textDecorationLine: "underline",
  },
  mezzi: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: spacing.md },
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
