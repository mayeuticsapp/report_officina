import { Alert, Platform } from "react-native";

/**
 * Popup compatibili web + nativo.
 * Alert.alert di React Native NON è implementato su web (react-native-web):
 * i pulsanti non appaiono e i messaggi non vengono mostrati affatto.
 */

/** Messaggio informativo (ok-only). */
export function showAlert(title: string, message?: string) {
  if (Platform.OS === "web") {
    window.alert(message ? `${title}\n\n${message}` : title);
  } else {
    Alert.alert(title, message);
  }
}

/** Conferma sì/no. Risolve true se l'utente conferma. */
export function confirmDialog(
  title: string,
  message?: string,
  confirmText: string = "OK"
): Promise<boolean> {
  if (Platform.OS === "web") {
    return Promise.resolve(window.confirm(message ? `${title}\n\n${message}` : title));
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: "Annulla", style: "cancel", onPress: () => resolve(false) },
      { text: confirmText, style: "destructive", onPress: () => resolve(true) },
    ]);
  });
}
