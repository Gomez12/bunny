import { useTranslation } from "react-i18next";

interface QueueWaitBadgeProps {
  position: number;
  waitedTotalMs: number;
}

export default function QueueWaitBadge({
  position,
  waitedTotalMs,
}: QueueWaitBadgeProps) {
  const { t } = useTranslation();
  return (
    <div
      className="bubble__pending bubble__pending--queued"
      title={
        waitedTotalMs > 0
          ? t("chat.queue.waitedBefore", {
              seconds: (waitedTotalMs / 1000).toFixed(1),
            })
          : undefined
      }
    >
      {t("chat.queue.position", { position })}
    </div>
  );
}
