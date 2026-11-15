import { useAction, useMutation } from "convex/react";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { api } from "../../convex/_generated/api";
import { Button, Card, Field, Thumb } from "@/components/ui";
import { useSession } from "@/lib/session";
import { colors } from "@/lib/theme";

const toCents = (s: string) => {
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
};

export default function AddScreen() {
  const { deviceId } = useSession();
  const preview = useAction(api.items.preview);
  const add = useMutation(api.items.add);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [wasPrice, setWasPrice] = useState("");
  const [imageUrl, setImageUrl] = useState<string | undefined>();
  const [note, setNote] = useState("");
  const [cooling, setCooling] = useState<number | undefined>(24);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState<string | null>(null);

  const fetchDetails = async () => {
    if (!/^https?:\/\//.test(url.trim())) return;
    setLoading(true);
    try {
      const p = await preview({ url: url.trim() });
      if (p.title) setTitle(p.title);
      if (p.price !== undefined) setPrice((p.price / 100).toFixed(2));
      setImageUrl(p.imageUrl);
      setFetched(p.title || p.imageUrl || p.price ? "Filled in what we found. Edit anything." : "Couldn't read that page. Fill it in below.");
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    await add({
      deviceId,
      title: title.trim(),
      url: url.trim() || undefined,
      imageUrl,
      price: toCents(price),
      wasPrice: toCents(wasPrice),
      coolingOffHours: cooling,
      note: note.trim() || undefined,
    });
    router.back();
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        <Card style={{ gap: 10 }}>
          <Field
            label="Product link"
            placeholder="https://www.target.com/p/…"
            value={url}
            onChangeText={setUrl}
            onBlur={fetchDetails}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Button title={loading ? "Reading page…" : "Fetch details"} variant="secondary" onPress={fetchDetails} disabled={loading || !url} />
          {loading ? <ActivityIndicator /> : fetched ? <Text style={{ color: colors.muted }}>{fetched}</Text> : null}
        </Card>

        <View style={{ flexDirection: "row", gap: 14, alignItems: "flex-end" }}>
          <Thumb uri={imageUrl} size={84} />
          <View style={{ flex: 1 }}>
            <Field label="Title" placeholder="What is it?" value={title} onChangeText={setTitle} />
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Field label="Price" placeholder="0.00" value={price} onChangeText={setPrice} keyboardType="decimal-pad" />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Was (optional)" placeholder="0.00" value={wasPrice} onChangeText={setWasPrice} keyboardType="decimal-pad" />
          </View>
        </View>
        <Field label="Why do you want it?" placeholder="Optional note to future you" value={note} onChangeText={setNote} multiline />

        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 13, fontWeight: "700", color: colors.muted, letterSpacing: 0.5 }}>COOLING-OFF TIMER</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {[undefined, 24, 72, 168].map((h) => (
              <Pressable
                key={String(h)}
                onPress={() => setCooling(h)}
                style={{
                  flex: 1,
                  paddingVertical: 12,
                  borderRadius: 14,
                  alignItems: "center",
                  backgroundColor: cooling === h ? colors.accent : colors.card,
                }}
              >
                <Text style={{ fontWeight: "700", color: cooling === h ? "#fff" : colors.text }}>
                  {h === undefined ? "Off" : h < 48 ? `${h}h` : h === 72 ? "3 days" : "1 week"}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <Button title="Add to cart" onPress={save} disabled={!title.trim()} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
