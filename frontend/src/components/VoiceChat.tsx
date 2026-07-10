import { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator,
  Linking, Animated, Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import {
  AudioModule, RecordingPresets, useAudioRecorder,
} from "expo-audio";
import { api, Conversation, ConversationTurn, SchedaTecnica, VoiceTurnResp, transcribeAudio, lookupPlate } from "@/src/api/client";
import { confirmDialog, showAlert } from "@/src/utils/dialog";
import { colors, spacing } from "@/src/theme";

type Props = { orderId: string; readOnly?: boolean };

export function VoiceChat({ orderId, readOnly }: Props) {
  const [scheda, setScheda] = useState<SchedaTecnica | null>(null);
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [scanning, setScanning] = useState(false);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const pulse = useRef(new Animated.Value(1)).current;

  const load = useCallback(async () => {
    try {
      const c = await api<Conversation>(`/work-orders/${orderId}/conversation`);
      setScheda(c.scheda_tecnica);
      setTurns(c.turns);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [orderId]);

  useEffect(() => { load(); }, [load]);

  // Pulse animation while recording
  useEffect(() => {
    if (recording) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1.15, duration: 500, useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 1.0, duration: 500, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulse.stopAnimation();
      pulse.setValue(1);
    }
  }, [recording, pulse]);

  const sendTurn = async (userText: string) => {
    if (!userText.trim() || sending) return;
    setSending(true);
    // Optimistic: append user turn immediately
    const optimistic: ConversationTurn = {
      role: "user", text: userText.trim(), timestamp: new Date().toISOString(),
    };
    setTurns((prev) => [...prev, optimistic]);
    try {
      const resp = await api<VoiceTurnResp>(`/work-orders/${orderId}/voice-turn`, {
        method: "POST",
        body: { user_text: userText.trim() },
      });
      setScheda(resp.scheda_tecnica);
      setTurns((prev) => [...prev, resp.turn]);
    } catch (e: any) {
      showAlert("Errore", e?.message || "AI non disponibile");
      setTurns((prev) => prev.filter((t) => t !== optimistic));
    } finally {
      setSending(false);
    }
  };

  const submitText = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    await sendTurn(t);
  };

  const startRecording = async () => {
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        if (!perm.canAskAgain) {
          const goSettings = await confirmDialog("Microfono", "Serve il permesso microfono. Aprire le impostazioni?", "Impostazioni");
          if (goSettings) Linking.openSettings();
        } else {
          showAlert("Permesso negato", "Non posso registrare senza permesso microfono.");
        }
        return;
      }
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecording(true);
    } catch (e: any) {
      setRecording(false);
      showAlert("Errore registrazione", e?.message || "Impossibile registrare");
    }
  };

  const stopRecording = async () => {
    if (!recording) return;
    setRecording(false);
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) return;
      setTranscribing(true);
      const transcript = await transcribeAudio(uri, "audio/m4a", "note.m4a");
      setTranscribing(false);
      if (transcript.trim()) {
        await sendTurn(transcript);
      } else {
        showAlert("Nulla trascritto", "Non ho capito niente. Riprova avvicinando il microfono.");
      }
    } catch (e: any) {
      setTranscribing(false);
      showAlert("Errore", e?.message || "Impossibile trascrivere");
    }
  };

  const scanPlate = async () => {
    const camPerm = await ImagePicker.requestCameraPermissionsAsync();
    if (!camPerm.granted) {
      if (!camPerm.canAskAgain) {
        const goSettings = await confirmDialog("Fotocamera", "Serve permesso fotocamera. Apri Impostazioni.", "Impostazioni");
        if (goSettings) Linking.openSettings();
      } else showAlert("Permesso negato", "Non posso scattare senza permesso.");
      return;
    }
    const res = await ImagePicker.launchCameraAsync({ quality: 0.5, base64: true, mediaTypes: ["images"] });
    if (res.canceled || !res.assets[0]?.base64) return;
    setScanning(true);
    try {
      const out = await api<{ plate: string | null; raw: string }>("/vision/plate", {
        method: "POST",
        body: { image_base64: res.assets[0].base64 },
      });
      if (out.plate) {
        try {
          await lookupPlate(orderId, out.plate);
          // Messaggio locale di attesa; la risposta vera arriva da STAR via Omnius
          setTurns((prev) => [...prev, {
            role: "assistant",
            text: `Targa ${out.plate} letta — chiedo i dati del veicolo a STAR...`,
            timestamp: new Date().toISOString(),
          } as ConversationTurn]);
          // Attendi la risposta: ricontrolla la conversazione ogni 5s (max ~75s)
          const plate = out.plate;
          let tries = 0;
          const poll = setInterval(async () => {
            tries++;
            try {
              const c = await api<Conversation>(`/work-orders/${orderId}/conversation`);
              const answered = c.turns.some(
                (t) => t.role === "assistant" && t.text.startsWith(`Targa ${plate}:`)
              );
              if (answered || tries >= 15) {
                clearInterval(poll);
                if (answered) {
                  setScheda(c.scheda_tecnica);
                  setTurns(c.turns);
                }
              }
            } catch { if (tries >= 15) clearInterval(poll); }
          }, 5000);
        } catch (e: any) {
          showAlert("Targa letta ma richiesta non inviata", e?.message || `Targa: ${out.plate}`);
        }
      } else {
        showAlert("Targa non letta", `Risposta AI: ${out.raw}`);
      }
    } catch (e: any) {
      showAlert("Errore OCR", e?.message || "Impossibile leggere targa");
    } finally { setScanning(false); }
  };

  if (loading) return <View style={styles.loader}><ActivityIndicator color={colors.text} /></View>;

  return (
    <View>
      {/* Scheda tecnica card */}
      <View testID="scheda-tecnica-card" style={styles.schedaCard}>
        <View style={styles.schedaHeader}>
          <Text style={styles.schedaTitle}>SCHEDA TECNICA AI</Text>
          {sending || transcribing || scanning ? <ActivityIndicator size="small" color={colors.primary} /> : null}
        </View>
        <SchedaRow label="MARCA" value={scheda?.marca} />
        <SchedaRow label="MODELLO" value={scheda?.modello} />
        <SchedaRow label="ANNO" value={scheda?.anno} />
        <SchedaRow label="MOTORE" value={scheda?.motore} />
        <SchedaRow label="KM" value={scheda?.km} />
        <SchedaList label="LAVORI FATTI" items={scheda?.lavori_fatti || []} color={colors.active} />
        <SchedaList label="DA FARE" items={scheda?.lavori_da_fare || []} color={colors.idle} />
        <SchedaList label="RICAMBI NECESSARI" items={scheda?.ricambi_necessari || []} color={colors.primary} />
        {scheda?.note ? (
          <View style={{ marginTop: spacing.sm }}>
            <Text style={styles.rowLabel}>NOTE</Text>
            <Text style={styles.rowValue}>{scheda.note}</Text>
          </View>
        ) : null}
        {!scheda?.marca && !scheda?.modello && (scheda?.lavori_fatti?.length ?? 0) === 0 && (
          <Text style={styles.schedaEmpty}>
            Nessuna informazione ancora. {readOnly ? "L'operaio non ha ancora dettato." : "Detta qui sotto per iniziare."}
          </Text>
        )}
      </View>

      {/* Chat conversation */}
      <Text style={styles.section}>DIALOGO AI</Text>
      <ScrollView style={styles.chatBox} contentContainerStyle={{ padding: spacing.md }}>
        {turns.length === 0 ? (
          <Text style={styles.emptyChat}>
            {readOnly ? "Nessuna conversazione." : "Inizia parlando: descrivi la macchina, cosa hai fatto e cosa manca."}
          </Text>
        ) : (
          turns.map((t, i) => (
            <View key={i} style={[styles.bubble, t.role === "user" ? styles.bubbleUser : styles.bubbleAi]}>
              <Text style={[styles.bubbleAuthor, t.role === "user" ? styles.bubbleAuthorUser : styles.bubbleAuthorAi]}>
                {t.role === "user" ? (t.worker_full_name || "OPERAIO").toUpperCase() : "AI"}
              </Text>
              <Text style={[styles.bubbleText, t.role === "user" && { color: colors.textInverse }]}>{t.text}</Text>
            </View>
          ))
        )}
      </ScrollView>

      {/* Input row */}
      {!readOnly && (
        <View style={styles.inputWrap}>
          <View style={styles.actionsRow}>
            <TouchableOpacity
              testID="btn-scan-plate"
              onPress={scanPlate}
              disabled={scanning || sending || recording}
              style={[styles.actionMini, (scanning || sending) && { opacity: 0.5 }]}
            >
              <Ionicons name="scan-outline" size={18} color={colors.text} />
              <Text style={styles.actionMiniText}>TARGA</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.inputRow}>
            <TextInput
              testID="voice-chat-input"
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder="Scrivi o premi il mic per dettare..."
              placeholderTextColor={colors.textSecondary}
              editable={!sending && !recording && !transcribing}
              multiline
            />
            {text.trim() ? (
              <TouchableOpacity testID="btn-send-text" style={styles.sendBtn} onPress={submitText} disabled={sending}>
                <Ionicons name="send" size={20} color={colors.textInverse} />
              </TouchableOpacity>
            ) : (
              <Animated.View style={{ transform: [{ scale: pulse }] }}>
                <TouchableOpacity
                  testID="btn-mic"
                  style={[styles.micBtn, recording && styles.micBtnActive]}
                  onPress={recording ? stopRecording : startRecording}
                  disabled={sending || transcribing}
                >
                  {transcribing ? (
                    <ActivityIndicator color={colors.textInverse} />
                  ) : (
                    <Ionicons name={recording ? "stop" : "mic"} size={26} color={colors.textInverse} />
                  )}
                </TouchableOpacity>
              </Animated.View>
            )}
          </View>
          <Text style={styles.hint}>
            {recording ? "🔴 REGISTRAZIONE... tocca di nuovo per inviare" : transcribing ? "Trascrivo..." : sending ? "AI sta rispondendo..." : "Tocca il mic per dettare"}
          </Text>
        </View>
      )}
    </View>
  );
}

function SchedaRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <View style={styles.schedaRow}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function SchedaList({ label, items, color }: { label: string; items: string[]; color: string }) {
  if (!items.length) return null;
  return (
    <View style={{ marginTop: spacing.sm }}>
      <Text style={[styles.rowLabel, { color }]}>{label}</Text>
      {items.map((it, i) => (
        <View key={i} style={styles.listItem}>
          <View style={[styles.listDot, { backgroundColor: color }]} />
          <Text style={styles.listText}>{it}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  loader: { padding: spacing.lg, alignItems: "center" },
  schedaCard: {
    marginHorizontal: spacing.lg, marginBottom: spacing.md, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgMuted,
  },
  schedaHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    marginBottom: spacing.sm, paddingBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  schedaTitle: { fontSize: 11, letterSpacing: 2.5, fontWeight: "900", color: colors.text },
  schedaEmpty: { fontSize: 12, color: colors.textSecondary, fontStyle: "italic" },
  schedaRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 },
  rowLabel: { fontSize: 10, letterSpacing: 2, fontWeight: "800", color: colors.textSecondary },
  rowValue: { fontSize: 14, fontWeight: "700", color: colors.text },
  listItem: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 4 },
  listDot: { width: 6, height: 6, borderRadius: 3, marginTop: 6 },
  listText: { flex: 1, fontSize: 13, color: colors.text, lineHeight: 18 },
  section: {
    marginHorizontal: spacing.lg, marginTop: spacing.sm, marginBottom: spacing.sm,
    fontSize: 11, letterSpacing: 3, fontWeight: "800", color: colors.textSecondary,
  },
  chatBox: {
    marginHorizontal: spacing.lg, borderWidth: 1, borderColor: colors.border, maxHeight: 320, minHeight: 100,
  },
  emptyChat: { color: colors.textSecondary, fontStyle: "italic", fontSize: 13, textAlign: "center", paddingVertical: spacing.md },
  bubble: { padding: 10, marginBottom: 6, maxWidth: "88%" },
  bubbleUser: { backgroundColor: colors.text, alignSelf: "flex-end" },
  bubbleAi: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: colors.border, alignSelf: "flex-start" },
  bubbleAuthor: { fontSize: 9, letterSpacing: 1.5, fontWeight: "900", marginBottom: 3 },
  bubbleAuthorUser: { color: "#A1A1AA" },
  bubbleAuthorAi: { color: colors.primary },
  bubbleText: { fontSize: 14, color: colors.text, lineHeight: 19 },
  inputWrap: { marginHorizontal: spacing.lg, marginTop: spacing.sm },
  actionsRow: { flexDirection: "row", gap: 6, marginBottom: 6 },
  actionMini: {
    flexDirection: "row", alignItems: "center", gap: 4,
    borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10, paddingVertical: 6,
  },
  actionMiniText: { fontSize: 10, letterSpacing: 1.5, fontWeight: "800", color: colors.text },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  input: {
    flex: 1, borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, minHeight: 48, maxHeight: 100, color: colors.text,
  },
  sendBtn: { width: 48, height: 48, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" },
  micBtn: { width: 56, height: 56, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", borderRadius: Platform.OS === "web" ? 0 : 0 },
  micBtnActive: { backgroundColor: colors.stopped },
  hint: { fontSize: 11, color: colors.textSecondary, marginTop: 6, textAlign: "center" },
});
