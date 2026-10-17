import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { AuthLayout } from './AuthLayout';

export function NotFoundPage() {
  return (
    <AuthLayout title="Page not found">
      <p>The page you're looking for doesn't exist.</p>
      <div className="auth-footer"><Link to="/">Go to dashboard</Link></div>
    </AuthLayout>
  );
}

/** Shown when a page fails to load, e.g. the API is unreachable. */
export function AppErrorPage({ reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <AuthLayout title="Can't reach JobsMato right now">
      <p>Check your connection and try again. If this keeps happening, contact support.</p>
      <button
        className="btn btn-primary btn-block"
        onClick={() => {
          reset();
          void router.invalidate();
        }}
      >
        Try again
      </button>
    </AuthLayout>
  );
}
