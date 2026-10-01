import { NavLink, Route, Routes } from "react-router-dom";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import { WorkflowDetailPage } from "./pages/WorkflowDetailPage";
import { AgentsPage } from "./pages/AgentsPage";

export function App() {
  return (
    <div className="layout">
      <header className="header">
        <span className="brand">Orchestra</span>
        <nav>
          <NavLink to="/" end>
            Workflows
          </NavLink>
          <NavLink to="/agents">Agents</NavLink>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<WorkflowsPage />} />
        <Route path="/workflows/:id" element={<WorkflowDetailPage />} />
        <Route path="/agents" element={<AgentsPage />} />
      </Routes>
    </div>
  );
}
