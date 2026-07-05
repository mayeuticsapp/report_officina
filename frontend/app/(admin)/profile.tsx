import { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/src/auth/AuthContext";
import { colors, spacing } from "@/src/theme";

export default function AdminProfile() {
  const { user, logout } = useAuth();
  const [confirming, setConfirming] = useState(false);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerLabel}>PROFILO</Text>
        <Text style={styles.title}>AMMINISTRATORE</Text>
      </View>
      <View style={styles.body}>
        <View style={styles.card}>
          <Text style={styles.label}>NOME</Text>
          <Text style={styles.value}>{user?.full_name}</Text>
          <Text style={[styles.label, { marginTop: spacing.md }]}>USERNAME</Text>
          <Text style={styles.value}>{user?.username}</Text>
          <Text style={[styles.label, { marginTop: spacing.md }]}>RUOLO</Text>
          <Text style={styles.value}>Titolare / Amministratore</Text>
        </View>

        {!confirming ? (
          <TouchableOpacity testID="logout-button" style={styles.logoutBtn} onPress={() => setConfirming(true)}>
            <Text style={styles.logoutText}>ESCI</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.confirmBox}>
            <Text style={styles.confirmText}>Confermi il logout?</Text>
            <View style={styles.confirmRow}>
              <TouchableOpacity style={[styles.confirmBtn, styles.confirmCancel]} onPress={() => setConfirming(false)}>
                <Text style={styles.confirmCancelText}>ANNULLA</Text>
              </TouchableOpacity>
              <TouchableOpacity testID="logout-confirm-button" style={[styles.confirmBtn, styles.confirmYes]} onPress={logout}>
                <Text style={styles.confirmYesText}>ESCI</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerLabel: { fontSize: 11, letterSpacing: 3, color: colors.textSecondary, fontWeight: "700" },
  title: { fontSize: 26, fontWeight: "900", color: colors.text, letterSpacing: -0.5 },
  body: { padding: spacing.lg },
  card: { borderWidth: 1, borderColor: colors.border, padding: spacing.lg },
  label: { fontSize: 11, letterSpacing: 3, color: colors.textSecondary, fontWeight: "700" },
  value: { fontSize: 18, color: colors.text, marginTop: 4, fontWeight: "600" },
  logoutBtn: { marginTop: spacing.lg, borderWidth: 2, borderColor: colors.stopped, paddingVertical: 16, alignItems: "center" },
  logoutText: { color: colors.stopped, fontWeight: "900", letterSpacing: 3, fontSize: 13 },
  confirmBox: { marginTop: spacing.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.stopped, backgroundColor: "#FEF2F2" },
  confirmText: { fontSize: 15, color: colors.text, marginBottom: spacing.md, fontWeight: "600" },
  confirmRow: { flexDirection: "row", gap: spacing.sm },
  confirmBtn: { flex: 1, paddingVertical: 14, alignItems: "center" },
  confirmCancel: { borderWidth: 1, borderColor: colors.border },
  confirmYes: { backgroundColor: colors.stopped },
  confirmCancelText: { fontWeight: "800", letterSpacing: 2, fontSize: 12, color: colors.text },
  confirmYesText: { fontWeight: "900", letterSpacing: 2, fontSize: 12, color: colors.textInverse },
});
