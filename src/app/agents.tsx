import { useMutation, useQuery } from "convex/react";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { api } from "../../convex/_generated/api";
import { Button, Card, Field, SectionTitle } from "@/components/ui";
import { useIsPro, useNow, useSession } from "@/lib/session";
import { ago, colors } from "@/lib/theme";

const FREE_AGENT_LIMIT = 2;
const siteUrl = process.env.EXPO_PUBLIC_CONVEX_SITE_URL ?? "https://<deployment>.convex.site";

export default function AgentsScreen() {
  const { deviceId } = useSession();
  const now = useNow();
  const isPro = useIsPro();
  const agents = useQuery(api.agents.list, { deviceId }) ?? [];
  const create = useMutation(api.agents.create);
  const revoke = useMutation(api.agents.revoke);
  const [name, setName] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const atLimit = !isPro && agents.length >= FREE_AGENT_LIMIT;

  const curl = `curl -X POST ${siteUrl}/api/items \\
  -H "Authorization: Bearer ${newKey ?? "<api key>"}" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://www.target.com/p/...","rationale":"Why you picked it"}'`;

  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 14, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
      <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 21 }}>
        Give your AI agent a key so it can add items to your cart. Every item it adds must say why, so you can decide with confidence.
      </Text>

      {agents.map((a) => (
        <Card key={a._id} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.agentSoft, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: colors.agent, fontSize: 18, fontWeight: "800" }}>✦</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: "800", color: colors.text, fontSize: 16 }}>{a.name}</Text>
            <Text style={{ color: colors.muted, fontSize: 13 }}>
              {a.keyPrefix}… · {a.lastUsedAt ? `last used ${ago(a.lastUsedAt, now)}` : "never used"}
            </Text>
          </View>
          <Pressable onPress={() => revoke({ deviceId, agentId: a._id })}>
            <Text style={{ color: colors.red, fontWeight: "700" }}>Revoke</Text>
          </Pressable>
        </Card>
      ))}

      {newKey ? (
        <Card style={{ gap: 10, backgroundColor: colors.agentSoft }}>
          <Text style={{ fontWeight: "800", color: colors.agent }}>New API key: copy it now, it won’t be shown again</Text>
          <Text selectable style={{ fontFamily: "Courier", fontSize: 13, color: colors.text }}>{newKey}</Text>
          <Button
            title={copied ? "Copied ✓" : "Copy key"}
            variant="secondary"
            onPress={async () => {
              await Clipboard.setStringAsync(newKey);
              setCopied(true);
            }}
          />
        </Card>
      ) : null}

      <SectionTitle>Connect an agent</SectionTitle>
      {atLimit ? (
        <Card style={{ gap: 10 }}>
          <Text style={{ fontWeight: "800", color: colors.text }}>Free plan includes {FREE_AGENT_LIMIT} agents</Text>
          <Button title="Upgrade to Pro" onPress={() => router.push("/paywall")} />
        </Card>
      ) : (
        <View style={{ gap: 10 }}>
          <Field label="Agent name" placeholder="e.g. Claude, ChatGPT, my OpenClaw" value={name} onChangeText={setName} />
          <Button
            title="Create API key"
            onPress={async () => {
              setNewKey(await create({ deviceId, name }));
              setCopied(false);
              setName("");
            }}
          />
        </View>
      )}

      <SectionTitle>API</SectionTitle>
      <Card style={{ backgroundColor: colors.text }}>
        <Text selectable style={{ fontFamily: "Courier", fontSize: 12, color: "#E8E8F0", lineHeight: 18 }}>{curl}</Text>
      </Card>
    </ScrollView>
  );
}
