import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, setUnauthorizedHandler, tokenStore, type Encoder, type Meta } from "./api";

type Theme = "system" | "light" | "dark";

interface AppCtx {
  token: string | null;
  meta: Meta | undefined;
  metaLoading: boolean;
  can: (perm: string) => boolean;
  signIn: (token: string) => void;
  signOut: () => Promise<void>;
  encoders: Encoder[];
  encoder: Encoder | null;
  encoderId: string | null;
  setEncoderId: (id: string | null) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const Ctx = createContext<AppCtx | null>(null);
const ENCODER_KEY = "d801.encoder";
const THEME_KEY = "d801.theme";

function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function AppProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(tokenStore.get());
  const [encoderId, setEncoderIdState] = useState<string | null>(localStorage.getItem(ENCODER_KEY));
  const [theme, setThemeState] = useState<Theme>((localStorage.getItem(THEME_KEY) as Theme) || "system");

  useEffect(() => {
    applyTheme(theme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = () => applyTheme(theme);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [theme]);

  const clearSession = useCallback(() => {
    tokenStore.clear();
    setToken(null);
    qc.clear();
  }, [qc]);

  useEffect(() => setUnauthorizedHandler(clearSession), [clearSession]);

  const metaQ = useQuery({
    queryKey: ["meta"],
    queryFn: () => api.get<Meta>("/v1/meta"),
    enabled: !!token,
    staleTime: 30_000,
  });

  const encodersQ = useQuery({
    queryKey: ["encoders"],
    queryFn: () => api.get<Encoder[]>("/v1/encoders"),
    enabled: !!token,
    refetchInterval: 5_000,
  });

  const encoders = useMemo(() => encodersQ.data ?? [], [encodersQ.data]);
  const encoder = encoders.find((e) => e.id === encoderId) ?? null;

  // Pick a sensible encoder automatically the first time (the only one, or the only online one).
  useEffect(() => {
    if (!encoders.length || encoder) return;
    const online = encoders.filter((e) => e.online && e.enabled);
    const pick = encoders.length === 1 ? encoders[0] : online.length === 1 ? online[0] : null;
    if (pick) {
      setEncoderIdState(pick.id);
      localStorage.setItem(ENCODER_KEY, pick.id);
    }
  }, [encoders, encoder]);

  const value: AppCtx = {
    token,
    meta: metaQ.data,
    metaLoading: metaQ.isLoading,
    can: (perm) => !!metaQ.data?.me.permissions.includes(perm),
    signIn: (t) => {
      tokenStore.set(t);
      setToken(t);
      qc.invalidateQueries();
    },
    signOut: async () => {
      try {
        await api.post("/v1/auth/logout");
      } catch {
        /* session may already be gone */
      }
      clearSession();
    },
    encoders,
    encoder,
    encoderId,
    setEncoderId: (id) => {
      setEncoderIdState(id);
      if (id) localStorage.setItem(ENCODER_KEY, id);
      else localStorage.removeItem(ENCODER_KEY);
    },
    theme,
    setTheme: (t) => {
      setThemeState(t);
      localStorage.setItem(THEME_KEY, t);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp outside AppProvider");
  return ctx;
}
