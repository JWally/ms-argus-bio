import { Routes, Route } from 'react-router-dom';
import CaptchaPage from './pages/CaptchaPage';
import TicTacToePage from './pages/TicTacToePage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<CaptchaPage />} />
      <Route path="/t3" element={<TicTacToePage />} />
    </Routes>
  );
}
