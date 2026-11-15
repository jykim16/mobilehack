import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation, useQuery } from 'convex/react';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PillButton } from '@/components/pill-button';
import { Radius, Spacing, Type, useColors, useThemedStyles, type Palette } from '@/constants/theme';
import { api, mcpUrl } from '@/data/convex-api';
import { errorMessage } from '@/data/shop-store';
import { formatShortDate } from '@/lib/format';
import { convexConfigured, useSession } from '@/lib/session';

export default function ConnectAgentScreen() {
  const Colors = useColors();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, { paddingTop: insets.top + Spacing.sm }]}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/account'))}
          style={({ pressed }) => [styles.back, pressed && { backgroundColor: Colors.control }]}>
          <Ionicons name="chevron-back" size={22} color={Colors.text} />
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">
          Connect an agent
        </Text>
      </View>
      {convexConfigured && mcpUrl ? (
        <ConnectAgent mcpUrl={mcpUrl} bottomInset={insets.bottom} />
      ) : (
        <Text style={[styles.muted, styles.offline]}>Agents can connect once the app points at the Cart backend.</Text>
      )}
    </View>
  );
}

function ConnectAgent({ mcpUrl, bottomInset }: { mcpUrl: string; bottomInset: number }) {
  const Colors = useColors();
  const styles = useThemedStyles(createStyles);
  const signedIn = useSession() === 'signed_in';
  const connections = useQuery(api.agentConnections.list, signedIn ? {} : 'skip');
  const create = useMutation(api.agentConnections.create);
  const revoke = useMutation(api.agentConnections.revoke);
  const [label, setLabel] = useState('Muse');
  const [token, setToken] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createToken = async () => {
    setCreating(true);
    setError(null);
    try {
      setToken((await create({ label: label.trim() || 'Agent' })).token);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.content, { paddingBottom: Spacing.xxl + bottomInset }]}>
      <Text style={styles.intro}>
        Give an AI agent such as Muse access to your cart over MCP. It can add items and ask for purchases; you approve every
        order here.
      </Text>

      <PairingCode signedIn={signedIn} />

      <View style={styles.card}>
        <Text style={styles.label}>MCP server URL</Text>
        <Text style={styles.mono} selectable testID="mcp-url">
          {mcpUrl}
        </Text>
        <CopyButton value={mcpUrl} />
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Bearer token, for agents that only accept a key</Text>
        <Text style={styles.label}>Agent name</Text>
        <TextInput
          value={label}
          onChangeText={setLabel}
          placeholder="Muse"
          placeholderTextColor={Colors.textTertiary}
          autoCorrect={false}
          returnKeyType="done"
          style={styles.input}
        />
        {token ? (
          <View style={styles.token}>
            <Text style={styles.label}>Bearer token</Text>
            <Text style={styles.mono} selectable testID="agent-token">
              {token}
            </Text>
            <CopyButton value={token} />
            <Text style={styles.note}>Shown once. Paste it into your agent&apos;s bearer token setting now.</Text>
          </View>
        ) : (
          <PillButton
            variant="accent"
            label={creating ? 'Creating…' : 'Create token'}
            disabled={creating || !signedIn}
            onPress={createToken}
          />
        )}
        {error && <Text style={styles.note}>{error}</Text>}
      </View>

      {connections && connections.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Connected agents</Text>
          {connections.map((connection) => (
            <View key={connection.id} style={styles.connection}>
              <View style={styles.connectionText}>
                <Text style={styles.connectionLabel}>{connection.label}</Text>
                <Text style={styles.muted}>Created {formatShortDate(connection.createdAt)}</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Revoke ${connection.label}`}
                hitSlop={8}
                onPress={() => revoke({ tokenId: connection.id }).catch((e: unknown) => setError(errorMessage(e)))}>
                {({ pressed }) => <Text style={[styles.revoke, pressed && { color: Colors.text }]}>Revoke</Text>}
              </Pressable>
            </View>
          ))}
        </View>
      )}

    </ScrollView>
  );
}

const PAIRING_CODE_LIFETIME_MS = 10 * 60 * 1000 - 5000;
const monospace = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, monospace' });

function PairingCode({ signedIn }: { signedIn: boolean }) {
  const Colors = useColors();
  const styles = useThemedStyles(createStyles);
  const createPairingCode = useMutation(api.agentConnections.createPairingCode);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);

  const request = useCallback(async () => {
    setRequesting(true);
    setError(null);
    try {
      const { code } = await createPairingCode({});
      const receivedAt = Date.now();
      setNow(receivedAt);
      setPairing({ code, expiresAt: receivedAt + PAIRING_CODE_LIFETIME_MS });
    } catch (e) {
      setPairing(null);
      setError(errorMessage(e));
    } finally {
      setRequesting(false);
    }
  }, [createPairingCode]);

  useEffect(() => {
    if (!pairing) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const regenerate = setTimeout(request, Math.max(0, pairing.expiresAt - Date.now()));
    return () => {
      clearInterval(tick);
      clearTimeout(regenerate);
    };
  }, [pairing, request]);

  const remaining = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0;

  return (
    <View style={styles.card}>
      <Text style={styles.label}>Pairing code</Text>
      {pairing ? (
        <>
          <Text style={styles.code} selectable testID="pairing-code" accessibilityLabel={pairing.code.split('').join(' ')}>
            {pairing.code}
          </Text>
          <Text style={styles.note}>Enter this code when Muse asks to connect to Cart</Text>
          <View style={styles.codeFooter}>
            <CopyButton value={pairing.code} />
            <View style={styles.codeStatus}>
              <Text style={styles.muted}>
                {requesting
                  ? 'Getting a new code…'
                  : `Expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`}
              </Text>
              <Pressable accessibilityRole="button" hitSlop={8} disabled={requesting} onPress={request}>
                {({ pressed }) => <Text style={[styles.newCode, pressed && { color: Colors.text }]}>New code</Text>}
              </Pressable>
            </View>
          </View>
        </>
      ) : (
        <PillButton
          variant="accent"
          label={requesting ? 'Getting code…' : 'Get pairing code'}
          disabled={requesting || !signedIn}
          onPress={request}
        />
      )}
      {error && <Text style={styles.note}>{error}</Text>}
    </View>
  );
}

function CopyButton({ value }: { value: string }) {
  const styles = useThemedStyles(createStyles);
  const [copied, setCopied] = useState(false);
  return (
    <PillButton
      size="small"
      icon={copied ? 'checkmark' : 'copy-outline'}
      label={copied ? 'Copied' : 'Copy'}
      style={styles.copy}
      onPress={async () => {
        await Clipboard.setStringAsync(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    />
  );
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md },
  back: {
    width: 40,
    height: 40,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { ...Type.title, color: Colors.text },
  content: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.md },
  intro: { ...Type.body, color: Colors.textSecondary, marginBottom: Spacing.sm },
  offline: { paddingHorizontal: Spacing.lg },
  card: { backgroundColor: Colors.surface, borderRadius: Radius.card, padding: Spacing.lg, gap: Spacing.md },
  label: { ...Type.secondary, color: Colors.textSecondary },
  mono: { fontFamily: 'Menlo', fontSize: 14, lineHeight: 20, color: Colors.text },
  copy: { alignSelf: 'flex-start' },
  code: { fontFamily: monospace, fontSize: 34, lineHeight: 42, fontWeight: '600', letterSpacing: 6, color: Colors.text },
  codeFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  codeStatus: { alignItems: 'flex-end', gap: 2 },
  newCode: { ...Type.secondary, fontWeight: '600', color: Colors.accent },
  input: {
    ...Type.body,
    fontSize: 16,
    color: Colors.text,
    height: 44,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.pill,
    backgroundColor: Colors.control,
  },
  token: { gap: Spacing.md },
  note: { ...Type.secondary, color: Colors.textSecondary },
  muted: { ...Type.secondary, color: Colors.textSecondary },
  section: { gap: Spacing.md, marginTop: Spacing.md },
  sectionTitle: { ...Type.headline, color: Colors.text, paddingHorizontal: Spacing.xs },
  connection: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  connectionText: { flex: 1, gap: 2 },
  connectionLabel: { ...Type.body, fontWeight: '600', color: Colors.text },
  revoke: { ...Type.body, color: Colors.textSecondary },
});
