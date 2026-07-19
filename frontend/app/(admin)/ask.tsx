import { useRef, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api } from "@/src/api/client";
import { showAlert } from "@/src/utils/dialog";
import { colors, spacing } from "@/src/theme";

type Turn = { role: "user" | "assistant"; text: string };

const ESEMPI = [
  "Quante macchine ha fatto Luciano negli ultimi 15 giorni?",
  "Quali commesse sono ancora aperte?",
  "Chi ha lavorato di più questa settimana?",
  "Che lavori abbiamo fatto sulla Smart di De Luca?",
];

export default function AskAI() {
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    setText("");
    setBusy(true);
    setTurns((prev) => [...prev, { role: "user", text: question }]);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    try {
      const r = await api<{ answer: string }>("/admin/ask", {
        method: "POST",
        body: { question, history: turns.slice(-6) },
      });
      setTurns((prev) => [...prev, { role: "assistant", text: r.answer }]);
    } catch (e: any) {
      showAlert("Errore", e?.message || "AI non disponibile, riprova");
      setTurns((prev) => prev.slice(0, -1));
      setText(question);
    } finally {
      setBusy(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity testID="back-button" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.headerLabel}>RISPOSTE DAI DATI VERI</Text>
          <Text style={styles.title}>CHIEDI ALL'AI</Text>
        </View>
        <Ionicons name="sparkles" size={22} color={colors.primary} />
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg }}>
          {turns.length === 0 ? (
            <View>
              <Text style={styles.introTitle}>Fai una domanda sull'officina</Text>
              <Text style={styles.introText}>
                Rispondo con i numeri veri del registro: commesse, ore, operai, veicoli.
              </Text>
              {ESEMPI.map((e) => (
                <TouchableOpacity key={e} testID={`esempio-${e.slice(0, 12)}`} style={styles.esempio} onPress={() => ask(e)}>
                  <Ionicons name="help-circle-outline" size={16} color={colors.primary} />
                  <Text style={styles.esempioText}>{e}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : (
            turns.map((t, i) => (
              <View key={i} style={[styles.bubble, t.role === "user" ? styles.bubbleUser : styles.bubbleAi]}>
                <Text style={[styles.bubbleAuthor, t.role === "user" ? styles.authorUser : styles.authorAi]}>
                  {t.role === "user" ? "TU" : "AI"}
                </Text>
                <Text style={[styles.bubbleText, t.role === "user" && { color: colors.textInverse }]}>{t.text}</Text>
              </View>
            ))
          )}
          {busy && (
            <View style={[styles.bubble, styles.bubbleAi, { flexDirection: "row", gap: 8, alignItems: "center" }]}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.thinking}>Guardo il registro…</Text>
            </View>
          )}
        </ScrollView>

        <View style={styles.inputRow}>
          <TextInput
            testID="ask-input"
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Scrivi la domanda…"
            placeholderTextColor={colors.textSecondary}
            multiline
            editable={!busy}
            onSubmitEditing={() => ask(text)}
          />
          <TouchableOpacity
            testID="btn-ask"
            style={[styles.sendBtn, (!text.trim() || busy) && { opacity: 0.4 }]}
            onPress={() => ask(text)}
            disabled={!text.trim() || busy}
          >
            <Ionicons name="send" size={18} color={colors.textInverse} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border,
    flexDirection: "row", alignItems: "center",
  },
  backBtn: { padding: 4 },
  headerLabel: { fontSize: 10, letterSpacing: 2.5, color: colors.textSecondary, fontWeight: "700" },
  title: { fontSize: 22, fontWeight: "900", color: colors.text, letterSpacing: -0.5 },
  introTitle: { fontSize: 16, fontWeight: "900", color: colors.text, marginBottom: 6 },
  introText: { fontSize: 13, color: colors.textSecondary, marginBottom: spacing.md, lineHeight: 19 },
  esempio: {
    flexDirection: "row", alignItems: "center", gap: 8,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: 8,
  },
  esempioText: { fontSize: 13, color: colors.text, flex: 1 },
  bubble: { padding: 12, marginBottom: 8, maxWidth: "92%" },
  bubbleUser: { backgroundColor: colors.text, alignSelf: "flex-end" },
  bubbleAi: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: colors.border, alignSelf: "flex-start" },
  bubbleAuthor: { fontSize: 9, letterSpacing: 1.5, fontWeight: "900", marginBottom: 4 },
  authorUser: { color: "#A1A1AA" },
  authorAi: { color: colors.primary },
  bubbleText: { fontSize: 14, color: colors.text, lineHeight: 20 },
  thinking: { fontSize: 13, color: colors.textSecondary, fontStyle: "italic" },
  inputRow: {
    flexDirection: "row", alignItems: "flex-end", gap: 8,
    padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.borderStrong,
  },
  input: {
    flex: 1, borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, minHeight: 44, maxHeight: 100, color: colors.text,
  },
  sendBtn: { width: 44, height: 44, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" },
});
