import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ApiError, api, type Catalog, type User } from '../api';
import { styles, theme } from '../theme';

export function SignInScreen({
  catalog,
  onSignedIn,
}: {
  catalog: Catalog | null;
  onSignedIn: (user: User) => void;
}): JSX.Element {
  const [step, setStep] = useState<'contact' | 'code'>('contact');
  const [channel, setChannel] = useState<'email' | 'phone'>('email');
  const [destination, setDestination] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendCode(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await api.requestCode(channel, destination.trim());
      setDevCode(result.devCode ?? null);
      setStep('code');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not send a code.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const user = await api.verifyCode(
        channel,
        destination.trim(),
        code.trim(),
        catalog?.consentVersion ?? '',
      );
      onSignedIn(user);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not verify that code.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={[styles.content, { flexGrow: 1, justifyContent: 'center' }]}>
        <View style={{ gap: 6, marginBottom: 10 }}>
          <Text style={styles.h1}>ParkPing</Text>
          <Text style={styles.subtitle}>
            The digital doorbell for your car. Reach the driver, not the tow truck.
          </Text>
        </View>

        {error && (
          <View style={styles.error}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {step === 'contact' ? (
          <View style={styles.card}>
            <View style={styles.row}>
              {(['email', 'phone'] as const).map((option) => (
                <Pressable
                  key={option}
                  onPress={() => setChannel(option)}
                  style={[styles.chip, channel === option && styles.chipActive]}
                >
                  <Text style={[styles.chipText, channel === option && styles.chipTextActive]}>
                    {option === 'email' ? 'Email' : 'Phone'}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View>
              <Text style={styles.label}>
                {channel === 'email' ? 'Email address' : 'Mobile number'}
              </Text>
              <TextInput
                style={styles.input}
                value={destination}
                onChangeText={setDestination}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType={channel === 'email' ? 'email-address' : 'phone-pad'}
                placeholder={channel === 'email' ? 'you@example.com' : '+49 151 12345678'}
                placeholderTextColor={theme.textDim}
                textContentType={channel === 'email' ? 'emailAddress' : 'telephoneNumber'}
              />
            </View>

            <Pressable
              onPress={() => void sendCode()}
              disabled={busy || destination.trim().length < 4}
              style={[styles.button, (busy || destination.trim().length < 4) && styles.buttonDisabled]}
            >
              {busy ? (
                <ActivityIndicator color="#08121F" />
              ) : (
                <Text style={styles.buttonText}>Send sign-in code</Text>
              )}
            </Pressable>

            <Text style={[styles.subtitle, { fontSize: 12.5 }]}>
              We use your {channel === 'email' ? 'email' : 'number'} only to verify your account and
              deliver alerts about your own vehicle. It is never shown to anyone who reports a vehicle.
            </Text>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.label}>Enter the 6-digit code sent to {destination}</Text>
            <TextInput
              style={[styles.input, styles.plateInput]}
              value={code}
              onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad"
              autoFocus
              maxLength={6}
              placeholder="000000"
              placeholderTextColor={theme.textDim}
              textContentType="oneTimeCode"
            />

            <Pressable
              onPress={() => void verify()}
              disabled={busy || code.length !== 6}
              style={[styles.button, (busy || code.length !== 6) && styles.buttonDisabled]}
            >
              {busy ? <ActivityIndicator color="#08121F" /> : <Text style={styles.buttonText}>Sign in</Text>}
            </Pressable>

            <Pressable onPress={() => setStep('contact')} style={styles.buttonSecondary}>
              <Text style={styles.buttonSecondaryText}>Use a different address</Text>
            </Pressable>

            {devCode && (
              <Text style={styles.mono}>Development build — your code is {devCode}</Text>
            )}
          </View>
        )}

        {catalog && (
          <Text style={[styles.subtitle, { fontSize: 12, textAlign: 'center' }]}>
            By signing in you accept the terms and privacy notice, version {catalog.consentVersion}.
          </Text>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
