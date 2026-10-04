import { useEffect, useState } from "react";
import type { AnalystSourceReview } from "../../../shared/analyst-research.js";
import type { AnalystResearchQueueItem } from "../lib/api.js";
import { getAnalystResearchQueue, updateAnalystSourceReview } from "../lib/api.js";
import { AnalystResearchQueueView, type QueueState } from "./AnalystResearchQueueView.js";

export function AnalystResearchQueue({
  refreshRevision,
  onReviewChanged,
  onOpenEvidence,
}: {
  refreshRevision: number;
  onReviewChanged: (review: AnalystSourceReview) => void;
  onOpenEvidence: (item: AnalystResearchQueueItem) => void;
}) {
  const [items, setItems] = useState<AnalystResearchQueueItem[]>([]);
  const [state, setState] = useState<QueueState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [dismissBusyId, setDismissBusyId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState("loading");
    setError(null);
    void getAnalystResearchQueue(controller.signal).then(
      (result) => {
        if (!active) return;
        setItems(result.items);
        setState("ready");
      },
      () => {
        if (!active || controller.signal.aborted) return;
        setError("The saved research queue could not be loaded.");
        setState("failed");
      },
    );
    return () => { active = false; controller.abort(); };
  }, [refreshRevision, revision]);

  const dismiss = async (item: AnalystResearchQueueItem) => {
    if (dismissBusyId != null) return;
    setDismissBusyId(item.observationId);
    setError(null);
    try {
      const review = await updateAnalystSourceReview(item.observationId, {
        disposition: "dismissed",
        nextQuestion: item.nextQuestion,
      });
      onReviewChanged(review);
      setRevision((current) => current + 1);
    } catch {
      setError("This item remains in your queue. The change did not save; retry when the desk is available.");
    } finally {
      setDismissBusyId(null);
    }
  };

  return <AnalystResearchQueueView
    items={items}
    state={state}
    error={error}
    dismissBusyId={dismissBusyId}
    onOpenEvidence={onOpenEvidence}
    onDismiss={(item) => void dismiss(item)}
    onRetry={() => setRevision((current) => current + 1)}
  />;
}
