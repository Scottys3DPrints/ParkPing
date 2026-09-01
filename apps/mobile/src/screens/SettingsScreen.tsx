import { useState } from 'react';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Alert, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { ApiError, api, type User } from '../api';
import { styles, theme } from '../theme';

export function SettingsScreen({
  user,
  onUserChanged,
  onSignedOut,
}: {
  user: User;
  onUserChanged: (user: User) => void;
  onSignedOut: () => void;
}): JSX.Element {
  const [prefs, setPrefs] = useState(user.notificationPreferences);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function savePrefs(next: User['notificationPreferences']): Promise<void> {
    setPrefs(next);
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateNotificationPreferences(next);
      onUserChanged({ ...user, notificationPreferences: next });
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Fetches the export with the signed-in session and hands it to the share
   * sheet. Opening the URL in a browser would not work — the endpoint needs an
   * Authorization header, and the browser has no access to the app's tokens.
   */
  async function exportData(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const data = await api.exportData();
      const path = `${FileSystem.cacheDirectory}parkping-export.json`;
      await FileSystem.writeAsStringAsync(path, JSON.stringify(data, null, 2));
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(path, { mimeType: 'application/json', UTI: 'public.json' });
      } else {
        Alert.alert('Export ready', `Saved to ${path}`);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not prepare your export.');
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete(): void {
    Alert.alert(
      'Delete your account?',
      'Your contact details, vehicles and devices are erased immediately. Alerts you sent or received are kept without any link to you. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete everything',
          style: 'destructive',
          onPress: () => {
            void api
              .deleteAccount()
              .then(() => onSignedOut())
              .catch(() => setError('Could not delete the account. Please contact support.'));
          },
        },
      ],
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Settings</Text>

      {error && (
        <View style={styles.error}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
      {saved && !busy && (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>Saved.</Text>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.label}>Signed in as</Text>
        <Text style={styles.h2}>{user.contactMasked}</Text>
        <Text style={styles.subtitle}>
          Nobody who reports a vehicle ever sees this, and you never see theirs.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.h2}>Quiet hours</Text>
        <Text style={styles.subtitle}>
          Holds back non-urgent notices like "lights left on" until the morning. Anything that means
          someone is blocked always comes through immediately.
        </Text>
        <View style={[styles.row, { justifyContent: 'space-between' }]}>
          <Text style={styles.subtitle}>Enabled</Text>
          <Switch
            value={prefs.quietHoursEnabled}
            disabled={busy}
            onValueChange={(value) => void savePrefs({ ...prefs, quietHoursEnabled: value })}
            trackColor={{ true: theme.accent, false: theme.border }}
          />
        </View>
        {prefs.quietHoursEnabled && (
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>From</Text>
              <TextInput
                style={styles.input}
                value={prefs.quietHoursStart}
                onChangeText={(value) => setPrefs({ ...prefs, quietHoursStart: value })}
                onBlur={() => void savePrefs(prefs)}
                placeholder="22:00"
                placeholderTextColor={theme.textDim}
                maxLength={5}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Until</Text>
              <TextInput
                style={styles.input}
                value={prefs.quietHoursEnd}
                onChangeText={(value) => setPrefs({ ...prefs, quietHoursEnd: value })}
                onBlur={() => void savePrefs(prefs)}
                placeholder="07:00"
                placeholderTextColor={theme.textDim}
                maxLength={5}
              />
            </View>
          </View>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.h2}>Your data</Text>
        <Text style={styles.subtitle}>
          Download everything ParkPing holds about you, or delete the account entirely.
        </Text>
        <Pressable
          onPress={() => void exportData()}
          disabled={busy}
          style={[styles.buttonSecondary, busy && styles.buttonDisabled]}
        >
          <Text style={styles.buttonSecondaryText}>Export my data</Text>
        </Pressable>
        <Pressable onPress={confirmDelete} style={[styles.buttonSecondary, { borderColor: '#5C2B2B' }]}>
          <Text style={[styles.buttonSecondaryText, { color: theme.danger }]}>Delete my account</Text>
        </Pressable>
      </View>

      <Pressable
        onPress={() => {
          void api.signOut().then(onSignedOut);
        }}
        style={styles.buttonSecondary}
      >
        <Text style={styles.buttonSecondaryText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}
