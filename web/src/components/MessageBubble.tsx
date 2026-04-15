import type { ReactNode } from "react";

interface Props {
  role: "user" | "assistant" | "tool" | "system";
  children: ReactNode;
  timestamp?: number;
  /** Agent name — when set, the bubble shows @name instead of "assistant". */
  author?: string | null;
}

export default function MessageBubble({ role, children, timestamp, author }: Props) {
  const label = role === "assistant" && author ? `@${author}` : role;
  const agentClass = role === "assistant" && author ? " bubble--agent" : "";
  return (
    <div className={`bubble bubble--${role}${agentClass}`}>
      <div className="bubble__role">{label}</div>
      <div className="bubble__body">{children}</div>
      {timestamp != null && (
        <div className="bubble__ts">{new Date(timestamp).toLocaleString()}</div>
      )}
    </div>
  );
}
