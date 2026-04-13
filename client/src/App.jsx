import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Groups from './pages/Groups.jsx';
import GroupDetail from './pages/GroupDetail.jsx';
import AlertHistory from './pages/AlertHistory.jsx';
import Settings from './pages/Settings.jsx';

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/"               element={<Dashboard />} />
        <Route path="/groups"         element={<Groups />} />
        <Route path="/groups/:id"     element={<GroupDetail />} />
        <Route path="/alerts"         element={<AlertHistory />} />
        <Route path="/settings"       element={<Settings />} />
        <Route path="*"               element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
