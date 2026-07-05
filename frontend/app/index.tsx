import { useEffect, useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView,
  Platform, ScrollView, ActivityIndicator, Keyboard,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useAuth } from "@/src/auth/AuthContext";
import { colors, spacing } from "@/src/theme";

export default function LoginScreen() {
  const { user, login, loading } = useAuth();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user) {
      router.replace(user.role === "admin" ? "/(admin)/dashboard" : "/(worker)/home");
    }
  }, [user]);

  const onSubmit = async () => {
    Keyboard.dismiss();
    setError(null);
    if (!username.trim() || !password) {
      setError("Inserisci username e password");
      return;
    }
    setSubmitting(true);
    try {
      await login(username.trim(), password);
    } catch (e: any) {
      setError(e?.message || "Errore login");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.text} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.logoBlock}>
            <Text style={styles.brandLabel}>OFFICINA</Text>
            <Text style={styles.brandTitle}>Gestione Lavori</Text>
            <View style={styles.brandBar} />
          </View>

          <View style={styles.form}>
            <Text style={styles.label}>USERNAME</Text>
            <TextInput
              testID="login-username-input"
              style={styles.input}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="es. mario.rossi"
              placeholderTextColor={colors.textSecondary}
            />

            <Text style={[styles.label, { marginTop: spacing.md }]}>PASSWORD</Text>
            <TextInput
              testID="login-password-input"
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder="••••••••"
              placeholderTextColor={colors.textSecondary}
            />

            {error ? (
              <View testID="login-error" style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <TouchableOpacity
              testID="login-submit-button"
              onPress={onSubmit}
              disabled={submitting}
              style={[styles.button, submitting && { opacity: 0.6 }]}
              activeOpacity={0.8}
            >
              {submitting ? (
                <ActivityIndicator color={colors.textInverse} />
              ) : (
                <Text style={styles.buttonText}>ACCEDI</Text>
              )}
            </TouchableOpacity>

            <Text style={styles.hint}>
              Account gestiti dal titolare. Chiedi le credenziali all&apos;amministratore.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  container: { flexGrow: 1, padding: spacing.lg, justifyContent: "center" },
  logoBlock: { marginBottom: spacing.xl },
  brandLabel: {
    fontSize: 12, letterSpacing: 4, fontWeight: "700", color: colors.textSecondary,
  },
  brandTitle: {
    fontSize: 40, fontWeight: "900", color: colors.text, marginTop: spacing.xs, letterSpacing: -1,
  },
  brandBar: {
    height: 4, width: 48, backgroundColor: colors.text, marginTop: spacing.md,
  },
  form: { borderWidth: 1, borderColor: colors.border, padding: spacing.lg },
  label: {
    fontSize: 11, letterSpacing: 3, fontWeight: "700", color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  input: {
    borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: spacing.md,
    paddingVertical: 14, fontSize: 16, color: colors.text, backgroundColor: colors.bg,
    minHeight: 52,
  },
  button: {
    backgroundColor: colors.text, paddingVertical: 18, marginTop: spacing.lg,
    alignItems: "center", justifyContent: "center", minHeight: 56,
  },
  buttonText: {
    color: colors.textInverse, fontSize: 14, fontWeight: "900", letterSpacing: 3,
  },
  errorBox: {
    marginTop: spacing.md, padding: spacing.md, borderWidth: 1, borderColor: colors.stopped,
    backgroundColor: "#FEF2F2",
  },
  errorText: { color: colors.stopped, fontSize: 14, fontWeight: "600" },
  hint: {
    marginTop: spacing.lg, fontSize: 12, color: colors.textSecondary, textAlign: "center",
  },
});
