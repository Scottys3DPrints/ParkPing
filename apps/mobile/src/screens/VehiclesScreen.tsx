import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ApiError, api, type Catalog, type Vehicle } from '../api';
import { styles, theme } from '../theme';

const STATUS_COPY: Record<Vehicle['status'], { label: string; color: string; note: string | null }> = {
  active: { label: 'receiving alerts', color: '#3ECF8E', note: null },
  pending: {
    label: 'waiting for review',
    color: '#F5A623',
    note: 'Another account registered this plate first. We are reviewing both claims; until then, alerts go to them.',
  },
  suspended: {
    label: 'paused',
    color: '#FF6B6B',
    note: 'Routing to this vehicle is paused. Contact support if you believe this is wrong.',
  },
  removed: { label: 'removed', color: '#98A4B3', note: null },
};

export function VehiclesScreen({
  catalog,
  pushEnabled,
}: {
  catalog: Catalog | null;
  pushEnabled: boolean;
}): JSX.Element {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [plate, setPlate] = useState('');
  const [country, setCountry] = useState('DE');
  const [label, setLabel] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.vehicles();
      setVehicles(result.vehicles);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load your vehicles.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.addVehicle({
        plate: plate.trim(),
        country,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}),
      });
      setNotice(result.notice);
      setPlate('');
      setLabel('');
      setInviteCode('');
      setAdding(false);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not add that vehicle.');
    } finally {
      setBusy(false);
    }
  }

  function confirmRemove(vehicle: Vehicle): void {
    Alert.alert(
      'Remove this vehicle?',
      `${vehicle.plate} will stop receiving alerts immediately, and the plate is released for anyone who registers it later.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void api
              .removeVehicle(vehicle.id)
              .then(load)
              .catch(() => setError('Could not remove that vehicle.'));
          },
        },
      ],
    );
  }

  const countryExample = catalog?.countries.find((c) => c.code === country)?.example ?? 'M AB 1234';

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={theme.textDim} />
        }
      >
        <Text style={styles.h1}>My vehicles</Text>
        <Text style={styles.subtitle}>
          Registering a plate is what lets someone reach you. It does not publish anything — nobody can
          look up who a plate belongs to.
        </Text>

        {!pushEnabled && vehicles.length > 0 && (
          <View style={[styles.error, { borderColor: '#5C4A2B', backgroundColor: '#241E16' }]}>
            <Text style={[styles.errorText, { color: theme.warn }]}>
              Notifications are off, so you will not hear about your vehicle. Enable them in system
              settings.
            </Text>
          </View>
        )}

        {error && (
          <View style={styles.error}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
        {notice && (
          <View style={[styles.error, { borderColor: '#5C4A2B', backgroundColor: '#241E16' }]}>
            <Text style={[styles.errorText, { color: theme.warn }]}>{notice}</Text>
          </View>
        )}

        {loading && vehicles.length === 0 ? (
          <ActivityIndicator color={theme.accent} style={{ marginTop: 30 }} />
        ) : (
          vehicles.map((vehicle) => {
            const status = STATUS_COPY[vehicle.status];
            return (
              <View key={vehicle.id} style={styles.card}>
                <View style={[styles.row, { justifyContent: 'space-between' }]}>
                  <Text style={styles.h2}>{vehicle.plate}</Text>
                  <View style={[styles.badge, { borderColor: status.color }]}>
                    <Text style={[styles.badgeText, { color: status.color }]}>{status.label}</Text>
                  </View>
                </View>
                {vehicle.label && <Text style={styles.subtitle}>{vehicle.label}</Text>}
                {vehicle.organizationName && (
                  <Text style={styles.mono}>Verified through {vehicle.organizationName}</Text>
                )}
                {status.note && <Text style={styles.subtitle}>{status.note}</Text>}
                <Pressable onPress={() => confirmRemove(vehicle)} style={{ paddingVertical: 6 }}>
                  <Text style={[styles.mono, { color: theme.danger }]}>Remove vehicle</Text>
                </Pressable>
              </View>
            );
          })
        )}

        {adding ? (
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

            <Text style={styles.label}>Name (optional)</Text>
            <TextInput
              style={styles.input}
              value={label}
              onChangeText={setLabel}
              placeholder="Family car"
              placeholderTextColor={theme.textDim}
              maxLength={40}
            />

            <Text style={styles.label}>Invite code (optional)</Text>
            <TextInput
              style={styles.input}
              value={inviteCode}
              onChangeText={(value) => setInviteCode(value.toUpperCase())}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="From your employer or property manager"
              placeholderTextColor={theme.textDim}
              maxLength={32}
            />

            <Pressable
              onPress={() => void add()}
              disabled={busy || plate.trim().length < 2}
              style={[styles.button, (busy || plate.trim().length < 2) && styles.buttonDisabled]}
            >
              {busy ? <ActivityIndicator color="#08121F" /> : <Text style={styles.buttonText}>Add vehicle</Text>}
            </Pressable>
            <Pressable onPress={() => setAdding(false)} style={styles.buttonSecondary}>
              <Text style={styles.buttonSecondaryText}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable onPress={() => setAdding(true)} style={styles.button}>
            <Text style={styles.buttonText}>Add a vehicle</Text>
          </Pressable>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
