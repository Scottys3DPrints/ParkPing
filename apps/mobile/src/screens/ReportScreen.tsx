import { useMemo, useState } from 'react';
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
import { ApiError, api, type Catalog } from '../api';
import { styles, theme } from '../theme';

/**
 * The reporter flow: plate, what is wrong, and — only when someone is actually
 * blocked — how urgent it is.
 *
 * The confirmation screen is deliberately vague about the outcome. The API
 * cannot tell us whether the plate was registered, and the copy must not
 * imply that it did, or the app becomes the plate-lookup oracle the API is
 * careful not to be.
 */
export function ReportScreen({ catalog }: { catalog: Catalog | null }): JSX.Element {
  const [plate, setPlate] = useState('');
  const [country, setCountry] = useState('DE');
  const [category, setCategory] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentReference, setSentReference] = useState<string | null>(null);

  const selected = useMemo(
    () => catalog?.categories.find((c) => c.id === category) ?? null,
    [catalog, category],
  );

  const countryExample = catalog?.countries.find((c) => c.code === country)?.example ?? 'M AB 1234';

  async function submit(): Promise<void> {
    if (!category) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.submitAlert({
        plate: plate.trim(),
        country,
        category,
        timeframe: selected?.allowsTimeframe ? timeframe : null,
      });
      setSentReference(result.reference);
      setPlate('');
      setCategory(null);
      setTimeframe(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not send that report.');
    } finally {
      setBusy(false);
    }
  }

  if (sentReference) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.h1}>Report sent</Text>
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            Your report has been processed. If this vehicle is in the ParkPing network, its driver has
            been notified.
          </Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.label}>Reference</Text>
          <Text style={[styles.h2, { fontVariant: ['tabular-nums'] }]}>{sentReference}</Text>
          <Text style={styles.subtitle}>
            Keep this if you need to contact support about this report. You will see a reply here if
            the driver chooses to send one — we cannot tell you anything else about them.
          </Text>
        </View>
        <Pressable onPress={() => setSentReference(null)} style={styles.button}>
          <Text style={styles.buttonText}>Report another vehicle</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.h1}>Reach a driver</Text>
        <Text style={styles.subtitle}>
          Enter the plate and what the problem is. The driver gets a notification; you never see who
          they are, and they never see who you are.
        </Text>

        {error && (
          <View style={styles.error}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.label}>License plate</Text>
          <TextInput
            style={[styles.input, styles.plateInput]}
            value={plate}
            onChangeText={setPlate}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder={countryExample}
            placeholderTextColor={theme.textDim}
            maxLength={24}
          />
          <View style={styles.wrap}>
            {(catalog?.countries ?? [{ code: 'DE', example: '' }]).map((option) => (
              <Pressable
                key={option.code}
                onPress={() => setCountry(option.code)}
                style={[styles.chip, country === option.code && styles.chipActive]}
              >
                <Text style={[styles.chipText, country === option.code && styles.chipTextActive]}>
                  {option.code}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>What is the problem?</Text>
          <View style={{ gap: 8 }}>
            {(catalog?.categories ?? []).map((option) => (
              <Pressable
                key={option.id}
                onPress={() => {
                  setCategory(option.id);
                  if (!option.allowsTimeframe) setTimeframe(null);
                }}
                style={[
                  styles.chip,
                  { alignSelf: 'stretch', alignItems: 'flex-start' },
                  category === option.id && styles.chipActive,
                ]}
              >
                <Text style={[styles.chipText, category === option.id && styles.chipTextActive]}>
                  {option.label.en}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {selected?.allowsTimeframe && (
          <View style={styles.card}>
            <Text style={styles.label}>How urgent is it for you?</Text>
            <View style={styles.wrap}>
              {(catalog?.timeframes ?? []).map((option) => (
                <Pressable
                  key={option.id}
                  onPress={() => setTimeframe(timeframe === option.id ? null : option.id)}
                  style={[styles.chip, timeframe === option.id && styles.chipActive]}
                >
                  <Text style={[styles.chipText, timeframe === option.id && styles.chipTextActive]}>
                    {option.id.replace(/_/g, ' ')}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={[styles.subtitle, { fontSize: 12.5 }]}>
              This is passed on as your request, not as a deadline. ParkPing does not grant deadlines
              and cannot enforce one.
            </Text>
          </View>
        )}

        <Pressable
          onPress={() => void submit()}
          disabled={busy || plate.trim().length < 2 || !category}
          style={[
            styles.button,
            (busy || plate.trim().length < 2 || !category) && styles.buttonDisabled,
          ]}
        >
          {busy ? <ActivityIndicator color="#08121F" /> : <Text style={styles.buttonText}>Send alert</Text>}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
