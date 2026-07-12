import { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api/client";
import { showAlert } from "@/src/utils/dialog";
import { colors, spacing } from "@/src/theme";

export function ChangePassword() {
  const [open, setOpen] = useState(false);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!oldPw || !newPw) {
      showAlert("Campi obbligatori", "Inserisci la password attuale e quella nuova.");
      return;
    }
    if (newPw.length < 6) {
      showAlert("Password corta", "La nuova password deve avere almeno 6 caratteri.");
      return;
    }
    if (newPw !== newPw2) {
      showAlert("Non coincidono", "Le due nuove password non sono uguali.");
      return;
    }
    setBusy(true);
    try {
      await api("/auth/change-password", { method: "POST", body: { old_password: oldPw, new_password: newPw } });
      setOldPw(""); setNewPw(""); setNewPw2(""); setOpen(false);
      showAlert("Fatto", "Password cambiata. Usala dal prossimo accesso.");
    } catch (e: any) {
      showAlert("Errore", e?.message || "Impossibile cambiare la password");
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <TouchableOpacity testID="btn-open-change-password" style={styles.openBtn} onPress={() => setOpen(true)}>
        <Ionicons name="key-outline" size={18} color={colors.text} />
        <Text style={styles.openBtnText}>CAMBIA PASSWORD</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.box}>
      <Text style={styles.title}>CAMBIA PASSWORD</Text>
      <Text style={styles.label}>PASSWORD ATTUALE</Text>
      <TextInput testID="input-old-password" style={styles.input} value={oldPw} onChangeText={setOldPw} secureTextEntry autoCapitalize="none" />
      <Text style={[styles.label, { marginTop: spacing.sm }]}>NUOVA PASSWORD (min 6 caratteri)</Text>
      <TextInput testID="input-new-password" style={styles.input} value={newPw} onChangeText={setNewPw} secureTextEntry autoCapitalize="none" />
      <Text style={[styles.label, { marginTop: spacing.sm }]}>RIPETI NUOVA PASSWORD</Text>
      <TextInput testID="input-new-password2" style={styles.input} value={newPw2} onChangeText={setNewPw2} secureTextEntry autoCapitalize="none" />
      <View style={styles.row}>
        <TouchableOpacity style={[styles.btn, styles.btnCancel]} onPress={() => setOpen(false)} disabled={busy}>
          <Text style={styles.btnCancelText}>ANNULLA</Text>
        </TouchableOpacity>
        <TouchableOpacity testID="btn-save-password" style={[styles.btn, styles.btnSave, busy && { opacity: 0.6 }]} onPress={submit} disabled={busy}>
          {busy ? <ActivityIndicator color={colors.textInverse} size="small" /> : <Text style={styles.btnSaveText}>SALVA</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  openBtn: {
    marginTop: spacing.lg, borderWidth: 1, borderColor: colors.borderStrong, paddingVertical: 14,
    alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8,
  },
  openBtnText: { color: colors.text, fontWeight: "800", letterSpacing: 2, fontSize: 12 },
  box: { marginTop: spacing.lg, borderWidth: 1, borderColor: colors.borderStrong, padding: spacing.lg },
  title: { fontSize: 12, letterSpacing: 3, fontWeight: "900", color: colors.text, marginBottom: spacing.md },
  label: { fontSize: 10, letterSpacing: 2, color: colors.textSecondary, fontWeight: "700", marginBottom: 4 },
  input: {
    borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 15, minHeight: 44, color: colors.text,
  },
  row: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  btn: { flex: 1, paddingVertical: 14, alignItems: "center" },
  btnCancel: { borderWidth: 1, borderColor: colors.border },
  btnCancelText: { fontWeight: "800", letterSpacing: 2, fontSize: 12, color: colors.text },
  btnSave: { backgroundColor: colors.text },
  btnSaveText: { fontWeight: "900", letterSpacing: 2, fontSize: 12, color: colors.textInverse },
});
