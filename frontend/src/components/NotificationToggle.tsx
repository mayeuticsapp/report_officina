import { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { enablePush, pushPermission, resubscribeIfGranted } from "@/src/utils/notifications";
import { showAlert } from "@/src/utils/dialog";
import { colors, spacing } from "@/src/theme";

export function NotificationToggle() {
  const [state, setState] = useState<"granted" | "denied" | "default" | "unsupported">("default");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setState(pushPermission());
    resubscribeIfGranted();
  }, []);

  if (Platform.OS !== "web") return null;

  const activate = async () => {
    setBusy(true);
    const res = await enablePush();
    setBusy(false);
    if (res === "ok") {
      setState("granted");
      showAlert("Notifiche attive", "Riceverai una notifica quando arriva un messaggio.");
    } else if (res === "denied") {
      setState("denied");
      showAlert("Permesso negato", "Hai bloccato le notifiche. Riattivale dalle impostazioni del browser (icona lucchetto vicino all'indirizzo).");
    } else if (res === "unsupported") {
      setState("unsupported");
      showAlert("Non supportato", "Questo browser non supporta le notifiche. Su iPhone: prima 'Aggiungi a schermata Home', poi riprova da lì.");
    } else {
      showAlert("Errore", "Attivazione non riuscita, riprova.");
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.label}>NOTIFICHE MESSAGGI</Text>
      {state === "granted" ? (
        <View style={styles.row}>
          <Ionicons name="notifications" size={18} color={colors.active} />
          <Text style={styles.activeText}>Attive su questo dispositivo</Text>
        </View>
      ) : state === "unsupported" ? (
        <Text style={styles.hint}>
          Browser non supportato. Su iPhone: Condividi → "Aggiungi a schermata Home", poi apri l'app da lì e riprova.
        </Text>
      ) : (
        <>
          <TouchableOpacity testID="btn-enable-push" style={styles.btn} onPress={activate} disabled={busy}>
            {busy ? <ActivityIndicator color={colors.textInverse} size="small" /> : (
              <>
                <Ionicons name="notifications-outline" size={18} color={colors.textInverse} />
                <Text style={styles.btnText}>ATTIVA NOTIFICHE</Text>
              </>
            )}
          </TouchableOpacity>
          <Text style={styles.hint}>
            Ricevi un avviso sul telefono quando arriva un messaggio, anche con l'app chiusa (Android).
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginTop: spacing.md },
  label: { fontSize: 11, letterSpacing: 2.5, color: colors.textSecondary, fontWeight: "700", marginBottom: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  activeText: { fontSize: 14, fontWeight: "700", color: colors.active },
  btn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: colors.text, paddingVertical: 14,
  },
  btnText: { color: colors.textInverse, fontSize: 12, letterSpacing: 2, fontWeight: "800" },
  hint: { fontSize: 12, color: colors.textSecondary, marginTop: spacing.sm, lineHeight: 17 },
});
