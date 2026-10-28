import { Route, Routes } from "react-router-dom";
import { BatchesPage } from "../features/batches/BatchesPage.js";
import { DraftPage } from "../features/draft/DraftPage.js";
import { GoldenPage } from "../features/golden/GoldenPage.js";
import { SettingsPage } from "../features/settings/SettingsPage.js";
import { BatchDraftsPage } from "./pages.js";

/**
 * Golden Studio 的路由表；草稿详情由证据编辑器承接。
 *
 * @returns 应用路由表。
 */
export function GoldenStudioRoutes() {
  return (
    <Routes>
      <Route element={<BatchesPage />} path="/" />
      <Route element={<BatchDraftsPage />} path="/batch/:batch" />
      <Route element={<DraftPage />} path="/draft/:batch/:id" />
      <Route element={<GoldenPage />} path="/golden" />
      <Route element={<SettingsPage />} path="/settings" />
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
  return (
    <section className="workspace">
      <h2 className="page-title">{label}</h2>
      <p className="empty-state">This workspace is not wired yet.</p>
    </section>
  );
}
