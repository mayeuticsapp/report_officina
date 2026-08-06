import { useCallback, useEffect, useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, Linking } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  telegramStato, telegramAggancia, telegramRimuovi, type TelegramStato,
} from "@/src/api/client";
import { showAlert } from "@/src/utils/dialog";
import { colors, spacing } from "@/src/theme";

/**
 * Collega Telegram per ricevere un avviso a ogni lavoro completato.
 *
 * Ogni titolare si aggancia in chat privata col bot, non in un gruppo: nei gruppi
 * Telegram attiva la modalita privacy e il bot non vedrebbe i messaggi, quindi non
 * potrebbe registrare nessuno. In privato riceve tutto.
 */
export function TelegramCollega() {
  const [stato, setStato] = useState<TelegramStato | null>(null);
  const [caricando, setCaricando] = useState(true);
  const [agganciando, setAgganciando] = useState(false);

  const carica = useCallback(async () => {
    try { setStato(await telegramStato()); }
    catch (e) { console.warn("telegram stato", e); }
    finally { setCaricando(false); }
  }, []);

  useEffect(() => { void carica(); }, [carica]);

  const aggancia = async () => {
    setAgganciando(true);
    try {
      const nuovo = await telegramAggancia();
      const prima = stato?.agganciati.length ?? 0;
      setStato(nuovo);
      if (nuovo.agganciati.length > prima) {
        showAlert("Collegato", "Riceverai un avviso su Telegram a ogni lavoro completato.");
      } else {
        showAlert(
          "Nessuno da collegare",
          "Apri il bot su Telegram e premi AVVIA, poi torna qui e riprova."
        );
      }
    } catch (e: any) {
      showAlert("Non riuscito", e?.message || "Riprova fra poco.");
    } finally { setAgganciando(false); }
  };

  const rimuovi = async (chatId: string, nome: string) => {
    try {
      await telegramRimuovi(chatId);
      setStato((s) => s ? { ...s, agganciati: s.agganciati.filter((c) => c.chat_id !== chatId) } : s);
    } catch (e) {
      showAlert("Non riuscito", `Non sono riuscito a scollegare ${nome}.`);
    }
  };

  if (caricando) {
    return (
      <View style={styles.card}>
        <ActivityIndicator color={colors.text} />
      </View>
    );
  }

  if (!stato?.configurato) {
    return (
      <View style={styles.card}>
        <Text style={styles.titolo}>AVVISI TELEGRAM</Text>
        <Text style={styles.spiega}>
          Non ancora attivi: manca il collegamento al bot. Chiedi a chi gestisce l&apos;app di
          configurarlo.
        </Text>
      </View>
    );
  }

  const bot = stato.bot_username;

  return (
    <View style={styles.card}>
      <Text style={styles.titolo}>AVVISI TELEGRAM</Text>
      <Text style={styles.spiega}>
        Un messaggio su Telegram a ogni lavoro completato, con targa, meccanico e ore.
        Arriva anche ad app chiusa.
      </Text>

      {stato.agganciati.length > 0 ? (
        <View style={styles.elenco}>
          {stato.agganciati.map((c) => (
            <View key={c.chat_id} style={styles.riga}>
              <Ionicons
                name={c.attivo ? "checkmark-circle" : "alert-circle"}
                size={18}
                color={c.attivo ? colors.active : colors.idle}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.nome}>{c.nome || c.username || c.chat_id}</Text>
                {!c.attivo ? (
                  <Text style={styles.bloccato}>Ha bloccato il bot: non riceve avvisi</Text>
                ) : null}
              </View>
              <TouchableOpacity onPress={() => rimuovi(c.chat_id, c.nome || c.chat_id)}>
                <Text style={styles.scollega}>SCOLLEGA</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.nessuno}>Nessuno riceve ancora gli avvisi.</Text>
      )}

      <View style={styles.passi}>
        <Text style={styles.passo}>
          <Text style={styles.passoNum}>1. </Text>
          {bot ? `Apri @${bot} su Telegram e premi AVVIA` : "Apri il bot su Telegram e premi AVVIA"}
        </Text>
        <Text style={styles.passo}>
          <Text style={styles.passoNum}>2. </Text>
          Torna qui e tocca COLLEGA
        </Text>
      </View>

      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        {bot ? (
          <TouchableOpacity
            testID="btn-apri-bot"
            style={styles.btnAlt}
            onPress={() => Linking.openURL(`https://t.me/${bot}`)}
          >
            <Ionicons name="open-outline" size={16} color={colors.text} />
            <Text style={styles.btnAltText}>APRI IL BOT</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          testID="btn-telegram-aggancia"
          style={[styles.btn, agganciando && { opacity: 0.6 }]}
          onPress={aggancia}
          disabled={agganciando}
        >
          {agganciando
            ? <ActivityIndicator color={colors.textInverse} size="small" />
            : <Ionicons name="link" size={16} color={colors.textInverse} />}
          <Text style={styles.btnText}>{agganciando ? "COLLEGO…" : "COLLEGA"}</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.suggerimento}>
        Dalle impostazioni della chat col bot puoi scegliere una suoneria personalizzata,
        anche lunga: te ne accorgi anche col telefono in tasca.
      </Text>
    </View>
  );
}

const styles = {
  card: {
    borderWidth: 1, borderColor: colors.border, padding: spacing.md,
    marginTop: spacing.md, gap: spacing.sm,
  },
  titolo: { fontSize: 11, letterSpacing: 2, fontWeight: "800" as any, color: colors.textSecondary },
  spiega: { fontSize: 13, color: colors.textSecondary, lineHeight: 19 },
  elenco: { gap: spacing.sm, marginTop: spacing.xs },
  riga: {
    flexDirection: "row" as const, alignItems: "center" as const, gap: spacing.sm,
    paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border,
  },
  nome: { fontSize: 14, fontWeight: "700" as any, color: colors.text },
  bloccato: { fontSize: 11, color: colors.idle, marginTop: 2 },
  scollega: { fontSize: 10, letterSpacing: 1, fontWeight: "800" as any, color: colors.textSecondary },
  nessuno: { fontSize: 13, color: colors.textSecondary, fontStyle: "italic" as const },
  passi: { gap: 4, marginTop: spacing.xs },
  passo: { fontSize: 13, color: colors.text },
  passoNum: { fontWeight: "800" as any },
  btn: {
    flex: 1, backgroundColor: colors.text, paddingVertical: spacing.md,
    flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "center" as const, gap: 8,
  },
  btnText: { color: colors.textInverse, fontSize: 12, fontWeight: "800" as any, letterSpacing: 1.5 },
  btnAlt: {
    flex: 1, borderWidth: 1, borderColor: colors.text, paddingVertical: spacing.md,
    flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "center" as const, gap: 8,
  },
  btnAltText: { color: colors.text, fontSize: 12, fontWeight: "800" as any, letterSpacing: 1.5 },
  suggerimento: { fontSize: 11, color: colors.textSecondary, lineHeight: 16, marginTop: spacing.xs },
};
