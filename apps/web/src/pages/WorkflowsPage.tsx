import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { listWorkflows } from "../api";
import type { Run } from "../api";

function statusBadge(status: string) {
  return <span className={`badge ${status}`}>{status.replace("_", " ")}</span>;
}

export function WorkflowsPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["workflows"], queryFn: listWorkflows });

  if (isLoading) return <p className="muted">Loading workflows…</p>;
  if (error) return <p className="muted">Failed to reach the API — is `make dev` running?</p>;

  const runs: Run[] = data?.runs ?? [];

  return (
    <div>
      <h1>Workflows</h1>
      {runs.length === 0 ? (
        <p className="muted">
          No workflow runs yet. Start one from the CLI:{" "}
          <code>orchestra workflow start software-delivery</code>
        </p>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Definition</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <Link to={`/workflows/${run.id}`}>{run.definition}</Link>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {run.id}
                    </div>
                  </td>
                  <td>{statusBadge(run.status)}</td>
                  <td className="muted">{new Date(run.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
