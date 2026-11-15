import AsyncStorage from "@react-native-async-storage/async-storage";
import { ConvexProvider, ConvexReactClient, useMutation, useQuery } from "convex/react";
import { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { api } from "../../convex/_generated/api";

const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL;
const convex = convexUrl ? new ConvexReactClient(convexUrl, { unsavedChangesWarning: false }) : null;

type Session = { deviceId: string; voterId: string; voterName: string; setVoterName: (n: string) => void };
const SessionContext = createContext<Session | null>(null);

function randomId() {
  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join("");
}

function SessionBootstrap({ children }: { children: ReactNode }) {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [voterId, setVoterId] = useState("");
  const [voterName, setVoterNameState] = useState("");
  const ensure = useMutation(api.users.ensure);

  useEffect(() => {
    (async () => {
      let id = await AsyncStorage.getItem("deviceId");
      if (!id) {
        id = randomId();
        await AsyncStorage.setItem("deviceId", id);
      }
      let vid = await AsyncStorage.getItem("voterId");
      if (!vid) {
        vid = randomId();
        await AsyncStorage.setItem("voterId", vid);
      }
      setVoterId(vid);
      setVoterNameState((await AsyncStorage.getItem("voterName")) ?? "");
      await ensure({ deviceId: id });
      setDeviceId(id);
    })();
  }, [ensure]);

  if (!deviceId) return null;
  const setVoterName = (n: string) => {
    setVoterNameState(n);
    AsyncStorage.setItem("voterName", n);
  };
  return <SessionContext.Provider value={{ deviceId, voterId, voterName, setVoterName }}>{children}</SessionContext.Provider>;
}

export function AppProviders({ children }: { children: ReactNode }) {
  if (!convex)
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
        <Text style={{ fontSize: 16, textAlign: "center" }}>
          EXPO_PUBLIC_CONVEX_URL was not set when this app was built. Run npx convex dev, then rebuild.
        </Text>
      </View>
    );
  return (
    <ConvexProvider client={convex}>
      <SessionBootstrap>{children}</SessionBootstrap>
    </ConvexProvider>
  );
}

export function useSession() {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside provider");
  return s;
}

export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / intervalMs) * intervalMs);
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / intervalMs) * intervalMs), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useIsPro() {
  const { deviceId } = useSession();
  return useQuery(api.users.me, { deviceId })?.isPro ?? false;
}
