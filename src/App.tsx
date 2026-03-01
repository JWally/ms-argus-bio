import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';

const CaptchaPage = lazy(() => import('./pages/CaptchaPage'));

export default function App() {
  return (
    <Suspense>
      <Routes>
        <Route path="/" element={<CaptchaPage />} />
      </Routes>
    </Suspense>
  );
}
