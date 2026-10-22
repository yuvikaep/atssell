import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { ApiError } from '../api';
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
export function AppErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  // The server's own explanation (missing settings, database not set up) helps whoever has to fix it.
  const details = error instanceof ApiError && Array.isArray(error.details) ? error.details.filter((d): d is string => typeof d === 'string') : [];
  return (
    <AuthLayout title="Can't reach RMS right now">
      <p>Check your connection and try again. If this keeps happening, contact support.</p>
      <div className="alert alert-error">
        {error instanceof ApiError ? `${error.code}: ${error.message}` : error instanceof Error && error.message ? error.message : 'Unknown error'}
        {details.length > 0 && <ul>{details.map((d) => <li key={d}>{d}</li>)}</ul>}
      </div>
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
