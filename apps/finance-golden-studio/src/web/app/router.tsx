import { Route, Routes } from "react-router-dom";
import { useApiClient } from "./context.js";
import { BatchDraftsPage, BatchListPage } from "./pages.js";

/**
 * Golden Studio 的路由表；Task 9/10 的编辑器与动作工作流将替换占位工作区。
 *
 * @returns 应用路由表。
 */
export function GoldenStudioRoutes() {
  return (
    <Routes>
      <Route element={<BatchListPage />} path="/" />
      <Route element={<BatchDraftsPage />} path="/batch/:batch" />
      <Route
        element={<PlaceholderPage label="Draft editor" />}
        path="/draft/:batch/:id"
      />
      <Route element={<PlaceholderPage label="Golden set" />} path="/golden" />
      <Route element={<PlaceholderPage label="Settings" />} path="/settings" />
      <Route element={<PlaceholderPage label="Not found" />} path="*" />
    </Routes>
  );
}

/**
 * 通用占位工作区，用于后续任务填充前保持导航可达。
 *
 * @param props 标题标签。
 * @returns 占位面板。
 */
function PlaceholderPage({ label }: { label: string }) {
  useApiClient();
  return (
    <section className="workspace">
      <h2 className="page-title">{label}</h2>
      <p className="empty-state">This workspace is not wired yet.</p>
    </section>
  );
}
