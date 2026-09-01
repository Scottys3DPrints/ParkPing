import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { ApiError, api, type Catalog, type ReceivedAlert, type SentAlert } from '../api';
import { styles, theme } from '../theme';

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function labelFor(catalog: Catalog | null, list: 'categories' | 'responses', id: string | null): string {
  if (!id) return '';
  const found = catalog?.[list].find((entry) => entry.id === id);
  return found?.label.en ?? id.replace(/_/g, ' ');
}

function ReceivedCard({
  alert,
  catalog,
  onChanged,
}: {
  alert: ReceivedAlert;
  catalog: Catalog | null;
  onChanged: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  function confirmBlock(): void {
    Alert.alert(
      'Block this sender?',
      'They will not be able to alert this vehicle again. They are not told that you blocked them.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: () => void act(() => api.blockReporter(alert.id)),
        },
      ],
    );
  }

  function confirmReport(): void {
    Alert.alert('Report this alert', 'What is wrong with it?', [
      { text: 'Cancel', style: 'cancel' },
      ...(catalog?.abuseReasons ?? []).slice(0, 4).map((reason) => ({
        text: reason.label.en,
        onPress: () => void act(() => api.reportAbuse(alert.id, reason.id)),
      })),
    ]);
  }

  return (
    <View style={styles.card}>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Text style={styles.h2}>{labelFor(catalog, 'categories', alert.category)}</Text>
        <Text style={styles.mono}>{relativeTime(alert.createdAt)}</Text>
      </View>

      <Text style={styles.subtitle}>
        About {alert.vehiclePlate}
        {alert.locationLabel ? ` · ${alert.locationLabel}` : ''}
      </Text>

      <View style={styles.wrap}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>Sender {alert.reporterHandle}</Text>
        </View>
        {alert.reporterIsVerifiedOrganization && alert.organizationName && (
          <View style={[styles.badge, { borderColor: '#23503C' }]}>
            <Text style={[styles.badgeText, { color: theme.ok }]}>via {alert.organizationName}</Text>
          </View>
        )}
        {alert.timeframe && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>asked: {alert.timeframe.replace(/_/g, ' ')}</Text>
          </View>
        )}
      </View>

      {error && (
        <View style={styles.error}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {alert.response ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>You replied: {labelFor(catalog, 'responses', alert.response)}</Text>
        </View>
      ) : (
        <>
          <Text style={styles.label}>Reply</Text>
          <View style={styles.wrap}>
            {(catalog?.responses ?? []).map((option) => (
              <Pressable
                key={option.id}
                disabled={busy}
                onPress={() => void act(() => api.respond(alert.id, option.id))}
                style={[styles.chip, busy && styles.buttonDisabled]}
              >
                <Text style={styles.chipText}>{option.label.en}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      <View style={[styles.row, { marginTop: 4 }]}>
        <Pressable onPress={confirmBlock} disabled={busy} style={{ paddingVertical: 6 }}>
          <Text style={[styles.mono, { color: theme.danger }]}>Block sender</Text>
        </Pressable>
        <Pressable onPress={confirmReport} disabled={busy} style={{ paddingVertical: 6 }}>
          <Text style={[styles.mono, { color: theme.warn }]}>Report</Text>
        </Pressable>
      </View>
    </View>
  );
}

function SentCard({ alert, catalog }: { alert: SentAlert; catalog: Catalog | null }): JSX.Element {
  return (
    <View style={styles.card}>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Text style={styles.h2}>{alert.plateEntered}</Text>
        <Text style={styles.mono}>{relativeTime(alert.createdAt)}</Text>
      </View>
      <Text style={styles.subtitle}>{labelFor(catalog, 'categories', alert.category)}</Text>
      {alert.response ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            Driver replied: {labelFor(catalog, 'responses', alert.response)}
          </Text>
        </View>
      ) : (
        // Never "delivered" or "not registered" — the API does not tell us, by design.
        <Text style={styles.mono}>Processed · no reply yet</Text>
      )}
      <Text style={styles.mono}>{alert.reference}</Text>
    </View>
  );
}

export function InboxScreen({
  catalog,
  refreshToken,
  onCountChange,
}: {
  catalog: Catalog | null;
  refreshToken: number;
  onCountChange: (unanswered: number) => void;
}): JSX.Element {
  const [tab, setTab] = useState<'received' | 'sent'>('received');
  const [received, setReceived] = useState<ReceivedAlert[]>([]);
  const [sent, setSent] = useState<SentAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [inbox, outbox] = await Promise.all([api.receivedAlerts(), api.sentAlerts()]);
      setReceived(inbox.alerts);
      setSent(outbox.alerts);
      onCountChange(inbox.alerts.filter((a) => a.response === null).length);
      // Marking as opened powers the funnel between delivery and response.
      await Promise.all(
        inbox.alerts.filter((a) => a.response === null).map((a) => api.markOpened(a.id).catch(() => undefined)),
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load your alerts.');
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const list = tab === 'received' ? received : sent;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={theme.textDim} />}
    >
      <Text style={styles.h1}>Alerts</Text>

      <View style={styles.row}>
        {(['received', 'sent'] as const).map((option) => (
          <Pressable
            key={option}
            onPress={() => setTab(option)}
            style={[styles.chip, tab === option && styles.chipActive]}
          >
            <Text style={[styles.chipText, tab === option && styles.chipTextActive]}>
              {option === 'received' ? 'About my vehicles' : 'I reported'}
            </Text>
          </Pressable>
        ))}
      </View>

      {error && (
        <View style={styles.error}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {loading && list.length === 0 ? (
        <ActivityIndicator color={theme.accent} style={{ marginTop: 40 }} />
      ) : list.length === 0 ? (
        <Text style={styles.empty}>
          {tab === 'received'
            ? 'Nothing about your vehicles. That is the good outcome.'
            : 'You have not reported a vehicle yet.'}
        </Text>
      ) : tab === 'received' ? (
        received.map((alert) => (
          <ReceivedCard key={alert.id} alert={alert} catalog={catalog} onChanged={() => void load()} />
        ))
      ) : (
        sent.map((alert) => <SentCard key={alert.id} alert={alert} catalog={catalog} />)
      )}
    </ScrollView>
  );
}
