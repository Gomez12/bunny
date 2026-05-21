import { memo, useState } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  text: string;
  defaultOpen?: boolean;
}

function ReasoningBlockImpl({ text, defaultOpen = false }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  if (!text.trim()) return null;
  return (
    <div className={`reasoning ${open ? "reasoning--open" : ""}`}>
      <button className="reasoning__toggle" onClick={() => setOpen((o) => !o)}>
        <span className="reasoning__caret">{open ? "▾" : "▸"}</span> {t("chat.reasoning.thinking")}
      </button>
      {open && <pre className="reasoning__body">{text}</pre>}
    </div>
  );
}

const ReasoningBlock = memo(ReasoningBlockImpl);
export default ReasoningBlock;
