import { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  OrderMessage, listOrderMessages, sendOrderMessage, editOrderMessage, deleteOrderMessage,
} from "@/src/api/client";
import { useAuth } from "@/src/auth/AuthContext";
import { confirmDialog, showAlert } from "@/src/utils/dialog";
import { colors, spacing } from "@/src/theme";

const POLL_MS = 20000;

export function OrderMessages({ orderId }: { orderId: string }) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<OrderMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const scrollRef = useRef<ScrollView>(null);

  const load = useCallback(async () => {
    try {
      setMessages(await listOrderMessages(orderId));
    } catch { /* silenzioso */ }
    finally { setLoading(false); }
  }, [orderId]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    // scorri in fondo quando arrivano messaggi
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 50);
  }, [messages.length]);

  const submit = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      const m = await sendOrderMessage(orderId, t);
      setText("");
      setMessages((prev) => [...prev, m]);
    } catch (e: any) {
      showAlert("Errore", e?.message || "Messaggio non inviato");
    } finally { setSending(false); }
  };

  const startEdit = (m: OrderMessage) => {
    setEditingId(m.id);
    setEditText(m.text);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const t = editText.trim();
    if (!t) { showAlert("Testo vuoto", "Scrivi il messaggio corretto o annulla."); return; }
    setSending(true);
    try {
      const updated = await editOrderMessage(editingId, t);
      setMessages((prev) => prev.map((m) => (m.id === editingId ? updated : m)));
      setEditingId(null);
      setEditText("");
    } catch (e: any) {
      showAlert("Errore", e?.message || "Modifica non salvata");
    } finally { setSending(false); }
  };

  const removeMessage = async (m: OrderMessage) => {
    const ok = await confirmDialog("Cancella messaggio", "Cancellare questo messaggio?", "Cancella");
    if (!ok) return;
    try {
      await deleteOrderMessage(m.id);
      setMessages((prev) => prev.filter((x) => x.id !== m.id));
    } catch (e: any) {
      showAlert("Errore", e?.message || "Impossibile cancellare");
    }
  };

  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const hm = d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    return sameDay ? hm : `${d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" })} ${hm}`;
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>MESSAGGI ({messages.length})</Text>

      <ScrollView ref={scrollRef} style={styles.box} contentContainerStyle={{ padding: spacing.md }}>
        {loading ? (
          <ActivityIndicator color={colors.text} />
        ) : messages.length === 0 ? (
          <Text style={styles.empty}>
            Nessun messaggio. {user?.role === "admin" ? "Scrivi all'operaio su questo lavoro." : "Scrivi al titolare su questo lavoro."}
          </Text>
        ) : (
          messages.map((m) => {
            const mine = m.sender_id === user?.id;
            const isEditing = editingId === m.id;
            return (
              <View key={m.id} style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}>
                <Text style={[styles.author, mine ? styles.authorMine : styles.authorOther]}>
                  {mine ? "TU" : m.sender_name.toUpperCase()} · {fmtTime(m.created_at)}
                  {m.edited_at ? " · modificato" : ""}
                </Text>
                {isEditing ? (
                  <View>
                    <TextInput
                      testID={`edit-input-${m.id}`}
                      style={styles.editInput}
                      value={editText}
                      onChangeText={setEditText}
                      multiline
                      autoFocus
                    />
                    <View style={styles.editActions}>
                      <TouchableOpacity testID={`btn-save-edit-${m.id}`} style={styles.editBtn} onPress={saveEdit} disabled={sending}>
                        <Ionicons name="checkmark" size={16} color={colors.active} />
                        <Text style={[styles.editBtnText, { color: colors.active }]}>SALVA</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.editBtn} onPress={() => { setEditingId(null); setEditText(""); }}>
                        <Ionicons name="close" size={16} color={colors.textSecondary} />
                        <Text style={styles.editBtnText}>ANNULLA</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <View>
                    <Text style={[styles.msgText, mine && { color: colors.textInverse }]}>{m.text}</Text>
                    {mine && (
                      <View style={styles.msgActions}>
                        <TouchableOpacity testID={`btn-edit-msg-${m.id}`} onPress={() => startEdit(m)} style={styles.iconTouch}>
                          <Ionicons name="pencil" size={14} color="#A1A1AA" />
                        </TouchableOpacity>
                        <TouchableOpacity testID={`btn-delete-msg-${m.id}`} onPress={() => removeMessage(m)} style={styles.iconTouch}>
                          <Ionicons name="trash-outline" size={14} color="#A1A1AA" />
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                )}
              </View>
            );
          })
        )}
      </ScrollView>

      <View style={styles.inputRow}>
        <TextInput
          testID="message-input"
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Scrivi un messaggio…"
          placeholderTextColor={colors.textSecondary}
          multiline
          editable={!sending}
        />
        <TouchableOpacity
          testID="btn-send-message"
          style={[styles.sendBtn, (!text.trim() || sending) && { opacity: 0.4 }]}
          onPress={submit}
          disabled={!text.trim() || sending}
        >
          {sending ? <ActivityIndicator color={colors.textInverse} size="small" /> : <Ionicons name="send" size={18} color={colors.textInverse} />}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: spacing.lg, marginTop: spacing.md },
  title: { fontSize: 11, letterSpacing: 3, fontWeight: "800", color: colors.textSecondary, marginBottom: spacing.sm },
  box: { borderWidth: 1, borderColor: colors.border, maxHeight: 260, minHeight: 80 },
  empty: { color: colors.textSecondary, fontStyle: "italic", fontSize: 13, textAlign: "center", paddingVertical: spacing.sm },
  bubble: { padding: 10, marginBottom: 6, maxWidth: "88%" },
  bubbleMine: { backgroundColor: colors.text, alignSelf: "flex-end" },
  bubbleOther: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: colors.border, alignSelf: "flex-start" },
  author: { fontSize: 9, letterSpacing: 1.5, fontWeight: "900", marginBottom: 3 },
  authorMine: { color: "#A1A1AA" },
  authorOther: { color: colors.primary },
  msgText: { fontSize: 14, color: colors.text, lineHeight: 19 },
  msgActions: { flexDirection: "row", gap: 4, marginTop: 6, justifyContent: "flex-end" },
  iconTouch: { padding: 4 },
  editInput: {
    borderWidth: 1, borderColor: "#A1A1AA", backgroundColor: colors.bg, color: colors.text,
    paddingHorizontal: 8, paddingVertical: 6, fontSize: 14, minHeight: 40,
  },
  editActions: { flexDirection: "row", gap: 12, marginTop: 6, justifyContent: "flex-end" },
  editBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  editBtnText: { fontSize: 10, fontWeight: "800", letterSpacing: 1, color: colors.textSecondary },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8, marginTop: spacing.sm },
  input: {
    flex: 1, borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, minHeight: 44, maxHeight: 90, color: colors.text,
  },
  sendBtn: { width: 44, height: 44, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" },
});
