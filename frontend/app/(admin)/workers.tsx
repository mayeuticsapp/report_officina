import { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal, TextInput, ActivityIndicator,
  KeyboardAvoidingView, Platform, Alert, RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { api, User } from "@/src/api/client";
import { colors, spacing } from "@/src/theme";

export default function WorkersAdmin() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [form, setForm] = useState({ username: "", full_name: "", password: "", role: "worker" as "worker" | "admin" });
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api<User[]>("/users");
      setUsers(list);
    } catch (e: any) { Alert.alert("Errore", e.message); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openNew = () => {
    setEditing(null);
    setForm({ username: "", full_name: "", password: "", role: "worker" });
    setModalOpen(true);
  };
  const openEdit = (u: User) => {
    setEditing(u);
    setForm({ username: u.username, full_name: u.full_name, password: "", role: u.role as any });
    setModalOpen(true);
  };

  const save = async () => {
    if (!form.full_name.trim() || (!editing && (!form.username.trim() || !form.password))) {
      Alert.alert("Campi obbligatori", "Nome, username e password sono richiesti");
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        await api(`/users/${editing.id}`, {
          method: "PUT",
          body: {
            full_name: form.full_name,
            role: form.role,
            ...(form.password ? { password: form.password } : {}),
          },
        });
      } else {
        await api("/users", {
          method: "POST",
          body: { username: form.username.trim(), full_name: form.full_name, password: form.password, role: form.role },
        });
      }
      setModalOpen(false);
      await load();
    } catch (e: any) { Alert.alert("Errore", e.message); }
    finally { setSubmitting(false); }
  };

  const remove = (u: User) => {
    Alert.alert("Elimina utente", `Eliminare ${u.full_name}?`, [
      { text: "Annulla", style: "cancel" },
      {
        text: "Elimina", style: "destructive", onPress: async () => {
          try { await api(`/users/${u.id}`, { method: "DELETE" }); await load(); }
          catch (e: any) { Alert.alert("Errore", e.message); }
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerLabel}>GESTIONE</Text>
          <Text style={styles.title}>OPERAI</Text>
        </View>
        <TouchableOpacity testID="btn-add-user" style={styles.addBtn} onPress={openNew}>
          <Ionicons name="add" size={22} color={colors.textInverse} />
          <Text style={styles.addBtnText}>NUOVO</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.text} /></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: spacing.lg }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        >
          {users.map((u) => (
            <View key={u.id} testID={`user-row-${u.id}`} style={styles.card}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{u.full_name}</Text>
                <Text style={styles.meta}>@{u.username} · {u.role === "admin" ? "Amministratore" : "Operaio"}</Text>
              </View>
              <TouchableOpacity testID={`btn-edit-${u.id}`} style={styles.iconBtn} onPress={() => openEdit(u)}>
                <Ionicons name="create-outline" size={20} color={colors.text} />
              </TouchableOpacity>
              <TouchableOpacity testID={`btn-delete-${u.id}`} style={[styles.iconBtn, { borderColor: colors.stopped }]} onPress={() => remove(u)}>
                <Ionicons name="trash-outline" size={20} color={colors.stopped} />
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}

      <Modal visible={modalOpen} transparent animationType="slide" onRequestClose={() => setModalOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.mBackdrop}>
          <View style={styles.mSheet}>
            <View style={styles.mHeader}>
              <Text style={styles.mTitle}>{editing ? "MODIFICA UTENTE" : "NUOVO UTENTE"}</Text>
              <TouchableOpacity onPress={() => setModalOpen(false)}><Ionicons name="close" size={26} color={colors.text} /></TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ padding: spacing.lg }} keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>NOME COMPLETO</Text>
              <TextInput testID="input-fullname" style={styles.input} value={form.full_name} onChangeText={(v) => setForm({ ...form, full_name: v })} />

              <Text style={[styles.label, { marginTop: spacing.md }]}>USERNAME</Text>
              <TextInput
                testID="input-username" style={[styles.input, editing && { opacity: 0.5 }]}
                value={form.username} onChangeText={(v) => setForm({ ...form, username: v })}
                autoCapitalize="none" autoCorrect={false} editable={!editing}
              />

              <Text style={[styles.label, { marginTop: spacing.md }]}>PASSWORD {editing ? "(lascia vuoto per non cambiare)" : ""}</Text>
              <TextInput testID="input-password" style={styles.input} value={form.password} onChangeText={(v) => setForm({ ...form, password: v })} secureTextEntry />

              <Text style={[styles.label, { marginTop: spacing.md }]}>RUOLO</Text>
              <View style={styles.rolesRow}>
                {(["worker", "admin"] as const).map((r) => (
                  <TouchableOpacity
                    key={r} testID={`role-${r}`}
                    style={[styles.roleBtn, form.role === r && styles.roleBtnActive]}
                    onPress={() => setForm({ ...form, role: r })}
                  >
                    <Text style={[styles.roleText, form.role === r && styles.roleTextActive]}>
                      {r === "worker" ? "OPERAIO" : "AMMINISTRATORE"}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
            <View style={{ padding: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border }}>
              <TouchableOpacity testID="btn-save-user" style={[styles.saveBtn, submitting && { opacity: 0.6 }]} disabled={submitting} onPress={save}>
                {submitting ? <ActivityIndicator color={colors.textInverse} /> : <Text style={styles.saveText}>SALVA</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border,
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
  },
  headerLabel: { fontSize: 11, letterSpacing: 3, color: colors.textSecondary, fontWeight: "700" },
  title: { fontSize: 26, fontWeight: "900", color: colors.text, letterSpacing: -0.5 },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.text, paddingHorizontal: 14, paddingVertical: 12 },
  addBtnText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 2, fontSize: 12 },
  card: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: 8, gap: 8 },
  name: { fontSize: 15, fontWeight: "800", color: colors.text },
  meta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border },
  mBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  mSheet: { backgroundColor: colors.bg, borderTopWidth: 2, borderTopColor: colors.borderStrong, maxHeight: "90%" },
  mHeader: { padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  mTitle: { fontSize: 16, fontWeight: "900", letterSpacing: 2 },
  label: { fontSize: 11, letterSpacing: 2.5, color: colors.textSecondary, fontWeight: "700" },
  input: { borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: 12, paddingVertical: 12, fontSize: 15, marginTop: 6, minHeight: 48 },
  rolesRow: { flexDirection: "row", gap: 8, marginTop: 6 },
  roleBtn: { flex: 1, paddingVertical: 14, borderWidth: 1, borderColor: colors.border, alignItems: "center" },
  roleBtnActive: { backgroundColor: colors.text, borderColor: colors.text },
  roleText: { fontSize: 11, fontWeight: "900", letterSpacing: 2, color: colors.text },
  roleTextActive: { color: colors.textInverse },
  saveBtn: { backgroundColor: colors.text, paddingVertical: 18, alignItems: "center" },
  saveText: { color: colors.textInverse, fontWeight: "900", letterSpacing: 3, fontSize: 14 },
});
