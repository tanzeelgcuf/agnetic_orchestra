import { useQuery } from "@tanstack/react-query";
import { getAgents } from "../api";

export function AgentsPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["agents"], queryFn: getAgents });

  if (isLoading) return <p className="muted">Loading agents…</p>;
  if (error) return <p className="muted">Failed to reach the API.</p>;

  const agents = data?.agents ?? [];

  return (
    <div>
      <h1>Agents</h1>
      {agents.length === 0 ? (
        <p className="muted">No agents registered.</p>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Version</th>
                <th>Capabilities</th>
                <th>Permissions</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.id}>
                  <td>
                    <strong>{agent.name}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {agent.id}
                    </div>
                  </td>
                  <td className="muted">{agent.version}</td>
                  <td>{agent.capabilities.join(", ") || "—"}</td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {Object.entries(agent.permissions).length === 0
                      ? "none (least privilege)"
                      : Object.entries(agent.permissions)
                          .map(([resource, actions]) => `${resource}: ${actions.join(", ")}`)
                          .join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
