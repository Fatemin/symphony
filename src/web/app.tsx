import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Projects } from './pages/Projects';
import { Board } from './pages/Board';
import { ProjectAgent } from './pages/ProjectAgent';
import { IssueDetail } from './pages/IssueDetail';
import { Ops } from './pages/Ops';
import { Settings } from './pages/Settings';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Projects />} />
          <Route path="/projects/:id" element={<Board />} />
          <Route path="/projects/:id/agent" element={<ProjectAgent />} />
          <Route path="/issues/:id" element={<IssueDetail />} />
          <Route path="/ops" element={<Ops />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
