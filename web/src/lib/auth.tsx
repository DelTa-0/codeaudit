import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getToken, setToken, type Org } from "./api";

interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

interface AuthState {
  user: AuthUser | null;
  orgs: Org[];
  loading: boolean;
  login: (token: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    if (!getToken()) {
      setUser(null);
      setOrgs([]);
      setLoading(false);
      return;
    }
    try {
      const data = await api<{ user: AuthUser; orgs: Org[] }>("/api/auth/me");
      setUser(data.user);
      setOrgs(data.orgs);
    } catch {
      setUser(null);
      setOrgs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const login = async (token: string) => {
    setToken(token);
    setLoading(true);
    await refresh();
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    setOrgs([]);
  };

  return (
    <AuthContext.Provider value={{ user, orgs, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
