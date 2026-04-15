import { useEffect, useState } from "react";
import {
  fetchMessages,
  groupTurns,
  reorderReasoning,
  type AuthUser,
  type HistoryTurn,
  type StoredMessage,
} from "../api";
import MessageBubble from "../components/MessageBubble";
import ReasoningBlock from "../components/ReasoningBlock";
import ToolCallCard from "../components/ToolCallCard";
import SessionSidebar from "../components/SessionSidebar";
import StatsFooter from "../components/StatsFooter";

interface Props {
  currentUser: AuthUser;
  /** Restrict the session list to a single project. */
  project?: string;
}

interface TurnWithOwner extends HistoryTurn {
  owner: { username: string | null; displayName: string | null } | null;
}

export default function MessagesTab({ currentUser, project }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [turns, setTurns] = useState<TurnWithOwner[]>([]);
  const [loading, setLoading] = useState(false);
  const isAdmin = currentUser.role === "admin";

  useEffect(() => {
    if (!activeId) {
      setTurns([]);
      return;
    }
    setLoading(true);
    fetchMessages(activeId)
      .then((msgs) => setTurns(groupTurnsWithOwner(reorderReasoning(msgs))))
      .catch((e) => console.error(e))
      .finally(() => setLoading(false));
  }, [activeId]);

  return (
    <div className="messages">
      <SessionSidebar
        activeId={activeId}
        onPick={setActiveId}
        onNew={() => setActiveId(null)}
        scope={isAdmin ? "all" : "mine"}
        showOwner={isAdmin}
        project={project}
      />
      <section className="messages__transcript">
        {loading && <div className="messages__loading">Loading…</div>}
        {!loading && !activeId && (
          <div className="messages__empty">Select a session on the left.</div>
        )}
        {!loading && activeId && turns.length === 0 && (
          <div className="messages__empty">Session has no messages yet.</div>
        )}
        {turns.map((t) => (
          <div key={t.id} className="turn">
            {isAdmin && t.owner && (
              <div className="turn__owner">
                {t.owner.displayName || t.owner.username || "anonymous"}
              </div>
            )}
            <MessageBubble role="user">{t.prompt}</MessageBubble>
            <MessageBubble role="assistant">
              {t.reasoning && (
                <ReasoningBlock text={t.reasoning} defaultOpen={currentUser.expandThinkBubbles} />
              )}
              {t.toolCalls.map((tc) => (
                <ToolCallCard
                  key={tc.id}
                  name={tc.name}
                  args={tc.args}
                  ok={tc.ok}
                  output={tc.output}
                  defaultOpen={currentUser.expandToolBubbles}
                />
              ))}
              {t.content && <div className="bubble__content">{t.content}</div>}
              <StatsFooter stats={t.stats} />
            </MessageBubble>
          </div>
        ))}
      </section>
    </div>
  );
}

/** Extend `groupTurns` with the owner captured from each user message. */
function groupTurnsWithOwner(messages: StoredMessage[]): TurnWithOwner[] {
  const turns = groupTurns(messages) as TurnWithOwner[];
  // Build a sessionless lookup: for each user message, find the matching turn
  // and attach its owner info.
  let turnIdx = 0;
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (turnIdx >= turns.length) break;
    turns[turnIdx]!.owner =
      m.userId || m.username || m.displayName
        ? { username: m.username, displayName: m.displayName }
        : null;
    turnIdx++;
  }
  return turns;
}
