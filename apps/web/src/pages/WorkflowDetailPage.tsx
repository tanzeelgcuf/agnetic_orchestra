import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cancelWorkflow, decideApproval, getEvents, getWorkflow } from "../api";
import type { StageRun } from "../api";

const MARKS: Record<string, string> = {
  succeeded: "✓",
  failed: "✗",
  blocked: "✗",
  running: "▶",
  awaiting_approval: "●",
  pending: "○",
  skipped: "–"
};

export function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ["workflow", id],
    queryFn: () => getWorkflow(id ?? ""),
    enabled: Boolean(id)
  });
  const events = useQuery({
    queryKey: ["events", id],
    queryFn: () => getEvents(id ?? ""),
    enabled: Boolean(id)
  });

  const decide = useMutation({
    mutationFn: (args: { stageId: string; decision: "approved" | "rejected" }) =>
      decideApproval(id ?? "", { ...args, approvedBy: "dashboard" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workflow", id] });
      void queryClient.invalidateQueries({ queryKey: ["events", id] });
    }
  });

  const cancel = useMutation({
    mutationFn: () => cancelWorkflow(id ?? ""),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["workflow", id] })
  });

  if (detail.isLoading) return <p className="muted">Loading…</p>;
  if (detail.error || !detail.data)
    return <p className="muted">Workflow not found. Back to <Link to="/">workflows</Link>.</p>;

  const { run, stages, approvals } = detail.data;
  const pendingStage = approvals.find((a) => a.decision === "pending")?.stageId;
  const terminal = ["succeeded", "failed", "blocked", "cancelled"].includes(run.status);

  return (
    <div>
      <h1>
        {run.definition}{" "}
        <span className={`badge ${run.status}`}>{run.status.replace("_", " ")}</span>
      </h1>
      <p className="muted">
        Run <code>{run.id}</code> · created {new Date(run.createdAt).toLocaleString()}
      </p>

      <div className="card">
        <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>Stage timeline</h2>
        <ul className="timeline">
          {stages.length === 0 && <li className="muted">No stages started yet.</li>}
          {stages.map((stage: StageRun) => (
            <li key={stage.id}>
              <span className="mark" style={{ color: `var(--${stage.status.replace("blocked", "failed")})` }}>
                {MARKS[stage.status] ?? "○"}
              </span>
              <span className="stage-id">{stage.stageId}</span>
              <span className="agent">
                {stage.agent} · {stage.status.replace("_", " ")}
                {stage.attempts > 1 ? ` · attempt ${stage.attempts}` : ""}
                {stage.error ? ` · ${stage.error}` : ""}
              </span>
            </li>
          ))}
        </ul>
        <div className="actions">
          {pendingStage && !terminal && (
            <>
              <button
                className="primary"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ stageId: pendingStage, decision: "approved" })}
              >
                Approve {pendingStage}
              </button>
              <button
                className="danger"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ stageId: pendingStage, decision: "rejected" })}
              >
                Reject
              </button>
            </>
          )}
          {!terminal && (
            <button className="danger" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel run
            </button>
          )}
        </div>
        {decide.error && <p className="muted">Approval failed: {(decide.error as Error).message}</p>}
      </div>

      <div className="card">
        <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>Event log</h2>
        <div className="events">
          {(events.data?.events ?? []).length === 0 && <p className="muted">No events.</p>}
          {(events.data?.events ?? []).map((event, i) => (
            <div key={i}>
              <span className="time">{new Date(event.createdAt).toLocaleTimeString()}</span>
              {event.type}
              {event.stageId ? ` [${event.stageId}]` : ""}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
