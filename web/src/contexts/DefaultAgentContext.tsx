import { createContext, useContext, type ReactNode } from "react";

/**
 * Name of the configured default agent (as returned by `/api/auth/me`).
 * Used to label legacy NULL-author assistant rows and to seed the Composer
 * agent picker for new sessions.
 */
const DefaultAgentContext = createContext<string>("bunny");

export function DefaultAgentProvider({
  value,
  children,
}: {
  value: string;
  children: ReactNode;
}) {
  return (
    <DefaultAgentContext.Provider value={value}>
      {children}
    </DefaultAgentContext.Provider>
  );
}

export function useDefaultAgent(): string {
  return useContext(DefaultAgentContext);
}
