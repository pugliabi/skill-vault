import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { NotionRunJob } from "./types";

/**
 * Polls a Notion run/force job (`GET /api/notion/run/:id`) at the same 700ms
 * cadence NotionReview uses, until it finishes or is lost (e.g. a 404 after
 * a server restart). Shared by NotionReview (run) and the toolbar/bulk-bar
 * force-push flows so the polling + "lost track" handling lives in one
 * place instead of being copy-pasted per caller.
 *
 * `onSettled` fires exactly once per job, when it stops running (including
 * when it's lost) — a good place to toast a summary and invalidate queries.
 */
export function useNotionRunJob(onSettled?: (job: NotionRunJob | null, lost: boolean) => void) {
  const [jobId, setJobId] = useState<string | null>(null);

  const { data: job, error: jobError } = useQuery({
    queryKey: ["notion-run-job", jobId],
    queryFn: () => api.notionRunJob(jobId!),
    enabled: !!jobId,
    retry: 1,
    refetchInterval: (q) =>
      q.state.error || (q.state.data as NotionRunJob | undefined)?.running === false ? false : 700,
  });

  const lost = !!jobId && !!jobError && (!job || job.running);
  const running = !!jobId && !lost && (!job || job.running);

  const settledRef = useRef<string | null>(null);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  useEffect(() => {
    if (!jobId || settledRef.current === jobId) return;
    if (!lost && (!job || job.running)) return;
    settledRef.current = jobId;
    onSettledRef.current?.(job ?? null, lost);
  }, [job, jobId, lost]);

  /** Start (or replace) the job being polled. */
  const start = (id: string) => {
    settledRef.current = null;
    setJobId(id);
  };

  /** Stop polling and forget the job (e.g. when the caller reloads its plan). */
  const reset = () => {
    settledRef.current = null;
    setJobId(null);
  };

  return { jobId, start, reset, job, running, lost };
}
