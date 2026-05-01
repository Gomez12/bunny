interface QueueWaitBadgeProps {
  position: number;
  waitedTotalMs: number;
}

export default function QueueWaitBadge({
  position,
  waitedTotalMs,
}: QueueWaitBadgeProps) {
  return (
    <div
      className="bubble__pending bubble__pending--queued"
      title={
        waitedTotalMs > 0
          ? `Eerder gewacht: ${(waitedTotalMs / 1000).toFixed(1)}s`
          : undefined
      }
    >
      ⏸ In wachtrij (positie {position})
    </div>
  );
}
