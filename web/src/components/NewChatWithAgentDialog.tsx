import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { fetchProjectAgents, type Agent } from "../api";
import { Bot } from "../lib/icons";
import Modal from "./Modal";

interface Props {
  open: boolean;
  project: string;
  defaultAgent: string;
  onPick: (agent: string) => void;
  onCancel: () => void;
}

/**
 * Modal picker for "New chat with…". On pick, the parent starts a fresh
 * session pre-bound to the chosen agent.
 */
export default function NewChatWithAgentDialog({
  open,
  project,
  defaultAgent,
  onPick,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setAgents(null);
    setError(null);
    fetchProjectAgents(project)
      .then((list) => {
        if (cancelled) return;
        setAgents(list);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, project]);

  if (!open) return null;

  const hasAgents = agents && agents.length > 0;
  const defaultMeta = agents?.find((a) => a.name === defaultAgent);

  return (
    <Modal onClose={onCancel}>
      <Modal.Header title={t("dialog.newChatWithAgent.title")} />
      <p style={{ margin: "0 0 14px", opacity: 0.7, fontSize: 13 }}>
        {t("dialog.newChatWithAgent.description")}
      </p>
      {error && (
        <div className="bubble__error">
          {t("tab.chat.errorLabel", { message: error })}
        </div>
      )}
      {!error && agents === null && (
        <div style={{ opacity: 0.6 }}>{t("dialog.newChatWithAgent.loading")}</div>
      )}
      {!error && agents !== null && !hasAgents && (
        <div style={{ opacity: 0.7 }}>
          <Trans
            i18nKey="dialog.newChatWithAgent.noAgents"
            values={{ project }}
            components={{ strong: <strong /> }}
          />
        </div>
      )}
      {hasAgents && (
        <ul
          className="new-chat-agent-list"
          role="listbox"
          aria-label={t("dialog.newChatWithAgent.agentsAria")}
        >
          <li role="presentation" style={{ listStyle: "none" }}>
            <button
              type="button"
              className="new-chat-agent-option"
              onClick={() => onPick(defaultAgent)}
            >
              <Bot size={16} />
              <span className="new-chat-agent-name">@{defaultAgent}</span>
              <span className="new-chat-agent-hint">
                {defaultMeta?.description || t("dialog.newChatWithAgent.defaultHint")}
              </span>
            </button>
          </li>
          {agents
            .filter((a) => a.name !== defaultAgent)
            .map((a) => (
              <li
                key={a.name}
                role="presentation"
                style={{ listStyle: "none" }}
              >
                <button
                  type="button"
                  className="new-chat-agent-option"
                  onClick={() => onPick(a.name)}
                >
                  <Bot size={16} />
                  <span className="new-chat-agent-name">@{a.name}</span>
                  {a.description && (
                    <span className="new-chat-agent-hint">{a.description}</span>
                  )}
                </button>
              </li>
            ))}
        </ul>
      )}
      <Modal.Footer>
        <button type="button" className="btn" onClick={onCancel}>
          {t("common.close")}
        </button>
      </Modal.Footer>
    </Modal>
  );
}
