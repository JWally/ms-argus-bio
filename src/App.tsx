import { lazy, Suspense } from 'react';

const CaptchaPage = lazy(() => import('./pages/CaptchaPage'));

export default function App() {
  return (
    <Suspense>
      <CaptchaPage />
    </Suspense>
  );
}
