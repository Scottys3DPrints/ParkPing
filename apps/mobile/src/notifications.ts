import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { api } from './api';

const INSTALL_KEY = 'parkping.installationId';

/**
 * Foreground behaviour: a ParkPing alert is time-critical by definition, so it
 * is shown even while the app is open rather than silently updating a list.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/** Stable per install, so re-registering replaces the token instead of adding one. */
async function installationId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(INSTALL_KEY);
  if (existing) return existing;
  const generated = `${Platform.OS}-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  await SecureStore.setItemAsync(INSTALL_KEY, generated);
  return generated;
}

export interface PushRegistrationResult {
  ok: boolean;
  reason?: 'not_a_device' | 'permission_denied' | 'no_token' | 'failed';
}

/**
 * Requests notification permission and registers the push token.
 *
 * Failure is returned rather than thrown: a user who declines notifications
 * should still be able to use the app to report a vehicle, they just cannot
 * receive alerts about their own. The Vehicles screen surfaces that trade-off.
 */
export async function registerForPush(): Promise<PushRegistrationResult> {
  if (!Device.isDevice) return { ok: false, reason: 'not_a_device' };

  if (Platform.OS === 'android') {
    // A separate high-importance channel so a blocking incident can bypass
    // the default channel's batching.
    await Notifications.setNotificationChannelAsync('urgent', {
      name: 'Urgent alerts',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#4C9AFF',
    });
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Notifications',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted;
  if (!granted && existing.canAskAgain) {
    const requested = await Notifications.requestPermissionsAsync();
    granted = requested.granted;
  }
  if (!granted) return { ok: false, reason: 'permission_denied' };

  try {
    const token = await Notifications.getExpoPushTokenAsync();
    if (!token.data) return { ok: false, reason: 'no_token' };
    await api.registerDevice({
      token: token.data,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      installationId: await installationId(),
    });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export function addAlertListener(onAlert: () => void): () => void {
  const received = Notifications.addNotificationReceivedListener(() => onAlert());
  const responded = Notifications.addNotificationResponseReceivedListener(() => onAlert());
  return () => {
    received.remove();
    responded.remove();
  };
}
