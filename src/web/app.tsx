import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Projects } from './pages/Projects';
import { Board } from './pages/Board';
import { ProjectAgent } from './pages/ProjectAgent';
import { ProjectSkills } from './pages/ProjectSkills';
import { Review } from './pages/Review';
import { StoryTree } from './pages/StoryTree';
import { Documentation } from './pages/Documentation';
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
          <Route path="/projects/:id/review" element={<Review />} />
          <Route path="/projects/:id/story-tree" element={<StoryTree />} />
          <Route path="/projects/:id/docs" element={<Documentation />} />
          <Route path="/projects/:id/skills" element={<ProjectSkills />} />
          <Route path="/issues/:id" element={<IssueDetail />} />
          <Route path="/ops" element={<Ops />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
