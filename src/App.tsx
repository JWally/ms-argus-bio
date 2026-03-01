import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';

const CaptchaPage = lazy(() => import('./pages/CaptchaPage'));
const TicTacToePage = lazy(() => import('./pages/TicTacToePage'));

export default function App() {
  return (
    <Suspense>
      <Routes>
        <Route path="/" element={<CaptchaPage />} />
        <Route path="/t3" element={<TicTacToePage />} />
      </Routes>
    </Suspense>
  );
}
