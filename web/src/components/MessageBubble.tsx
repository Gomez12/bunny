import type { ReactNode } from "react";

interface Props {
  role: "user" | "assistant" | "tool" | "system";
  children: ReactNode;
  timestamp?: number;
}

export default function MessageBubble({ role, children, timestamp }: Props) {
  return (
    <div className={`bubble bubble--${role}`}>
      <div className="bubble__role">{role}</div>
      <div className="bubble__body">{children}</div>
      {timestamp != null && (
        <div className="bubble__ts">{new Date(timestamp).toLocaleString()}</div>
      )}
    </div>
  );
}
