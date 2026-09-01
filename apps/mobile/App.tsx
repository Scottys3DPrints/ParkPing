import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { api, loadTokens, type Catalog, type User } from './src/api';
import { addAlertListener, registerForPush } from './src/notifications';
import { InboxScreen } from './src/screens/InboxScreen';
import { ReportScreen } from './src/screens/ReportScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SignInScreen } from './src/screens/SignInScreen';
import { VehiclesScreen } from './src/screens/VehiclesScreen';
import { styles, theme } from './src/theme';

type Tab = 'report' | 'inbox' | 'vehicles' | 'settings';

const TABS: Array<{ id: Tab; label: string; glyph: string }> = [
  { id: 'report', label: 'Report', glyph: '🔔' },
  { id: 'inbox', label: 'Alerts', glyph: '📬' },
  { id: 'vehicles', label: 'Vehicles', glyph: '🚗' },
  { id: 'settings', label: 'Settings', glyph: '⚙️' },
];

export default function App(): JSX.Element {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [tab, setTab] = useState<Tab>('report');
  const [unanswered, setUnanswered] = useState(0);
  const [pushEnabled, setPushEnabled] = useState(false);
  /** Bumped to make the inbox reload — on push arrival, or on foreground. */
  const [refreshToken, setRefreshToken] = useState(0);

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), []);

  useEffect(() => {
    void (async () => {
      // The catalog is public and drives every selectable value in the UI.
      await api
        .catalog()
        .then(setCatalog)
        .catch(() => undefined);

      if (await loadTokens()) {
        await api
          .me()
          .then((result) => setUser(result.user))
          .catch(() => undefined);
      }
      setBooting(false);
    })();
  }, []);

  // Register for push once there is an account to attach the token to.
  useEffect(() => {
    if (!user) return;
    void registerForPush().then((result) => setPushEnabled(result.ok));
  }, [user]);

  useEffect(() => {
    if (!user) return undefined;
    return addAlertListener(refresh);
  }, [user, refresh]);

  // A user who taps the notification lands in a foregrounded app; reload so the
  // alert they were told about is actually on screen.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  if (booting) {
    return (
      <SafeAreaProvider>
        <View style={[styles.screen, { alignItems: 'center', justifyContent: 'center' }]}>
          <ActivityIndicator color={theme.accent} size="large" />
        </View>
      </SafeAreaProvider>
    );
  }

  if (!user) {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <SafeAreaView style={styles.screen}>
          <SignInScreen
            catalog={catalog}
            onSignedIn={(signedIn) => {
              setUser(signedIn);
              setTab('vehicles');
            }}
          />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
        <View style={{ flex: 1 }}>
          {tab === 'report' && <ReportScreen catalog={catalog} />}
          {tab === 'inbox' && (
            <InboxScreen catalog={catalog} refreshToken={refreshToken} onCountChange={setUnanswered} />
          )}
          {tab === 'vehicles' && <VehiclesScreen catalog={catalog} pushEnabled={pushEnabled} />}
          {tab === 'settings' && (
            <SettingsScreen
              user={user}
              onUserChanged={setUser}
              onSignedOut={() => {
                setUser(null);
                setTab('report');
              }}
            />
          )}
        </View>
      </SafeAreaView>

      <SafeAreaView style={{ backgroundColor: theme.surface }} edges={['bottom', 'left', 'right']}>
        <View style={styles.tabBar}>
          {TABS.map((item) => (
            <Pressable key={item.id} onPress={() => setTab(item.id)} style={styles.tab}>
              <Text style={{ fontSize: 19, opacity: tab === item.id ? 1 : 0.5 }}>{item.glyph}</Text>
              <Text style={[styles.tabLabel, tab === item.id && styles.tabLabelActive]}>{item.label}</Text>
              {item.id === 'inbox' && unanswered > 0 && (
                <View style={styles.tabDot}>
                  <Text style={styles.tabDotText}>{unanswered > 9 ? '9+' : unanswered}</Text>
                </View>
              )}
            </Pressable>
          ))}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
